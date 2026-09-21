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
					}

				case *rtcp.TransportLayerNack:
					metrics.RTCPNackTotal.Inc()
					s.forwardNack(report)

				case *rtcp.PictureLossIndication:
					metrics.RTCPPLITotal.Inc()
					s.feedbackMu.RLock()
					cb := s.onFeedback
					s.feedbackMu.RUnlock()
					if cb != nil {
						cb([]rtcp.Packet{report})
					}

				case *rtcp.FullIntraRequest:
					metrics.RTCPFIRTotal.Inc()
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

// SetScreen records whether this downlink carries a screen share (mirrors
// the uplink label; used for per-kind teardown).
func (s *SubscriberDownlink) SetScreen(screen bool) {
	s.isScreen = screen
}

// IsScreen reports whether this downlink carries a screen share.
func (s *SubscriberDownlink) IsScreen() bool {
	return s.isScreen
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
