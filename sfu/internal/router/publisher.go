package router

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// maxKeyframePackets bounds the cache: a 1080p VP8 keyframe is dozens of
// packets; 256 is generous headroom before we stop collecting (and drop the
// partial cache) rather than grow unbounded on a pathological stream.
const maxKeyframePackets = 256

// maxKeyframeAge bounds replay freshness: a keyframe older than this decodes
// to a stale frozen frame, so subscribers fall back to PLI-immediate.
const maxKeyframeAge = 2 * time.Second

// PublisherUplink manages an ingress track (audio or video) from a publisher and distributes RTP packets
// to all subscribed downlinks.
type PublisherUplink struct {
	PublisherID string
	TrackRemote *webrtc.TrackRemote
	Receiver    *webrtc.RTPReceiver

	TrackKey string
	Kind     webrtc.RTPCodecType
	TrackID  string
	StreamID string
	IsScreen bool
	CodecCap webrtc.RTPCodecCapability

	mu          sync.RWMutex
	subscribers map[string]*SubscriberDownlink
	rtcpWriter  func([]rtcp.Packet) error
	onDeath     func(trackKey string)

	// Keyframe cache (#81): latest full picture per uplink, replayed to
	// late joiners for instant rendering. Uplinks are per-layer already
	// (pubID:video:<rid>), so the cache is per-layer for free. Guarded by
	// keyMu (separate from mu: readingLoop writes, subscribe paths read).
	keyMu       sync.RWMutex
	keyframe    []*rtp.Packet
	keyframeAt  time.Time
	hasKeyframe bool

	// PLI limiter (#81): coalesces per-subscriber keyframe requests so a
	// join/leave storm can't stampede the publisher encoder. Guarded by
	// pliMu; installed once via ensurePLILimiter.
	pliMu      sync.Mutex
	pliLimiter *pliLimiter

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// NewPublisherUplink creates and starts a new publisher uplink reader.
func NewPublisherUplink(pubID string, trackRemote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) *PublisherUplink {
	ctx, cancel := context.WithCancel(context.Background())

	kind := webrtc.RTPCodecTypeAudio
	trackID := "kith-track-" + pubID
	streamID := "kith-stream-" + pubID
	isScreen := false
	codecCap := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}

	if trackRemote != nil {
		kind = trackRemote.Kind()
		trackID = trackRemote.ID()
		streamID = trackRemote.StreamID()
		// Codec() is populated on first RTP; fall back to a kind-correct
		// default when empty so downlink creation never poisons on an empty
		// capability (which would silently drop the subscriber). In production
		// OnTrack fires post-first-RTP so this branch is unreachable there.
		if cc := trackRemote.Codec().RTPCodecCapability; cc.MimeType != "" {
			codecCap = cc
		} else if kind == webrtc.RTPCodecTypeVideo {
			codecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}
		}
		// NOTE: no msid sniffing here by design. Under the negotiate-once
		// contract uplink SDP ids are browser-random; the screen label comes
		// from the declared kind flag (Router.SetVideoKind) applied by
		// AddPublisher after construction.
	}

	p := &PublisherUplink{
		PublisherID: pubID,
		TrackRemote: trackRemote,
		Receiver:    receiver,
		Kind:        kind,
		TrackID:     trackID,
		StreamID:    streamID,
		IsScreen:    isScreen,
		CodecCap:    codecCap,
		subscribers: make(map[string]*SubscriberDownlink),
		ctx:         ctx,
		cancel:      cancel,
	}

	if trackRemote != nil {
		go p.readingLoop()
	}
	return p
}

// SetRTCPWriter sets the function used to forward RTCP feedback packets to the publisher peer.
func (p *PublisherUplink) SetRTCPWriter(writer func([]rtcp.Packet) error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rtcpWriter = writer
}

// SendRTCP forwards RTCP packets (PLI, FIR, and translated NACKs) to the
// publisher. Rewrites MediaSSRC to match the publisher's incoming track
// SSRC. NACK sequences arrive pre-translated to uplink space (see
// seqTranslator); only the SSRC needs fixing here.
func (p *PublisherUplink) SendRTCP(pkts []rtcp.Packet) error {
	p.mu.RLock()
	writer := p.rtcpWriter
	track := p.TrackRemote
	p.mu.RUnlock()

	if writer == nil {
		return nil
	}

	if track != nil {
		mediaSSRC := uint32(track.SSRC())
		for _, pkt := range pkts {
			switch fb := pkt.(type) {
			case *rtcp.PictureLossIndication:
				fb.MediaSSRC = mediaSSRC
			case *rtcp.FullIntraRequest:
				fb.MediaSSRC = mediaSSRC
			case *rtcp.TransportLayerNack:
				fb.MediaSSRC = mediaSSRC
			}
		}
	}

	return writer(pkts)
}

// SetOnDeath configures the callback invoked (async) when the uplink dies
// (readingLoop EOF/error via Close). The router uses it to evict the map
// entry and tear down downlinks. Nil-safe; fired at most once via closeOnce.
func (p *PublisherUplink) SetOnDeath(cb func(trackKey string)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onDeath = cb
}

