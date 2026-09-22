package router

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
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

	// videoKind: pubID -> declared kind of the user's single video uplink.
	// Negotiate-once contract: the client toggles cam/screen via
	// video/screen signals instead of renegotiating, so the SFU trusts the
	// last-writer-wins signal here — never SDP msids — for labeling.
	videoKind map[string]VideoKind
}

// VideoKind is the declared kind of a user's single video uplink.
type VideoKind int

const (
	// VideoKindNone means no video is currently published (or unknown).
	VideoKindNone VideoKind = iota
	// VideoKindCamera means the uplink carries webcam video.
	VideoKindCamera
	// VideoKindScreen means the uplink carries a screen share.
	VideoKindScreen
)

// NewRouter creates a new audio track router for a room.
func NewRouter(roomID string) *Router {
	return &Router{
		roomID:      roomID,
		publishers:  make(map[string]*PublisherUplink),
		peers:       make(map[string]*peerEntry),
		subscribers: make(map[string]map[string]*subscriberEntry),
		videoKind:   make(map[string]VideoKind),
	}
}

// HasPeer reports whether userID is currently registered in the room.
func (r *Router) HasPeer(userID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.peers[userID]
	return ok
}

// VideoKindOf returns the currently declared video kind for a publisher.
// Test/debug helper; unknown users report VideoKindNone.
func (r *Router) VideoKindOf(pubID string) VideoKind {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.videoKind[pubID]
}

// trackKey returns a unique key for an ingress track:
// pubID:kind:trackID for audio, pubID:video:rid for video (simulcast layers
// share the track ID, so the RID disambiguates; empty RID = legacy or
// dormant uplink, treated as the full layer 'f'). Nil remote → bare pubID.
func trackKey(pubID string, trackRemote *webrtc.TrackRemote) string {
	if trackRemote == nil {
		return pubID
	}
	if trackRemote.Kind() == webrtc.RTPCodecTypeVideo {
		rid := trackRemote.RID()
		if rid == "" {
			rid = LayerFull
		}
		return fmt.Sprintf("%s:video:%s", pubID, rid)
	}
	id := trackRemote.ID()
	if id == "" {
		id = trackRemote.Kind().String()
	}
	return fmt.Sprintf("%s:%s:%s", pubID, trackRemote.Kind().String(), id)
}

// Simulcast layer RIDs (issue #80). LayerFull is also the legacy label for
// uplinks with no RID (non-simulcast publishers, dormant video).
const (
	LayerFull    = "f"
	LayerHalf    = "h"
	LayerQuarter = "q"
)

// LayerInfo describes one ingested simulcast layer (for #82 + observability).
type LayerInfo struct {
	RID   string
	SSRC  uint32
	Kind  VideoKind
	Alive bool
}

// Layers returns the ingested simulcast layer state for a publisher.
func (r *Router) Layers(pubID string) []LayerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []LayerInfo
	for key, pub := range r.publishers {
		if pub == nil || pub.PublisherID != pubID || pub.Kind != webrtc.RTPCodecTypeVideo {
			continue
		}
		rid := LayerFull
		if rest, ok := cutPrefix(key, pubID+":video:"); ok && rest != "" {
			rid = rest
		}
		var ssrc uint32
		if pub.TrackRemote != nil {
			ssrc = uint32(pub.TrackRemote.SSRC())
		}
		out = append(out, LayerInfo{
			RID:   rid,
			SSRC:  ssrc,
			Kind:  r.videoKind[pubID],
			Alive: !pub.IsClosed(),
		})
	}
	sortLayers(out)
	return out
}

func cutPrefix(s, prefix string) (string, bool) {
	if len(s) < len(prefix) || s[:len(prefix)] != prefix {
		return "", false
	}
	return s[len(prefix):], true
}

// layerOfKey extracts the simulcast layer RID from a publisher key
// (pubID:video:rid); anything unparseable is the full layer.
func layerOfKey(key string) string {
	idx := strings.LastIndex(key, ":")
	if idx < 0 || idx+1 >= len(key) {
		return LayerFull
	}
	if rest := key[idx+1:]; rest != "" {
		return rest
	}
	return LayerFull
}

