package router

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

// RenegotiateCallback is called when a peer's tracks have changed and a new SDP offer must be sent.
type RenegotiateCallback func(offer webrtc.SessionDescription)

type subscriberEntry struct {
	downlink *SubscriberDownlink
	sender   *webrtc.RTPSender
}

type peerEntry struct {
	peer                 *peer.Peer
	renegotiate          RenegotiateCallback
	renegotiationPending bool
}

// Router coordinates audio routing between publishers and subscribers within a room.
type Router struct {
	roomID string
	mu     sync.RWMutex

	// Registered publishers: pubUserID -> PublisherUplink
	publishers map[string]*PublisherUplink

	// Registered peers: userID -> *peerEntry (bundles peer, callback, and pending state)
	peers map[string]*peerEntry

	// Downlinks per subscriber: subUserID -> map[pubUserID]*subscriberEntry
	subscribers map[string]map[string]*subscriberEntry
}

// NewRouter creates a new audio track router for a room.
func NewRouter(roomID string) *Router {
	return &Router{
		roomID:      roomID,
		publishers:  make(map[string]*PublisherUplink),
		peers:       make(map[string]*peerEntry),
		subscribers: make(map[string]map[string]*subscriberEntry),
	}
}

// trackKey returns a unique key for an ingress track: pubID:kind:trackID, or pubID if remote is nil.
func trackKey(pubID string, trackRemote *webrtc.TrackRemote) string {
	if trackRemote == nil {
		return pubID
	}
	id := trackRemote.ID()
	if id == "" {
		id = trackRemote.Kind().String()
	}
	return fmt.Sprintf("%s:%s:%s", pubID, trackRemote.Kind().String(), id)
}

// AddPeer registers a peer and its renegotiation callback with the router.
func (r *Router) AddPeer(p *peer.Peer, renegotiate RenegotiateCallback) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.peers[p.UserID] = &peerEntry{
		peer:        p,
		renegotiate: renegotiate,
	}
	if r.subscribers[p.UserID] == nil {
		r.subscribers[p.UserID] = make(map[string]*subscriberEntry)
	}

	// If this peer already has publisher uplinks, wire the RTCP writer to its peer connection
	for _, pub := range r.publishers {
		if pub.PublisherID == p.UserID {
			pub.SetRTCPWriter(p.WriteRTCP)
		}
	}

	// Whenever the peer connection returns to Stable, automatically flush any postponed renegotiation
	p.SetOnSignalingStable(func() {
		r.OnSignalingStateStable(p.UserID)
	})
}

// removePublisherLocked removes an active publisher and cleans up all downlinks receiving from it.
// Returns the list of subscriber IDs that require renegotiation.
// Caller MUST hold r.mu.
func (r *Router) removePublisherLocked(pubID string) []string {
	peerNeedsReneg := make(map[string]bool)

	for key, pub := range r.publishers {
		if pub.PublisherID == pubID || key == pubID {
			pub.Close()
			delete(r.publishers, key)
		}
	}

	// Clean up downlinks in other peers that were receiving from this publisher
	for subID, subMap := range r.subscribers {
		for key, entry := range subMap {
			if entry.downlink.PublisherID == pubID || key == pubID {
				entry.downlink.Close()
				if pe, okPeer := r.peers[subID]; okPeer && pe.peer != nil {
					_ = pe.peer.RemoveTrack(entry.sender)
					peerNeedsReneg[subID] = true
				}
				delete(subMap, key)
			}
		}
	}

	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	return peersToRenegotiate
}

