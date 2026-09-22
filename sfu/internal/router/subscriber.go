package router

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const queueCapacity = 100

// SubscriberDownlink manages an egress downlink track sending audio to a subscriber.
type SubscriberDownlink struct {
	SubscriberID string
	PublisherID  string
	TrackLocal   *webrtc.TrackLocalStaticRTP
	RTPSender    *webrtc.RTPSender

	// isScreen mirrors the publisher uplink's label at creation: screen vs
	// camera downlinks carry different stable IDs and are torn down per kind.
	isScreen bool

	inbox chan *rtp.Packet
	seq   uint32 // atomic sequence number counter

	// seqTr maps rewritten downlink seqs back to uplink seqs for NACK
	// translation (lock-free; see seq_translator.go).
	seqTr seqTranslator

	feedbackMu sync.RWMutex
	onFeedback func([]rtcp.Packet)
	// feedbackUplink is the publisher uplink owning this downlink, used to
	// route PLI/FIR through the per-publisher limiter (#81). Set at
	// subscribe time; nil-safe (falls back to direct forward).
	feedbackUplink *PublisherUplink

	// score is the smoothed downlink health for layer selection (#82).
	// Updated by rtcpLoop, read by the router evaluation ticker.
	score downlinkScore
	// layer is the simulcast RID this downlink currently forwards.
	// Guarded by feedbackMu (written under router lock at switch time).
	layer string

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// NewSubscriberDownlink initializes a new subscriber downlink track and workers.
func NewSubscriberDownlink(subID, pubID string, trackLocal *webrtc.TrackLocalStaticRTP, sender *webrtc.RTPSender) *SubscriberDownlink {
	ctx, cancel := context.WithCancel(context.Background())
	s := &SubscriberDownlink{
		SubscriberID: subID,
		PublisherID:  pubID,
		TrackLocal:   trackLocal,
		RTPSender:    sender,
		inbox:        make(chan *rtp.Packet, queueCapacity),
		ctx:          ctx,
		cancel:       cancel,
	}

	go s.forwardingLoop()
	if sender != nil {
		go s.rtcpLoop()
	}

	return s
}

// Enqueue puts an RTP packet into the subscriber's backpressure queue without blocking.
// Returns false and increments drop metric if the queue is saturated.
func (s *SubscriberDownlink) Enqueue(pkt *rtp.Packet) bool {
	select {
	case <-s.ctx.Done():
		return false
	case s.inbox <- pkt:
		metrics.SubQueueDepth.Set(float64(len(s.inbox)))
		return true
	default:
		metrics.PacketsDropped.Inc()
		slog.Debug("Subscriber queue saturated, dropping frame",
			"subscriber_id", s.SubscriberID,
			"publisher_id", s.PublisherID,
		)
		return false
	}
}

// forwardingLoop processes queued packets, rewrites sequence numbers, and writes to TrackLocal.
func (s *SubscriberDownlink) forwardingLoop() {
	defer func() {
		slog.Debug("Subscriber forwarding loop terminated",
			"subscriber_id", s.SubscriberID,
			"publisher_id", s.PublisherID,
		)
	}()

	for {
		select {
		case <-s.ctx.Done():
			return

		case pkt, ok := <-s.inbox:
			if !ok {
				return
			}

			// Rewrite monotonic sequence number per subscriber downlink to ensure smooth jitter buffer.
			// Record the mapping first (pkt still carries the uplink seq here)
			// so viewer NACKs can be translated back for the publisher.
			newSeq := uint16(atomic.AddUint32(&s.seq, 1))
			s.seqTr.note(newSeq, pkt.Header.SequenceNumber)
			pkt.Header.SequenceNumber = newSeq

			if err := s.TrackLocal.WriteRTP(pkt); err != nil {
				slog.Warn("Failed to write RTP to subscriber track",
					"subscriber_id", s.SubscriberID,
					"publisher_id", s.PublisherID,
					"err", err,
				)
				continue
			}

			metrics.PacketsForwarded.Inc()
		}
	}
}

// rtcpLoop reads incoming RTCP feedback (Receiver Reports, NACK) from the subscriber.
func (s *SubscriberDownlink) rtcpLoop() {
	for {
		select {
		case <-s.ctx.Done():
			return
		default:
			pkts, _, err := s.RTPSender.ReadRTCP()
			if err != nil {
				return
			}

			for _, p := range pkts {
				switch report := p.(type) {
				case *rtcp.ReceiverReport:
					for _, r := range report.Reports {
						// FractionLost is fixed point fraction of 256
						lossRate := float64(r.FractionLost) / 256.0
						metrics.FractionLost.Set(lossRate)
						// Feed the layer selector (#82). Clock rate is
						// video-typical 90kHz here; audio reports share the
						// path but audio downlinks are never layer-switched.
						s.score.observeRR(r.FractionLost, r.Jitter, 90000)
					}

				case *rtcp.TransportLayerNack:
					metrics.RTCPNackTotal.Inc()
					s.score.observeNack()
					s.forwardNack(report)

				case *rtcp.PictureLossIndication:
					metrics.RTCPPLITotal.Inc()
					// Route through the uplink PLI limiter (#81): storms
					// coalesce instead of stampeding the publisher encoder.
					// Fall back to direct forward when the uplink is gone
					// (e.g. publisher left mid-feedback).
					if up := uplinkForFeedback(s); up != nil {
						up.requestPLI(report)
					} else {
						s.feedbackMu.RLock()
						cb := s.onFeedback
						s.feedbackMu.RUnlock()
						if cb != nil {
							cb([]rtcp.Packet{report})
						}
					}

				case *rtcp.FullIntraRequest:
					metrics.RTCPFIRTotal.Inc()
					if up := uplinkForFeedback(s); up != nil {
						up.requestFIR(report)
					} else {
						s.feedbackMu.RLock()
						cb := s.onFeedback
						s.feedbackMu.RUnlock()
						if cb != nil {
							cb([]rtcp.Packet{report})
						}
					}
				}
			}
		}
	}
}

// SetScreen records whether this downlink carries a screen share (mirrors
// the uplink label; used for per-kind teardown).
func (s *SubscriberDownlink) SetScreen(screen bool) {
	s.isScreen = screen
}

// IsScreen reports whether this downlink carries a screen share.
func (s *SubscriberDownlink) IsScreen() bool {
	return s.isScreen
}

// Kind reports the codec kind of this downlink (audio/video).
// Used for metric bookkeeping on teardown.
func (s *SubscriberDownlink) Kind() webrtc.RTPCodecType {
	if s.TrackLocal != nil {
		return s.TrackLocal.Kind()
	}
	return webrtc.RTPCodecTypeVideo
}

// forwardNack translates a viewer NACK from downlink to uplink sequence
// space and forwards it to the publisher for retransmission (~50ms repair
// instead of a keyframe wait). Untranslatable entries (aged out / dropped
// pre-forward) are skipped; a fully untranslatable NACK is dropped.
func (s *SubscriberDownlink) forwardNack(nack *rtcp.TransportLayerNack) {
	if nack == nil {
		return
	}
	translated := translateNackPairs(nack.Nacks, s.seqTr.lookup)
	if len(translated) == 0 {
		return
	}
	metrics.RTCPNackForwarded.Inc()
	fwd := &rtcp.TransportLayerNack{
		SenderSSRC: nack.SenderSSRC,
		MediaSSRC:  nack.MediaSSRC, // rewritten to uplink SSRC by SendRTCP
		Nacks:      translated,
	}
	s.feedbackMu.RLock()
	cb := s.onFeedback
	s.feedbackMu.RUnlock()
	if cb != nil {
		cb([]rtcp.Packet{fwd})
	}
}

// uplinkForFeedback resolves the publisher uplink owning this downlink's
// feedback path. The downlink's onFeedback closure is installed by
// AddSubscriber on the uplink, so we recover the uplink via the callback's
// target: stored explicitly at subscribe time (see feedbackUplink).
func (s *SubscriberDownlink) feedbackTarget() *PublisherUplink {
	s.feedbackMu.RLock()
	defer s.feedbackMu.RUnlock()
	return s.feedbackUplink
}

// SetFeedbackUplink records the publisher uplink for limiter-routed PLI/FIR.
func (s *SubscriberDownlink) SetFeedbackUplink(up *PublisherUplink) {
	s.feedbackMu.Lock()
	defer s.feedbackMu.Unlock()
	s.feedbackUplink = up
}

// SetLayer records the simulcast RID this downlink forwards (#82).
func (s *SubscriberDownlink) SetLayer(layer string) {
	s.feedbackMu.Lock()
	defer s.feedbackMu.Unlock()
	s.layer = layer
}

// GetLayer returns the simulcast RID this downlink forwards.
func (s *SubscriberDownlink) GetLayer() string {
	s.feedbackMu.RLock()
	defer s.feedbackMu.RUnlock()
	if s.layer == "" {
		return LayerFull
	}
	return s.layer
}

// ScoreSnapshot returns the smoothed downlink health for layer selection,
// including NACKs/sec repair effort.
func (s *SubscriberDownlink) ScoreSnapshot() (loss, jitterMs float64, goodWindows int, nacks uint64, nackRate float64) {
	return s.score.snapshot()
}

// uplinkForFeedback is the package-level lookup used by the rtcpLoop.
func uplinkForFeedback(s *SubscriberDownlink) *PublisherUplink {
	if s == nil {
		return nil
	}
	return s.feedbackTarget()
}

// SetOnFeedback configures the callback for RTCP feedback (e.g., PLI, FIR) to forward to publisher.
func (s *SubscriberDownlink) SetOnFeedback(cb func([]rtcp.Packet)) {
	s.feedbackMu.Lock()
	defer s.feedbackMu.Unlock()
	s.onFeedback = cb
}

// Sequence returns the current sequence number counter value safely.
func (s *SubscriberDownlink) Sequence() uint32 {
	return atomic.LoadUint32(&s.seq)
}

// Close terminates the worker and drains the queue.
func (s *SubscriberDownlink) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
		s.SetOnFeedback(nil)
	})
}