func sortLayers(layers []LayerInfo) {
	order := map[string]int{LayerFull: 0, LayerHalf: 1, LayerQuarter: 2}
	sort.Slice(layers, func(i, j int) bool {
		oi, oki := order[layers[i].RID]
		oj, okj := order[layers[j].RID]
		if oki && okj {
			return oi < oj
		}
		if oki != okj {
			return oki
		}
		return layers[i].RID < layers[j].RID
	})
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
// Video uplinks are labeled from the declared per-user kind flag (see
// SetVideoKind) — never from SDP msids, which are browser-random under the
// negotiate-once contract.
func (r *Router) AddPublisher(pubID string, trackRemote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	r.mu.Lock()
	tKey := trackKey(pubID, trackRemote)

	if existing, ok := r.publishers[tKey]; ok {
		existing.Close()
	}

	uplink := NewPublisherUplink(pubID, trackRemote, receiver)
	uplink.TrackKey = tKey
	if uplink.Kind == webrtc.RTPCodecTypeVideo {
		uplink.IsScreen = r.videoKind[pubID] == VideoKindScreen
	}
	uplink.SetOnDeath(r.onUplinkDeath)

	if pe, ok := r.peers[pubID]; ok && pe.peer != nil {
		uplink.SetRTCPWriter(pe.peer.WriteRTCP)
	}
	r.publishers[tKey] = uplink

	// A dormant video uplink gets no downlinks; SetVideoKind builds them
	// when the kind is declared. Dormant = kind none (signal hasn't arrived
	// yet, or the user stopped sharing) or a non-full simulcast layer:
	// until #82 adds per-viewer switching, only the full layer f is
	// forwarded.
	if uplink.Kind == webrtc.RTPCodecTypeVideo &&
		(r.videoKind[pubID] == VideoKindNone || layerOfKey(tKey) != LayerFull) {
		r.mu.Unlock()
		return
	}

	peerNeedsReneg := make(map[string]bool)
	r.subscribeUplinkLocked(uplink, tKey, peerNeedsReneg)
	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// SetVideoKind declares the kind of pubID's single video uplink
// (last-writer-wins) and converges forwarding to match:
//   - kind none: tear down video downlinks, keep the uplink object — the
//     same RTP stream may carry the next source after a switch (no OnTrack
//     refires on replaceTrack).
//   - kind camera/screen: relabel the existing uplink if needed and
//     (re)build downlinks under the kind-correct IDs; a not-yet-arrived
//     uplink is labeled when OnTrack delivers it.
//
// Caller must NOT hold r.mu (triggers renegotiation after unlock).
func (r *Router) SetVideoKind(pubID string, kind VideoKind) {
	r.mu.Lock()
	if r.videoKind == nil {
		r.videoKind = make(map[string]VideoKind)
	}
	prev := r.videoKind[pubID]
	r.videoKind[pubID] = kind
	if prev == kind {
		r.mu.Unlock()
		return
	}

	peerNeedsReneg := make(map[string]bool)
	for key, pub := range r.publishers {
		if pub == nil || pub.PublisherID != pubID || pub.Kind != webrtc.RTPCodecTypeVideo {
			continue
		}
		// Only the full simulcast layer is converged here; h/q uplinks stay
		// ingested-but-dormant until #82 switches viewers between layers.
		if layerOfKey(key) != LayerFull {
			continue
		}
		if kind == VideoKindNone {
			r.removeDownlinksLocked(key, peerNeedsReneg)
			continue
		}
		wantScreen := kind == VideoKindScreen
		if pub.IsScreen == wantScreen {
			if r.hasDownlinksLocked(key) {
				continue
			}
		} else {
			pub.IsScreen = wantScreen
			slog.Info("Relabeled video uplink kind", "pub_id", pubID, "screen", wantScreen, "key", key)
			r.removeDownlinksLocked(key, peerNeedsReneg)
		}
		r.subscribeUplinkLocked(pub, key, peerNeedsReneg)
	}
	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// subscribeUplinkLocked fans an uplink out to every other registered peer.
// Caller MUST hold r.mu; renegotiation is triggered by the caller after unlock.
func (r *Router) subscribeUplinkLocked(uplink *PublisherUplink, tKey string, peerNeedsReneg map[string]bool) {
	pubID := uplink.PublisherID
	downlinkTrackID := uplink.DownlinkTrackID(pubID)
	downlinkStreamID := uplink.DownlinkStreamID(pubID)

	for subID, pe := range r.peers {
		if subID == pubID || pe.peer == nil {
			continue
		}
		if r.subscribers[subID] != nil && r.subscribers[subID][tKey] != nil {
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
		downlink.SetScreen(uplink.IsScreen)
		uplink.AddSubscriber(downlink)

		if r.subscribers[subID] == nil {
			r.subscribers[subID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[subID][tKey] = &subscriberEntry{
			downlink: downlink,
			sender:   sender,
		}
		peerNeedsReneg[subID] = true
	}
}

// removeDownlinksLocked closes every subscriber downlink filed under tKey and
// removes the sender tracks. Caller MUST hold r.mu.
func (r *Router) removeDownlinksLocked(tKey string, peerNeedsReneg map[string]bool) {
	for subID, subMap := range r.subscribers {
		entry, ok := subMap[tKey]
		if !ok {
			continue
		}
		entry.downlink.Close()
		if pe, okPeer := r.peers[subID]; okPeer && pe.peer != nil {
			_ = pe.peer.RemoveTrack(entry.sender)
			peerNeedsReneg[subID] = true
		}
		delete(subMap, tKey)
	}
}

// hasDownlinksLocked reports whether any subscriber downlink exists for tKey.
// Caller MUST hold r.mu.
func (r *Router) hasDownlinksLocked(tKey string) bool {
	for _, subMap := range r.subscribers {
		if _, ok := subMap[tKey]; ok {
			return true
		}
	}
	return false
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

// RemovePublisherCamera removes webcam video publisher uplinks and associated downlinks for a peer.
// Identity is the IsScreen flag only — screen uplinks/downlinks always
// survive, audio is never touched (exact uplink-key matching). Note: the
// signaling path no longer calls this on video:false (that only clears the
// kind flag via SetVideoKind and keeps the uplink object for stream reuse);
// this remains the explicit teardown API.
func (r *Router) RemovePublisherCamera(pubID string) {
	r.mu.Lock()
	peerNeedsReneg := make(map[string]bool)

	for key, pub := range r.publishers {
		if pub == nil || pub.PublisherID != pubID || pub.Kind != webrtc.RTPCodecTypeVideo || pub.IsScreen {
			continue
		}
		pub.Close()
		delete(r.publishers, key)
		r.removeDownlinksLocked(key, peerNeedsReneg)
	}

	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// RemovePublisherScreen removes screenshare publisher uplinks and associated downlinks for a peer.
// Identity is the IsScreen flag only. The signaling path no longer calls
// this on screen:false (see RemovePublisherCamera).
func (r *Router) RemovePublisherScreen(pubID string) {
	r.mu.Lock()
	peerNeedsReneg := make(map[string]bool)

	for key, pub := range r.publishers {
		if pub == nil || pub.PublisherID != pubID || pub.Kind != webrtc.RTPCodecTypeVideo || !pub.IsScreen {
			continue
		}
		pub.Close()
		delete(r.publishers, key)
		r.removeDownlinksLocked(key, peerNeedsReneg)
	}

	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// RemovePublisherKind removes publisher uplinks and subscriber downlinks of a specific kind (e.g. Video) for a peer.
func (r *Router) RemovePublisherKind(pubID string, kind webrtc.RTPCodecType) {
	r.mu.Lock()
	peerNeedsReneg := make(map[string]bool)

	for key, pub := range r.publishers {
		if pub.PublisherID == pubID && pub.Kind == kind {
			pub.Close()
			delete(r.publishers, key)
		}
	}

	for subID, subMap := range r.subscribers {
		for key, entry := range subMap {
			if entry.downlink.PublisherID == pubID {
				if (kind == webrtc.RTPCodecTypeVideo && strings.Contains(key, ":video:")) ||
					(kind == webrtc.RTPCodecTypeAudio && strings.Contains(key, ":audio:")) {
					entry.downlink.Close()
					if pe, okPeer := r.peers[subID]; okPeer && pe.peer != nil {
						_ = pe.peer.RemoveTrack(entry.sender)
						peerNeedsReneg[subID] = true
					}
					delete(subMap, key)
				}
			}
		}
	}

	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
	r.mu.Unlock()

	for _, subID := range peersToRenegotiate {
		r.TriggerRenegotiation(subID)
	}
}

// onUplinkDeath evicts a single dead uplink (readingLoop EOF/error) and its
// downlinks, then renegotiates affected subscribers. It runs in its own
// goroutine (fired from PublisherUplink.Close) so it locks r.mu itself and
// must never be called inline while holding the lock. Explicit removals
// delete the map entry first, so a trailing death callback is a no-op (R5).
func (r *Router) onUplinkDeath(tKey string) {
	r.mu.Lock()
	peerNeedsReneg := make(map[string]bool)

	if _, ok := r.publishers[tKey]; !ok {
		r.mu.Unlock()
		return
	}
	delete(r.publishers, tKey)

	for subID, subMap := range r.subscribers {
		if entry, ok := subMap[tKey]; ok {
			entry.downlink.Close()
			if pe, okPeer := r.peers[subID]; okPeer && pe.peer != nil {
				_ = pe.peer.RemoveTrack(entry.sender)
				peerNeedsReneg[subID] = true
			}
			delete(subMap, tKey)
		}
	}

	var peersToRenegotiate []string
	for subID := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, subID)
	}
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

		// Never fan out corpses: dead uplinks are evicted via onDeath, but
		// skip them here too if eviction hasn't run yet (R5).
		if pub.IsClosed() {
			continue
		}

		// Never fan out dormant video: the uplink object survives kind:false
		// (same RTP stream may be reused), but with no declared kind there
		// is nothing to forward yet. SetVideoKind subscribes on declaration.
		// Non-full simulcast layers stay ingested-but-dormant until #82.
		if pub.Kind == webrtc.RTPCodecTypeVideo &&
			(r.videoKind[pub.PublisherID] == VideoKindNone || layerOfKey(tKey) != LayerFull) {
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
		downlink.SetScreen(pub.IsScreen)
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