// IsClosed reports whether the uplink's reading loop has terminated.
func (p *PublisherUplink) IsClosed() bool {
	select {
	case <-p.ctx.Done():
		return true
	default:
		return false
	}
}

// DownlinkTrackID returns the unique track ID for downstream subscribers.
// Screen-ness comes from the IsScreen label (declared kind), never from SDP.
func (p *PublisherUplink) DownlinkTrackID(pubID string) string {
	if p.IsScreen {
		return fmt.Sprintf("kith-track-%s-screen", pubID)
	}
	// Stable camera id: never embed the browser's random uplink track id —
	// viewers must be able to parse the uid back from the downlink id (R9).
	if p.Kind == webrtc.RTPCodecTypeVideo {
		return fmt.Sprintf("kith-track-%s-video", pubID)
	}
	if p.TrackRemote != nil && p.TrackRemote.ID() != "" {
		return fmt.Sprintf("kith-track-%s-%s", pubID, p.TrackRemote.ID())
	}
	return fmt.Sprintf("kith-track-%s", pubID)
}

// DownlinkStreamID returns the shared stream ID for all tracks of this publisher.
// Screen-ness comes from the IsScreen label (declared kind), never from SDP.
func (p *PublisherUplink) DownlinkStreamID(pubID string) string {
	if p.IsScreen {
		return fmt.Sprintf("kith-screen-%s", pubID)
	}
	return fmt.Sprintf("kith-stream-%s", pubID)
}

// AddSubscriber adds or updates a subscriber downlink for this publisher.
func (p *PublisherUplink) AddSubscriber(sub *SubscriberDownlink) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if existing, ok := p.subscribers[sub.SubscriberID]; ok {
		existing.Close()
	}
	p.subscribers[sub.SubscriberID] = sub
	p.ensurePLILimiter()
	sub.SetFeedbackUplink(p)
	sub.SetOnFeedback(func(pkts []rtcp.Packet) {
		_ = p.SendRTCP(pkts)
	})
}

// RemoveSubscriber removes and closes a subscriber downlink by ID.
func (p *PublisherUplink) RemoveSubscriber(subID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if sub, ok := p.subscribers[subID]; ok {
		sub.SetOnFeedback(nil)
		sub.Close()
		delete(p.subscribers, subID)
	}
}

// readingLoop reads RTP packets from the remote track and fans them out to all subscribers.
// Packets Pion repaired from the publisher's RTX stream arrive here rewritten
// to look exactly like the original (primary SSRC/seq/PT) plus RTX marker
// attributes — they are routed to deliverRepair instead of the normal
// fan-out, because a fresh downlink seq would arrive as an out-of-window
// duplicate instead of filling the viewer's gap.
func (p *PublisherUplink) readingLoop() {
	defer func() {
		slog.Debug("Publisher reading loop terminated", "publisher_id", p.PublisherID)
	}()

	for {
		select {
		case <-p.ctx.Done():
			return
		default:
			pkt, attrs, err := p.TrackRemote.ReadRTP()
			if err != nil {
				if err != io.EOF {
					slog.Warn("Failed to read RTP from publisher", "publisher_id", p.PublisherID, "err", err)
				} else {
					slog.Info("Publisher track reached EOF", "publisher_id", p.PublisherID)
				}
				p.Close()
				return
			}

			if isRepairPacket(attrs) {
				metrics.RTXRepaired.Inc()
				p.deliverRepair(pkt)
				continue
			}

			p.mu.RLock()
			for _, sub := range p.subscribers {
				// Deep-copy packet to allow independent sequence number rewriting per subscriber
				sub.Enqueue(pkt.Clone())
			}
			p.mu.RUnlock()

			p.observeKeyframe(pkt)
		}
	}
}

// IsRTXTrack reports whether a remote track is an RTX retransmission
// stream rather than a media uplink (checked via codec, with empty-codec
// tracks allowed through — codec is unset pre-first-RTP).
func IsRTXTrack(track *webrtc.TrackRemote) bool {
	if track == nil {
		return false
	}
	mime := track.Codec().MimeType
	return mime != "" && mime == webrtc.MimeTypeRTX
}

// isRepairPacket reports whether Pion surfaced this packet from the
// publisher's RTX repair stream rather than the primary. The header is
// already rewritten to the original (primary SSRC/seq/PT); only the
// interceptor attributes betray its origin.
func isRepairPacket(attrs interceptor.Attributes) bool {
	if attrs == nil {
		return false
	}
	return attrs.Get(webrtc.AttributeRtxPayloadType) != nil
}

// repairForDownlink clones a repaired uplink packet for one subscriber,
// stamped with the exact missing downlink seq so the viewer jitter buffer
// fills the hole. SSRC, timestamp and payload pass through untouched — only
// the sequence number is rewritten, mirroring what the packet would have
// carried had it arrived live in that slot.
func repairForDownlink(pkt *rtp.Packet, downSeq uint16) *rtp.Packet {
	repair := pkt.Clone()
	repair.Header.SequenceNumber = downSeq
	return repair
}