// RemovePeer unregisters a peer, tearing down any publishing uplinks and subscriber downlinks.
func (r *Router) RemovePeer(userID string) {
	r.mu.Lock()
	// 1. If this peer was publishing, tear down publisher uplinks and notify subscribers
	peersToRenegotiate := r.removePublisherLocked(userID)

	// 2. Remove all downlinks where this peer is a subscriber
	if subMap, ok := r.subscribers[userID]; ok {
		for pubTrackKey, entry := range subMap {
			entry.downlink.Close()
			if pub, okPub := r.publishers[pubTrackKey]; okPub {
				pub.RemoveSubscriber(userID)
			}
		}
		delete(r.subscribers, userID)
	}

	delete(r.peers, userID)
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// AddPublisher sets up a new publisher uplink (audio or video) and creates subscriber downlinks for all other peers.
func (r *Router) AddPublisher(pubID string, trackRemote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	r.mu.Lock()
	tKey := trackKey(pubID, trackRemote)

	if existing, ok := r.publishers[tKey]; ok {
		existing.Close()
	}

	uplink := NewPublisherUplink(pubID, trackRemote, receiver)
	uplink.TrackKey = tKey
	if pe, ok := r.peers[pubID]; ok && pe.peer != nil {
		uplink.SetRTCPWriter(pe.peer.WriteRTCP)
	}
	r.publishers[tKey] = uplink

	downlinkTrackID := uplink.DownlinkTrackID(pubID)
	downlinkStreamID := uplink.DownlinkStreamID(pubID)

	var peersToRenegotiate []string
	for subID, pe := range r.peers {
		if subID == pubID || pe.peer == nil {
			continue
		}

		trackLocal, err := webrtc.NewTrackLocalStaticRTP(
			uplink.CodecCap,
			downlinkTrackID,
			downlinkStreamID,
		)
		if err != nil {
			slog.Error("Failed to create TrackLocalStaticRTP", "sub_id", subID, "pub_id", pubID, "kind", uplink.Kind.String(), "err", err)
			continue
		}

		sender, err := pe.peer.AddTrack(trackLocal)
		if err != nil {
			slog.Error("Failed to add track to subscriber peer", "sub_id", subID, "pub_id", pubID, "kind", uplink.Kind.String(), "err", err)
			continue
		}

		downlink := NewSubscriberDownlink(subID, pubID, trackLocal, sender)
		uplink.AddSubscriber(downlink)

		if r.subscribers[subID] == nil {
			r.subscribers[subID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[subID][tKey] = &subscriberEntry{
			downlink: downlink,
			sender:   sender,
		}
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// RemovePublisher removes an active publisher and tears down associated downlinks.
func (r *Router) RemovePublisher(pubID string) {
	r.mu.Lock()
	peersToRenegotiate := r.removePublisherLocked(pubID)
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// SubscribeToExistingPublishers attaches downlinks for all currently active publishers to the given subscriber.
func (r *Router) SubscribeToExistingPublishers(userID string) {
	r.mu.Lock()
	pe, ok := r.peers[userID]
	if !ok || pe == nil || pe.peer == nil {
		r.mu.Unlock()
		return
	}
	p := pe.peer

	needsRenegotiate := false
	for tKey, pub := range r.publishers {
		if pub.PublisherID == userID {
			continue
		}

		// Check if already subscribed to this specific track
		if r.subscribers[userID] != nil && r.subscribers[userID][tKey] != nil {
			continue
		}

		trackLocal, err := webrtc.NewTrackLocalStaticRTP(
			pub.CodecCap,
			pub.DownlinkTrackID(pub.PublisherID),
			pub.DownlinkStreamID(pub.PublisherID),
		)
		if err != nil {
			slog.Error("Failed to create TrackLocalStaticRTP", "sub_id", userID, "pub_id", pub.PublisherID, "kind", pub.Kind.String(), "err", err)
			continue
		}

		sender, err := p.AddTrack(trackLocal)
		if err != nil {
			slog.Error("Failed to add track to subscriber peer", "sub_id", userID, "pub_id", pub.PublisherID, "kind", pub.Kind.String(), "err", err)
			continue
		}

		downlink := NewSubscriberDownlink(userID, pub.PublisherID, trackLocal, sender)
		pub.AddSubscriber(downlink)

		if r.subscribers[userID] == nil {
			r.subscribers[userID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[userID][tKey] = &subscriberEntry{
			downlink: downlink,
			sender:   sender,
		}
		needsRenegotiate = true
	}
	r.mu.Unlock()

	if needsRenegotiate {
		r.TriggerRenegotiation(userID)
	}
}

// TriggerRenegotiation sends a renegotiation offer to the subscriber if its signaling state is stable.
// If the connection is currently in an in-flight offer/answer exchange, it marks renegotiationPending
// so it will automatically trigger once the state returns to Stable.
func (r *Router) TriggerRenegotiation(userID string) {
	r.mu.Lock()
	entry, ok := r.peers[userID]
	if !ok || entry == nil || entry.renegotiate == nil || entry.peer == nil {
		r.mu.Unlock()
		return
	}

	if entry.peer.PC.SignalingState() != webrtc.SignalingStateStable {
		slog.Info("Postponing renegotiation: signaling state not stable, queued for retry",
			"user_id", userID,
			"state", entry.peer.PC.SignalingState().String(),
		)
		entry.renegotiationPending = true
		r.mu.Unlock()
		return
	}

	entry.renegotiationPending = false
	p := entry.peer
	cb := entry.renegotiate
	r.mu.Unlock()

	offer, err := p.CreateOffer()
	if err != nil {
		slog.Error("Failed to create offer for renegotiation", "user_id", userID, "err", err)
		return
	}

	slog.Info("Sending downstream renegotiation offer to subscriber", "user_id", userID)
	cb(*offer)
}

// OnSignalingStateStable checks if a postponed renegotiation is pending and executes it immediately.
func (r *Router) OnSignalingStateStable(userID string) {
	r.mu.Lock()
	entry, ok := r.peers[userID]
	if !ok || entry == nil || !entry.renegotiationPending {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	r.TriggerRenegotiation(userID)
}

// Close terminates all publisher uplinks and subscriber downlinks in the router.
func (r *Router) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, pub := range r.publishers {
		pub.Close()
	}
	r.publishers = make(map[string]*PublisherUplink)

	for _, subMap := range r.subscribers {
		for _, entry := range subMap {
			entry.downlink.Close()
		}
	}
	r.subscribers = make(map[string]map[string]*subscriberEntry)
	r.peers = make(map[string]*peerEntry)
}
