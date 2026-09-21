package router

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

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
func (p *PublisherUplink) readingLoop() {
	defer func() {
		slog.Debug("Publisher reading loop terminated", "publisher_id", p.PublisherID)
	}()

	for {
		select {
		case <-p.ctx.Done():
			return
		default:
			pkt, _, err := p.TrackRemote.ReadRTP()
			if err != nil {
				if err != io.EOF {
					slog.Warn("Failed to read RTP from publisher", "publisher_id", p.PublisherID, "err", err)
				} else {
					slog.Info("Publisher track reached EOF", "publisher_id", p.PublisherID)
				}
				p.Close()
				return
			}

			p.mu.RLock()
			for _, sub := range p.subscribers {
				// Deep-copy packet to allow independent sequence number rewriting per subscriber
				sub.Enqueue(pkt.Clone())
			}
			p.mu.RUnlock()
		}
	}
}

// Close gracefully closes the publisher reading loop and all attached subscribers.
// Notifies the router via onDeath (async, at most once) so the map entry is
// evicted and downlinks are torn down even without an explicit remove (R5).
func (p *PublisherUplink) Close() {
	p.closeOnce.Do(func() {
		if p.cancel != nil {
			p.cancel()
		}
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
