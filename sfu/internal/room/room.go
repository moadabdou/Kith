package room

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/bus"
	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/moadabdou/Kith/sfu/internal/router"
	"github.com/pion/webrtc/v4"
)

var (
	ErrRoomClosed   = errors.New("room is closed")
	ErrPeerNotFound = errors.New("peer not found in room")
)

// Event represents a signaling/room notification event sent to peers.
type Event struct {
	Type      string   `json:"type"`
	UserID    string   `json:"user_id,omitempty"`
	ChannelID string   `json:"channel_id,omitempty"`
	Speaking  *bool    `json:"speaking,omitempty"`
	Video     *bool    `json:"video,omitempty"`
	Peers     []string `json:"peers,omitempty"`
	SDP       string   `json:"sdp,omitempty"`
}

// BroadcastSender is a function that delivers a typed Event to a specific peer.
type BroadcastSender func(targetUserID string, event Event)

// Room manages a voice channel room actor.
type Room struct {
	ID               string
	peers            map[string]*peer.Peer
	senders          map[string]BroadcastSender
	router           *router.Router
	publisher        bus.Publisher
	inbox            chan roomMsg
	ctx              context.Context
	cancel           context.CancelFunc
	onEmpty          func(roomID string)
	closeOnce        sync.Once
	disconnectTimers map[string]*time.Timer
}

type roomMsg interface {
	isRoomMsg()
}

type joinMsg struct {
	p       *peer.Peer
	sender  BroadcastSender
	replyTo chan error
}

func (joinMsg) isRoomMsg() {}

type leaveMsg struct {
	userID  string
	peer    *peer.Peer
	replyTo chan error
}

func (leaveMsg) isRoomMsg() {}

type disconnectMsg struct {
	userID      string
	peer        *peer.Peer
	gracePeriod time.Duration
	replyTo     chan error
}

func (disconnectMsg) isRoomMsg() {}

type expireDisconnectMsg struct {
	userID string
	peer   *peer.Peer
}

func (expireDisconnectMsg) isRoomMsg() {}

type peersMsg struct {
	replyTo chan []string
}

func (peersMsg) isRoomMsg() {}

type broadcastMsg struct {
	sourceUserID string
	event        Event
}

func (broadcastMsg) isRoomMsg() {}

// NewRoom creates and launches a new Room actor.
func NewRoom(id string, publisher bus.Publisher, onEmpty func(roomID string)) *Room {
	ctx, cancel := context.WithCancel(context.Background())
	if publisher == nil {
		publisher = &bus.NoopPublisher{}
	}

	r := &Room{
		ID:               id,
		peers:            make(map[string]*peer.Peer),
		senders:          make(map[string]BroadcastSender),
		router:           router.NewRouter(id),
		publisher:        publisher,
		inbox:            make(chan roomMsg, 64),
		ctx:              ctx,
		cancel:           cancel,
		onEmpty:          onEmpty,
		disconnectTimers: make(map[string]*time.Timer),
	}

	metrics.ActiveRooms.Inc()
	go r.loop()
	return r
}

func (r *Room) loop() {
	defer func() {
		metrics.ActiveRooms.Dec()
		slog.Info("Room actor stopped", "room_id", r.ID)
	}()

	for {
		select {
		case <-r.ctx.Done():
			r.drainAndClose()
			return

		case msg := <-r.inbox:
			switch m := msg.(type) {
			case joinMsg:
				r.handleJoin(m)
			case leaveMsg:
				r.handleLeave(m)
			case disconnectMsg:
				r.handleDisconnect(m)
			case expireDisconnectMsg:
				r.handleExpireDisconnect(m)
			case peersMsg:
				r.handleGetPeers(m)
			case broadcastMsg:
				r.handleBroadcast(m)
			}
		}
	}
}

// Router returns the room's RTP router.
func (r *Room) Router() *router.Router {
	return r.router
}

func (r *Room) broadcastExcept(excludeUID string, ev Event) {
	for uid, sender := range r.senders {
		if uid != excludeUID && sender != nil {
			sender(uid, ev)
		}
	}
}

