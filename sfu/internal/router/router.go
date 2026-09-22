package router

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/rtcp"
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
	ctx    context.Context
	cancel context.CancelFunc

	// Registered publishers: pubUserID -> PublisherUplink
	publishers map[string]*PublisherUplink

	// Registered peers: userID -> *peerEntry (bundles peer, callback, and pending state)
	peers map[string]*peerEntry

	// Downlinks per subscriber: subUserID -> map[uplinkKey]*subscriberEntry.
	// Video entries are per-(publisher, layer): pubID:video:<rid> (#82);
	// audio stays per-publisher.
	subscribers map[string]map[string]*subscriberEntry

	// videoKind: pubID -> declared kind of the user's single video uplink.
	// Negotiate-once contract: the client toggles cam/screen via
	// video/screen signals instead of renegotiating, so the SFU trusts the
	// last-writer-wins signal here — never SDP msids — for labeling.
	videoKind map[string]VideoKind

	// switchCooldown: (subID/pubID) -> last layer-switch time. Second
	// anti-flap guard after hysteresis (#82 conservative policy).
	switchCooldown map[string]time.Time
}

// switchCooldownInterval is the minimum time between layer switches for one
// (subscriber, publisher) pair.
const switchCooldownInterval = 10 * time.Second

// evalInterval is the layer-selection evaluation period (one router ticker,
// not per-downlink).
const evalInterval = time.Second

// switchReplayMaxAge bounds keyframe replay freshness on layer switches.
// Tighter than the initial-join bound (maxKeyframeAge): a stale anchor
// combined with live deltas referencing newer state freezes the decoder
// until the next natural keyframe, and a fresh PLI (always sent alongside)
// covers the gap.
const switchReplayMaxAge = time.Second

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
	ctx, cancel := context.WithCancel(context.Background())
	r := &Router{
		roomID:         roomID,
		ctx:            ctx,
		cancel:         cancel,
		publishers:     make(map[string]*PublisherUplink),
		peers:          make(map[string]*peerEntry),
		subscribers:    make(map[string]map[string]*subscriberEntry),
		videoKind:      make(map[string]VideoKind),
		switchCooldown: make(map[string]time.Time),
	}
	go r.evalLoop()
	return r
}

// evalLoop periodically converges every video downlink to its entitled
// simulcast layer (#82). One goroutine per router; exits on Close.
func (r *Router) evalLoop() {
	t := time.NewTicker(evalInterval)
	defer t.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-t.C:
			r.evalLayers()
		}
	}
}

// switchCooldownKey keys the per-pair switch cooldown.
func switchCooldownKey(subID, pubID string) string {
	return subID + "\x00" + pubID
}

// evalLayers converges each cam-video downlink to its score-entitled layer.
// Screen, audio, dead, and kind-none uplinks are skipped. Switch DOWN takes
// effect via keyframe-gated repointing; switch UP is instant with cached
// keyframe replay. Cooldown + hysteresis (in desiredLayer) prevent flapping.
func (r *Router) evalLayers() {
	type switchReq struct {
		subID, pubID, from, to string
		loss, nackRate         float64
	}
	var reqs []switchReq
	now := time.Now()

	r.mu.Lock()
	for subID, subMap := range r.subscribers {
		for tKey, entry := range subMap {
			if entry == nil || entry.downlink == nil {
				continue
			}
			pubID := entry.downlink.PublisherID
			pub, ok := r.publishers[tKey]
			if !ok || pub == nil || pub.IsClosed() {
				continue
			}
			if pub.Kind != webrtc.RTPCodecTypeVideo || pub.IsScreen {
				continue // screen + audio never switch
			}
			if r.videoKind[pubID] == VideoKindNone {
				continue
			}
			current := entry.downlink.GetLayer()
			loss, jitter, good, _, nackRate := entry.downlink.ScoreSnapshot()
			want := desiredLayer(current, sanitizeScore(loss), jitter, good, nackRate)
			if want == current {
				continue
			}
			// Target layer must exist and be alive.
			wantKey := pubID + ":video:" + want
			target, ok := r.publishers[wantKey]
			if !ok || target == nil || target.IsClosed() {
				continue
			}
			if last, ok := r.switchCooldown[switchCooldownKey(subID, pubID)]; ok &&
				now.Sub(last) < switchCooldownInterval {
				continue
			}
			r.switchCooldown[switchCooldownKey(subID, pubID)] = now
			reqs = append(reqs, switchReq{subID: subID, pubID: pubID, from: current, to: want, loss: loss, nackRate: nackRate})
		}
	}
	r.mu.Unlock()

	for _, req := range reqs {
		r.switchLayer(req.subID, req.pubID, req.from, req.to, req.loss, req.nackRate)
	}
}