// deliverRepair writes a retransmitted packet to every subscriber downlink
// whose translator maps its uplink seq to a missing downlink seq — i.e. the
// viewers that actually lost it. Viewers with no mapping (never missed it,
// aged out) are skipped, since an identical-seq duplicate would be pointless
// traffic. Direct TrackLocal writes bypass the inbox (retransmits are late
// by nature and must not consume fresh seqs or disturb ordering); WriteRTP
// is internally locked.
func (p *PublisherUplink) deliverRepair(pkt *rtp.Packet) {
	upSeq := pkt.Header.SequenceNumber
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, sub := range p.subscribers {
		downSeq, ok := sub.seqTr.lookupDown(upSeq)
		if !ok {
			metrics.RTXUnmatched.Inc()
			continue
		}
		if err := sub.TrackLocal.WriteRTP(repairForDownlink(pkt, downSeq)); err != nil {
			slog.Debug("Repair write failed",
				"subscriber_id", sub.SubscriberID,
				"publisher_id", p.PublisherID,
				"err", err,
			)
			continue
		}
		metrics.RTXForwarded.Inc()
	}
}

// observeKeyframe maintains the latest-keyframe cache for video uplinks.
// Detection runs on the readingLoop goroutine; cache writes take keyMu, so
// subscribe-time replay never races the ingest path.
func (p *PublisherUplink) observeKeyframe(pkt *rtp.Packet) {
	if p.Kind != webrtc.RTPCodecTypeVideo || pkt == nil {
		return
	}
	detector := DetectorFor(p.CodecCap.MimeType)
	if detector == nil {
		return
	}
	p.keyMu.Lock()
	defer p.keyMu.Unlock()

	if detector.IsKeyframeStart(pkt.Payload) {
		// New keyframe: rotate (drop the old frame's packets).
		p.keyframe = p.keyframe[:0]
		p.hasKeyframe = false
	}
	if !p.hasKeyframe && len(p.keyframe) < maxKeyframePackets {
		// Collecting the current frame — but only while it could still be
		// the keyframe we just detected: any non-keyframe-start packet
		// after the first one belongs to the same keyframe frame ONLY if
		// we are already collecting (rotated above). A fresh non-start
		// packet with an empty cache means the keyframe start was missed
		// (joined mid-frame, packet loss): don't cache a partial frame.
		if len(p.keyframe) == 0 && !detector.IsKeyframeStart(pkt.Payload) {
			return
		}
		p.keyframe = append(p.keyframe, pkt.Clone())
		p.keyframeAt = time.Now()
		// Heuristic frame end: RTP marker bit closes the frame. Until then
		// we keep collecting; the next keyframe start rotates anyway.
		if pkt.Header.Marker {
			p.hasKeyframe = true
		}
		return
	}
	// Cache full and complete: a new keyframe start rotates at the top on
	// the next call. Non-start packets are just forwarded (handled above).
	if len(p.keyframe) >= maxKeyframePackets {
		p.keyframe = p.keyframe[:0]
		p.hasKeyframe = false
	}
}

// cachedKeyframe returns clones of the cached keyframe packets when fresh,
// or nil when there is nothing (or nothing fresh) to replay.
func (p *PublisherUplink) cachedKeyframe() []*rtp.Packet {
	return p.cachedKeyframeMaxAge(maxKeyframeAge)
}

// cachedKeyframeMaxAge is cachedKeyframe with a caller-chosen freshness
// bound. Layer switches use a tighter bound than initial joins: replaying
// a stale anchor while live deltas reference newer state desyncs the
// decoder until the next natural keyframe.
func (p *PublisherUplink) cachedKeyframeMaxAge(maxAge time.Duration) []*rtp.Packet {
	p.keyMu.RLock()
	defer p.keyMu.RUnlock()
	if !p.hasKeyframe || len(p.keyframe) == 0 {
		return nil
	}
	if time.Since(p.keyframeAt) > maxAge {
		return nil
	}
	out := make([]*rtp.Packet, len(p.keyframe))
	for i, pkt := range p.keyframe {
		out[i] = pkt.Clone()
	}
	return out
}

// Close gracefully closes the publisher reading loop and all attached subscribers.
// Notifies the router via onDeath (async, at most once) so the map entry is
// evicted and downlinks are torn down even without an explicit remove (R5).
func (p *PublisherUplink) Close() {
	p.closeOnce.Do(func() {
		if p.cancel != nil {
			p.cancel()
		}
		p.pliMu.Lock()
		if p.pliLimiter != nil {
			p.pliLimiter.stop()
		}
		p.pliMu.Unlock()
		p.mu.Lock()
		for id, sub := range p.subscribers {
			sub.Close()
			delete(p.subscribers, id)
		}
		cb := p.onDeath
		tKey := p.TrackKey
		p.mu.Unlock()
		if cb != nil && tKey != "" {
			go cb(tKey)
		}
	})
}
