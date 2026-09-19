package router

import (
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

// Router coordinates audio routing between publishers and subscribers within a room.
type Router struct {
	roomID string
	mu     sync.RWMutex

	// Registered publishers: pubUserID -> PublisherUplink
	publishers map[string]*PublisherUplink

	// Registered peers: userID -> *peer.Peer
	peers map[string]*peer.Peer

	// Downlinks per subscriber: subUserID -> map[pubUserID]*subscriberEntry
	subscribers map[string]map[string]*subscriberEntry

	// Renegotiation callbacks: userID -> RenegotiateCallback
	renegotiators map[string]RenegotiateCallback
}

// NewRouter creates a new audio track router for a room.
func NewRouter(roomID string) *Router {
	return &Router{
		roomID:        roomID,
		publishers:    make(map[string]*PublisherUplink),
		peers:         make(map[string]*peer.Peer),
		subscribers:   make(map[string]map[string]*subscriberEntry),
		renegotiators: make(map[string]RenegotiateCallback),
	}
}

// AddPeer registers a peer and its renegotiation callback with the router.
func (r *Router) AddPeer(p *peer.Peer, renegotiate RenegotiateCallback) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.peers[p.UserID] = p
	r.renegotiators[p.UserID] = renegotiate
	if r.subscribers[p.UserID] == nil {
		r.subscribers[p.UserID] = make(map[string]*subscriberEntry)
	}
}

// RemovePeer unregisters a peer, tearing down any publishing uplinks and subscriber downlinks.
func (r *Router) RemovePeer(userID string) {
	r.mu.Lock()
	// 1. If this peer was publishing, tear down publisher uplink
	if pub, ok := r.publishers[userID]; ok {
		pub.Close()
		delete(r.publishers, userID)

		// Clean up downlinks in other peers that were receiving from this publisher
		for subID, subMap := range r.subscribers {
			if entry, exists := subMap[userID]; exists {
				entry.downlink.Close()
				if p, okPeer := r.peers[subID]; okPeer {
					_ = p.RemoveTrack(entry.sender)
				}
				delete(subMap, userID)
			}
		}
	}

	// 2. Remove all downlinks where this peer is a subscriber
	if subMap, ok := r.subscribers[userID]; ok {
		for pubID, entry := range subMap {
			entry.downlink.Close()
			if pub, okPub := r.publishers[pubID]; okPub {
				pub.RemoveSubscriber(userID)
			}
		}
		delete(r.subscribers, userID)
	}

	delete(r.peers, userID)
	delete(r.renegotiators, userID)
	r.mu.Unlock()
}

// AddPublisher sets up a new publisher uplink and creates subscriber downlinks for all other peers.
func (r *Router) AddPublisher(pubID string, trackRemote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	r.mu.Lock()
	if existing, ok := r.publishers[pubID]; ok {
		existing.Close()
	}

	uplink := NewPublisherUplink(pubID, trackRemote, receiver)
	r.publishers[pubID] = uplink

	streamID := trackRemote.StreamID()
	if streamID == "" {
		streamID = "kith-stream-" + pubID
	}
	trackID := trackRemote.ID()
	if trackID == "" {
		trackID = "kith-track-" + pubID
	}

	var peersToRenegotiate []string
	for subID, p := range r.peers {
		if subID == pubID {
			continue
		}

		trackLocal, err := webrtc.NewTrackLocalStaticRTP(
			trackRemote.Codec().RTPCodecCapability,
			trackID,
			streamID,
		)
		if err != nil {
			slog.Error("Failed to create TrackLocalStaticRTP", "sub_id", subID, "pub_id", pubID, "err", err)
			continue
		}

		sender, err := p.AddTrack(trackLocal)
		if err != nil {
			slog.Error("Failed to add track to subscriber peer", "sub_id", subID, "pub_id", pubID, "err", err)
			continue
		}

		downlink := NewSubscriberDownlink(subID, pubID, trackLocal, sender)
		uplink.AddSubscriber(downlink)

		if r.subscribers[subID] == nil {
			r.subscribers[subID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[subID][pubID] = &subscriberEntry{
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
	if pub, ok := r.publishers[pubID]; ok {
		pub.Close()
		delete(r.publishers, pubID)

		for subID, subMap := range r.subscribers {
			if entry, exists := subMap[pubID]; exists {
				entry.downlink.Close()
				if p, okPeer := r.peers[subID]; okPeer {
					_ = p.RemoveTrack(entry.sender)
				}
				delete(subMap, pubID)
			}
		}
	}
	r.mu.Unlock()
}

// SubscribeToExistingPublishers attaches downlinks for all currently active publishers to the given subscriber.
func (r *Router) SubscribeToExistingPublishers(userID string) {
	r.mu.Lock()
	p, ok := r.peers[userID]
	if !ok {
		r.mu.Unlock()
		return
	}

	needsRenegotiate := false
	for pubID, pub := range r.publishers {
		if pubID == userID {
			continue
		}

		// Check if already subscribed
		if r.subscribers[userID] != nil && r.subscribers[userID][pubID] != nil {
			continue
		}

		streamID := pub.TrackRemote.StreamID()
		if streamID == "" {
			streamID = "kith-stream-" + pubID
		}
		trackID := pub.TrackRemote.ID()
		if trackID == "" {
			trackID = "kith-track-" + pubID
		}

		trackLocal, err := webrtc.NewTrackLocalStaticRTP(
			pub.TrackRemote.Codec().RTPCodecCapability,
			trackID,
			streamID,
		)
		if err != nil {
			slog.Error("Failed to create TrackLocalStaticRTP", "sub_id", userID, "pub_id", pubID, "err", err)
			continue
		}

		sender, err := p.AddTrack(trackLocal)
		if err != nil {
			slog.Error("Failed to add track to subscriber peer", "sub_id", userID, "pub_id", pubID, "err", err)
			continue
		}

		downlink := NewSubscriberDownlink(userID, pubID, trackLocal, sender)
		pub.AddSubscriber(downlink)

		if r.subscribers[userID] == nil {
			r.subscribers[userID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[userID][pubID] = &subscriberEntry{
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
func (r *Router) TriggerRenegotiation(userID string) {
	r.mu.RLock()
	p, okPeer := r.peers[userID]
	cb, okCb := r.renegotiators[userID]
	r.mu.RUnlock()

	if !okPeer || !okCb || cb == nil || p == nil {
		return
	}

	if p.PC.SignalingState() != webrtc.SignalingStateStable {
		slog.Debug("Postponing renegotiation: signaling state not stable", "user_id", userID, "state", p.PC.SignalingState().String())
		return
	}

	offer, err := p.CreateOffer()
	if err != nil {
		slog.Error("Failed to create offer for renegotiation", "user_id", userID, "err", err)
		return
	}

	cb(*offer)
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
	r.peers = make(map[string]*peer.Peer)
	r.renegotiators = make(map[string]RenegotiateCallback)
}