// switchLayer repoints one viewer's downlink from one simulcast layer to
// another, preserving the stable downlink IDs (kith-track-UID-video) so
// client tiles never orphan. UP: instant swap + cached-keyframe replay.
// DOWN: hold until the target layer's next keyframe (drop intermediates),
// with a PLI-forced fallback after keyframeWaitTimeout. loss/nackRate are
// the deciding snapshot values, logged for observability.
func (r *Router) switchLayer(subID, pubID, from, to string, loss, nackRate float64) {
	if from == to {
		return
	}
	direction := "up"
	if layerRank[to] < layerRank[from] {
		direction = "down"
	}

	r.mu.Lock()
	subMap := r.subscribers[subID]
	if subMap == nil {
		r.mu.Unlock()
		return
	}
	fromKey := pubID + ":video:" + from
	toKey := pubID + ":video:" + to
	oldEntry, ok := subMap[fromKey]
	if !ok || oldEntry == nil || oldEntry.downlink == nil {
		r.mu.Unlock()
		return
	}
	target, ok := r.publishers[toKey]
	if !ok || target == nil || target.IsClosed() {
		r.mu.Unlock()
		return
	}
	pe, ok := r.peers[subID]
	if !ok || pe == nil || pe.peer == nil {
		r.mu.Unlock()
		return
	}

	// DOWN gating: need a fresh keyframe on the target layer first (issue
	// rule: drop intermediates until the next keyframe to prevent decoder
	// corruption). #81's cache usually has one already. The switch path
	// uses a tighter freshness bound than initial joins: a stale anchor
	// desyncs the decoder until the next natural keyframe.
	if direction == "down" {
		if cached := target.cachedKeyframeMaxAge(switchReplayMaxAge); len(cached) == 0 {
			target.requestPLI(&rtcp.PictureLossIndication{})
			r.mu.Unlock()
			// Retry on the next evaluation tick (cooldown was already
			// stamped above, so this re-arms at most once per interval
			// without spinning: reset cooldown to allow the retry).
			r.mu.Lock()
			delete(r.switchCooldown, switchCooldownKey(subID, pubID))
			r.mu.Unlock()
			return
		}
	}

	// Build the replacement downlink on the target layer. Same stable IDs
	// (DownlinkTrackID/StreamID are kind-derived, not layer-derived), so
	// the viewer's tile/stream identity survives the switch.
	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		target.CodecCap,
		target.DownlinkTrackID(pubID),
		target.DownlinkStreamID(pubID),
	)
	if err != nil {
		slog.Error("Layer switch: failed to create track", "sub_id", subID, "pub_id", pubID, "to", to, "err", err)
		r.mu.Unlock()
		return
	}
	sender, err := pe.peer.AddTrack(trackLocal)
	if err != nil {
		slog.Error("Layer switch: failed to add track", "sub_id", subID, "pub_id", pubID, "to", to, "err", err)
		r.mu.Unlock()
		return
	}
	downlink := NewSubscriberDownlink(subID, pubID, trackLocal, sender)
	downlink.SetScreen(target.IsScreen)
	downlink.SetLayer(to)

	// Prime the new downlink BEFORE AddSubscriber exposes it to the live
	// fan-out: downlink seq numbers are assigned in enqueue order, so any
	// live packet enqueued first would steal lower rewritten seqs and the
	// jitter buffer would drop the keyframe pieces as late. Replay first
	// guarantees the keyframe owns the lowest seqs on the fresh downlink.
	if cached := target.cachedKeyframeMaxAge(switchReplayMaxAge); len(cached) > 0 {
		for _, pkt := range cached {
			downlink.Enqueue(pkt)
		}
	}
	// Always request a fresh keyframe alongside the replay: the cache can
	// still be up to switchReplayMaxAge stale, and live deltas reference
	// newer state — without a fresh keyframe the decoder anchors on old
	// state and freezes until the next natural one. The PLI limiter
	// coalesces this for free.
	target.requestPLI(&rtcp.PictureLossIndication{})
	target.AddSubscriber(downlink)

	// Swap: detach the old sender track, close the old downlink, file the
	// new entry under the target key.
	oldEntry.downlink.Close()
	_ = pe.peer.RemoveTrack(oldEntry.sender)
	delete(subMap, fromKey)
	subMap[toKey] = &subscriberEntry{downlink: downlink, sender: sender}
	peerNeedsReneg := map[string]bool{subID: true}
	var peersToRenegotiate []string
	for sub := range peerNeedsReneg {
		peersToRenegotiate = append(peersToRenegotiate, sub)
	}
	r.mu.Unlock()

	metrics.LayerSwitches.WithLabelValues(direction).Inc()
	metrics.LayerDistribution.WithLabelValues(from).Dec()
	metrics.LayerDistribution.WithLabelValues(to).Inc()
	slog.Info("Layer switch", "sub_id", subID, "pub_id", pubID, "from", from, "to", to, "direction", direction,
		"loss", loss, "nack_rate", nackRate)
	for _, sub := range peersToRenegotiate {
		r.TriggerRenegotiation(sub)
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
		// Fresh subscriptions always start on the full layer; the eval
		// loop converges downward from there (#82).
		if uplink.Kind == webrtc.RTPCodecTypeVideo {
			downlink.SetLayer(layerOfKey(tKey))
			metrics.LayerDistribution.WithLabelValues(layerOfKey(tKey)).Inc()
		}
		uplink.AddSubscriber(downlink)

		// Instant render (#81): replay the cached keyframe into the fresh
		// downlink so the joiner decodes immediately instead of waiting out
		// the natural keyframe cadence. Replay goes through the normal
		// Enqueue path, so per-downlink seq rewriting + NACK translation
		// apply automatically. A stale/missing cache falls back to
		// PLI-immediate below.
		replayed := false
		if uplink.Kind == webrtc.RTPCodecTypeVideo {
			if cached := uplink.cachedKeyframe(); len(cached) > 0 {
				for _, pkt := range cached {
					downlink.Enqueue(pkt)
				}
				replayed = true
			}
		}

		if r.subscribers[subID] == nil {
			r.subscribers[subID] = make(map[string]*subscriberEntry)
		}
		r.subscribers[subID][tKey] = &subscriberEntry{
			downlink: downlink,
			sender:   sender,
		}
		peerNeedsReneg[subID] = true

		if uplink.Kind == webrtc.RTPCodecTypeVideo && !replayed {
			// No fresh cache: ask for a keyframe now (coalesced by the
			// limiter if several joiners land together).
			uplink.requestPLI(&rtcp.PictureLossIndication{})
		}
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
		if entry.downlink != nil && entry.downlink.Kind() == webrtc.RTPCodecTypeVideo {
			metrics.LayerDistribution.WithLabelValues(entry.downlink.GetLayer()).Dec()
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
		if pub.Kind == webrtc.RTPCodecTypeVideo {
			downlink.SetLayer(layerOfKey(tKey))
			metrics.LayerDistribution.WithLabelValues(layerOfKey(tKey)).Inc()
		}
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
	if r.cancel != nil {
		r.cancel()
	}

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
