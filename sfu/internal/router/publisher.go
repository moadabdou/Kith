package router

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
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
		codecCap = trackRemote.Codec().RTPCodecCapability
		if strings.HasPrefix(streamID, "kith-screen-") || strings.Contains(trackID, "-screen") {
			isScreen = true
		}
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

// SendRTCP forwards RTCP packets (such as PLI and FIR) to the publisher.
// Rewrites MediaSSRC to match the publisher's incoming track SSRC.
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
			}
		}
	}

	return writer(pkts)
}

// DownlinkTrackID returns the unique track ID for downstream subscribers.
func (p *PublisherUplink) DownlinkTrackID(pubID string) string {
	if p.IsScreen || strings.HasPrefix(p.StreamID, "kith-screen-") || strings.Contains(p.TrackID, "-screen") {
		return fmt.Sprintf("kith-track-%s-screen", pubID)
	}
	if p.TrackRemote != nil && p.TrackRemote.ID() != "" {
		return fmt.Sprintf("kith-track-%s-%s", pubID, p.TrackRemote.ID())
	}
	if p.Kind == webrtc.RTPCodecTypeVideo {
		return fmt.Sprintf("kith-track-%s-video", pubID)
	}
	return fmt.Sprintf("kith-track-%s", pubID)
}

// DownlinkStreamID returns the shared stream ID for all tracks of this publisher.
func (p *PublisherUplink) DownlinkStreamID(pubID string) string {
	if p.IsScreen || strings.HasPrefix(p.StreamID, "kith-screen-") {
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
func (p *PublisherUplink) Close() {
	p.closeOnce.Do(func() {
		if p.cancel != nil {
			p.cancel()
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		for id, sub := range p.subscribers {
			sub.Close()
			delete(p.subscribers, id)
		}
	})
}
