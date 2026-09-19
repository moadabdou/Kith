package room

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
)

var (
	ErrRoomClosed   = errors.New("room is closed")
	ErrPeerNotFound = errors.New("peer not found in room")
)

// BroadcastSender is a function that delivers a message to a specific peer.
type BroadcastSender func(targetUserID string, msgType string, payload interface{})

// Room manages a voice channel room actor.
type Room struct {
	ID        string
	peers     map[string]*peer.Peer
	senders   map[string]BroadcastSender
	inbox     chan roomMsg
	ctx       context.Context
	cancel    context.CancelFunc
	onEmpty   func(roomID string)
	closeOnce sync.Once
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
	replyTo chan error
}

func (leaveMsg) isRoomMsg() {}

type peersMsg struct {
	replyTo chan []string
}

func (peersMsg) isRoomMsg() {}

type broadcastMsg struct {
	sourceUserID string
	msgType      string
	payload      interface{}
}

func (broadcastMsg) isRoomMsg() {}

// NewRoom creates and launches a new Room actor.
func NewRoom(id string, onEmpty func(roomID string)) *Room {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Room{
		ID:      id,
		peers:   make(map[string]*peer.Peer),
		senders: make(map[string]BroadcastSender),
		inbox:   make(chan roomMsg, 64),
		ctx:     ctx,
		cancel:  cancel,
		onEmpty: onEmpty,
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
			case peersMsg:
				r.handleGetPeers(m)
			case broadcastMsg:
				r.handleBroadcast(m)
			}
		}
	}
}

func (r *Room) handleJoin(m joinMsg) {
	uid := m.p.UserID

	// If existing peer with same user_id is already in room, cleanly close it first
	if existing, ok := r.peers[uid]; ok {
		slog.Warn("Replacing existing peer connection for user", "user_id", uid, "room_id", r.ID)
		_ = existing.Close()
		metrics.ConnectedPeers.Dec()
	}

	r.peers[uid] = m.p
	if m.sender != nil {
		r.senders[uid] = m.sender
	}
	metrics.ConnectedPeers.Inc()

	// Notify other peers in room
	for otherUID, sender := range r.senders {
		if otherUID != uid && sender != nil {
			sender(otherUID, "peer_joined", map[string]string{
				"user_id":    uid,
				"channel_id": r.ID,
			})
		}
	}

	m.replyTo <- nil
}

func (r *Room) handleLeave(m leaveMsg) {
	p, ok := r.peers[m.userID]
	if !ok {
		m.replyTo <- ErrPeerNotFound
		return
	}

	delete(r.peers, m.userID)
	delete(r.senders, m.userID)
	_ = p.Close()
	metrics.ConnectedPeers.Dec()

	// Notify remaining peers
	for otherUID, sender := range r.senders {
		if sender != nil {
			sender(otherUID, "peer_left", map[string]string{
				"user_id":    m.userID,
				"channel_id": r.ID,
			})
		}
	}

	m.replyTo <- nil

	// If room is now empty, notify manager
	if len(r.peers) == 0 && r.onEmpty != nil {
		r.onEmpty(r.ID)
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
	for uid, sender := range r.senders {
		if uid != m.sourceUserID && sender != nil {
			sender(uid, m.msgType, m.payload)
		}
	}
}

func (r *Room) drainAndClose() {
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
		return <-reply
	}
}

// Leave removes a peer from the room.
func (r *Room) Leave(userID string) error {
	reply := make(chan error, 1)
	select {
	case <-r.ctx.Done():
		return ErrRoomClosed
	case r.inbox <- leaveMsg{userID: userID, replyTo: reply}:
		return <-reply
	}
}

// GetPeers returns the list of connected user IDs.
func (r *Room) GetPeers() ([]string, error) {
	reply := make(chan []string, 1)
	select {
	case <-r.ctx.Done():
		return nil, ErrRoomClosed
	case r.inbox <- peersMsg{replyTo: reply}:
		return <-reply, nil
	}
}

// Broadcast sends a message to all other peers in the room.
func (r *Room) Broadcast(sourceUserID, msgType string, payload interface{}) {
	select {
	case <-r.ctx.Done():
		return
	case r.inbox <- broadcastMsg{sourceUserID: sourceUserID, msgType: msgType, payload: payload}:
	}
}

// Close terminates the room actor.
func (r *Room) Close() {
	r.closeOnce.Do(func() {
		r.cancel()
	})
}