func (r *Room) handleJoin(m joinMsg) {
	uid := m.p.UserID

	// Cancel any pending disconnect timer for this user
	if timer, exists := r.disconnectTimers[uid]; exists {
		timer.Stop()
		delete(r.disconnectTimers, uid)
		slog.Info("Peer reconnected within grace period", "user_id", uid, "room_id", r.ID)
	}

	// If existing peer with same user_id is already in room, cleanly close it first
	if existing, ok := r.peers[uid]; ok {
		slog.Warn("Replacing existing peer connection for user", "user_id", uid, "room_id", r.ID)
		existing.SetOnClose(nil)
		r.router.RemovePeer(uid)
		_ = existing.Close()
		metrics.ConnectedPeers.Dec()
	}

	r.peers[uid] = m.p
	if m.sender != nil {
		r.senders[uid] = m.sender
	}
	metrics.ConnectedPeers.Inc()

	// Register peer with router and configure renegotiation callback
	r.router.AddPeer(m.p, func(offer webrtc.SessionDescription) {
		if sender, ok := r.senders[uid]; ok && sender != nil {
			sender(uid, Event{
				Type:      "offer",
				ChannelID: r.ID,
				UserID:    uid,
				SDP:       offer.SDP,
			})
		}
	})

	// Setup OnTrack to register incoming track with router
	m.p.SetOnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		slog.Info("Remote audio track received from peer, registering with router", "user_id", uid, "room_id", r.ID)
		r.router.AddPublisher(uid, track, receiver)
	})

	// Clean up room when peer connection fails or closes asynchronously
	targetPeer := m.p
	m.p.SetOnClose(func() {
		go func() {
			_ = r.DisconnectPeer(targetPeer, 10*time.Second)
		}()
	})

	// Notify other peers in room
	r.broadcastExcept(uid, Event{
		Type:      "peer_joined",
		UserID:    uid,
		ChannelID: r.ID,
	})

	// Publish voice.peer_joined to event bus
	if r.publisher != nil && m.p.GuildID != "" {
		go func(gid, cid, user, sid string) {
			err := r.publisher.Publish(context.Background(), bus.Event{
				Type:    "voice.peer_joined",
				Version: 1,
				GuildID: gid,
				Payload: map[string]any{
					"guild_id":   gid,
					"channel_id": cid,
					"user_id":    user,
					"session_id": sid,
				},
			})
			if err != nil {
				slog.Warn("Failed to publish voice.peer_joined to event bus", "guild_id", gid, "user_id", user, "err", err)
			}
		}(m.p.GuildID, r.ID, uid, m.p.SessionID)
	}

	m.replyTo <- nil
}

func (r *Room) handleDisconnect(m disconnectMsg) {
	p, ok := r.peers[m.userID]
	if !ok {
		if m.replyTo != nil {
			m.replyTo <- ErrPeerNotFound
		}
		return
	}

	// If a specific peer instance was specified, ensure it is still the active peer
	if m.peer != nil && m.peer != p {
		slog.Debug("Ignoring stale disconnect message for already replaced peer", "user_id", m.userID, "room_id", r.ID)
		if m.replyTo != nil {
			m.replyTo <- nil
		}
		return
	}

	// If grace period is zero, treat as immediate leave
	if m.gracePeriod <= 0 {
		r.handleLeave(leaveMsg{userID: m.userID, peer: m.peer, replyTo: m.replyTo})
		return
	}

	// Cancel existing timer if any
	if timer, exists := r.disconnectTimers[m.userID]; exists {
		timer.Stop()
		delete(r.disconnectTimers, m.userID)
	}

	// Remove from router so dead WebRTC tracks stop receiving/sending media
	p.SetOnClose(nil)
	r.router.RemovePeer(m.userID)
	delete(r.senders, m.userID)
	_ = p.Close()

	// Keep p in r.peers[m.userID] during grace period, but schedule eviction timer
	uid := m.userID
	targetPeer := p
	r.disconnectTimers[uid] = time.AfterFunc(m.gracePeriod, func() {
		select {
		case r.inbox <- expireDisconnectMsg{userID: uid, peer: targetPeer}:
		case <-r.ctx.Done():
		}
	})

	slog.Info("Peer entered disconnect grace period", "user_id", uid, "room_id", r.ID, "duration", m.gracePeriod)
	if m.replyTo != nil {
		m.replyTo <- nil
	}
}

func (r *Room) handleExpireDisconnect(m expireDisconnectMsg) {
	p, ok := r.peers[m.userID]
	if !ok {
		return
	}

	// If the peer was replaced by a new connection, ignore expiration
	if m.peer != nil && m.peer != p {
		slog.Debug("Ignoring expired disconnect for replaced peer", "user_id", m.userID, "room_id", r.ID)
		return
	}

	delete(r.disconnectTimers, m.userID)
	r.finalizePeerEviction(m.userID, p)
	slog.Info("Peer grace period expired, removed from room", "user_id", m.userID, "room_id", r.ID)
}

func (r *Room) handleLeave(m leaveMsg) {
	// Cancel any active disconnect timer for this user
	if timer, exists := r.disconnectTimers[m.userID]; exists {
		timer.Stop()
		delete(r.disconnectTimers, m.userID)
	}

	p, ok := r.peers[m.userID]
	if !ok {
		m.replyTo <- ErrPeerNotFound
		return
	}

	// If a specific peer instance was specified, ensure it is still the active peer
	if m.peer != nil && m.peer != p {
		slog.Debug("Ignoring stale leave message for already replaced peer", "user_id", m.userID, "room_id", r.ID)
		m.replyTo <- nil
		return
	}

	p.SetOnClose(nil)
	r.router.RemovePeer(m.userID)
	_ = p.Close()

	r.finalizePeerEviction(m.userID, p)
	m.replyTo <- nil
}

// finalizePeerEviction cleans up peer maps, decrements metrics, broadcasts peer_left,
// publishes voice.peer_left to NATS, and notifies the manager if the room became empty.
func (r *Room) finalizePeerEviction(userID string, p *peer.Peer) {
	delete(r.peers, userID)
	delete(r.senders, userID)
	metrics.ConnectedPeers.Dec()

	guildID := p.GuildID
	sessionID := p.SessionID

	// Notify remaining peers
	r.broadcastExcept(userID, Event{
		Type:      "peer_left",
		UserID:    userID,
		ChannelID: r.ID,
	})

	// Publish voice.peer_left to event bus
	if r.publisher != nil && guildID != "" {
		go func(gid, cid, user, sid string) {
			err := r.publisher.Publish(context.Background(), bus.Event{
				Type:    "voice.peer_left",
				Version: 1,
				GuildID: gid,
				Payload: map[string]any{
					"guild_id":   gid,
					"channel_id": cid,
					"user_id":    user,
					"session_id": sid,
				},
			})
			if err != nil {
				slog.Warn("Failed to publish voice.peer_left to event bus", "guild_id", gid, "user_id", user, "err", err)
			}
		}(guildID, r.ID, userID, sessionID)
	}

	// If room is now empty, notify manager asynchronously
	if len(r.peers) == 0 && r.onEmpty != nil {
		go r.onEmpty(r.ID)
	}
}

func (r *Room) handleGetPeers(m peersMsg) {
	list := make([]string, 0, len(r.peers))
	for uid := range r.peers {
		list = append(list, uid)
	}
	m.replyTo <- list
}

func (r *Room) handleBroadcast(m broadcastMsg) {
	r.broadcastExcept(m.sourceUserID, m.event)
}

func (r *Room) drainAndClose() {
	r.router.Close()
	for _, timer := range r.disconnectTimers {
		timer.Stop()
	}
	r.disconnectTimers = make(map[string]*time.Timer)

	for uid, p := range r.peers {
		_ = p.Close()
		metrics.ConnectedPeers.Dec()
		delete(r.peers, uid)
		delete(r.senders, uid)
	}
}

// Join adds a peer to the room.
func (r *Room) Join(p *peer.Peer, sender BroadcastSender) error {
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- joinMsg{p: p, sender: sender, replyTo: reply}:
		select {
		case err := <-reply:
			return err
		case <-r.ctx.Done():
			return ErrRoomClosed
		}
	}
}

// Leave removes a peer from the room by userID.
func (r *Room) Leave(userID string) error {
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- leaveMsg{userID: userID, replyTo: reply}:
		select {
		case err := <-reply:
			return err
		case <-r.ctx.Done():
			return ErrRoomClosed
		}
	}
}

// LeavePeer removes a specific peer connection from the room if it is still active.
func (r *Room) LeavePeer(p *peer.Peer) error {
	if p == nil {
		return nil
	}
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- leaveMsg{userID: p.UserID, peer: p, replyTo: reply}:
		select {
		case err := <-reply:
			return err
		case <-r.ctx.Done():
			return ErrRoomClosed
		}
	}
}

// Disconnect initiates a grace period disconnection by userID.
func (r *Room) Disconnect(userID string, gracePeriod time.Duration) error {
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- disconnectMsg{userID: userID, gracePeriod: gracePeriod, replyTo: reply}:
		select {
		case err := <-reply:
			return err
		case <-r.ctx.Done():
			return ErrRoomClosed
		}
	}
}

// DisconnectPeer initiates a grace period disconnection for a peer.
func (r *Room) DisconnectPeer(p *peer.Peer, gracePeriod time.Duration) error {
	if p == nil {
		return nil
	}
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- disconnectMsg{userID: p.UserID, peer: p, gracePeriod: gracePeriod, replyTo: reply}:
		select {
		case err := <-reply:
			return err
		case <-r.ctx.Done():
			return ErrRoomClosed
		}
	}
}

// GetPeers returns the list of connected user IDs.
func (r *Room) GetPeers() ([]string, error) {
	reply := make(chan []string, 1)
	select {
	case <-r.ctx.Done():
		return nil, ErrRoomClosed
	case r.inbox <- peersMsg{replyTo: reply}:
		select {
		case peers := <-reply:
			return peers, nil
		case <-r.ctx.Done():
			return nil, ErrRoomClosed
		}
	}
}

// Broadcast sends an event to all other peers in the room.
func (r *Room) Broadcast(sourceUserID string, event Event) {
	select {
	case <-r.ctx.Done():
		return
	case r.inbox <- broadcastMsg{sourceUserID: sourceUserID, event: event}:
	}
}

// Close terminates the room actor.
func (r *Room) Close() {
	r.closeOnce.Do(func() {
		r.cancel()
	})
}
