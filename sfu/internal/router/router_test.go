package router

import (
	"context"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	dto "github.com/prometheus/client_model/go"
)

func getCounterValue(counter metricsCollector) float64 {
	var m dto.Metric
	_ = counter.Write(&m)
	return m.GetCounter().GetValue()
}

type metricsCollector interface {
	Write(*dto.Metric) error
}

func TestSubscriberDownlink_BackpressureDrop(t *testing.T) {
	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio-track",
		"audio-stream",
	)
	if err != nil {
		t.Fatalf("failed to create track local: %v", err)
	}

	// Create downlink with paused forwarding loop to fill inbox
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sub := &SubscriberDownlink{
		SubscriberID: "sub-1",
		PublisherID:  "pub-1",
		TrackLocal:   trackLocal,
		inbox:        make(chan *rtp.Packet, queueCapacity),
		ctx:          ctx,
		cancel:       cancel,
	}

	initialDropped := getCounterValue(metrics.PacketsDropped)

	// Fill queue to capacity (100 packets)
	for i := 0; i < queueCapacity; i++ {
		pkt := &rtp.Packet{
			Header: rtp.Header{
				SequenceNumber: uint16(i),
				Timestamp:      uint32(i * 960),
			},
			Payload: []byte{0x01, 0x02, 0x03},
		}
		if !sub.Enqueue(pkt) {
			t.Fatalf("expected packet %d to be enqueued", i)
		}
	}

	// 101st packet must be dropped without blocking
	overflowPkt := &rtp.Packet{
		Header: rtp.Header{
			SequenceNumber: 999,
		},
		Payload: []byte{0x01},
	}

	enqueued := sub.Enqueue(overflowPkt)
	if enqueued {
		t.Errorf("expected overflow packet to be dropped, but was enqueued")
	}

	newDropped := getCounterValue(metrics.PacketsDropped)
	if newDropped <= initialDropped {
		t.Errorf("expected PacketsDropped metric to increase, got %f vs %f", newDropped, initialDropped)
	}
}

func TestSubscriberDownlink_SequenceRewriting(t *testing.T) {
	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		"audio-track",
		"audio-stream",
	)
	if err != nil {
		t.Fatalf("failed to create track local: %v", err)
	}

	sub := NewSubscriberDownlink("sub-seq", "pub-seq", trackLocal, nil)
	defer sub.Close()

	// Enqueue 5 packets with non-consecutive sequence numbers
	seqs := []uint16{10, 45, 100, 250, 999}
	for _, seq := range seqs {
		pkt := &rtp.Packet{
			Header: rtp.Header{
				SequenceNumber: seq,
				Timestamp:      1000,
			},
			Payload: []byte{0xAA, 0xBB},
		}
		sub.Enqueue(pkt)
	}

	// Wait briefly for forwarding loop to process
	time.Sleep(50 * time.Millisecond)

	// In the downlink, seq counter should have monotonically incremented to 5
	if sub.Sequence() != 5 {
		t.Errorf("expected internal sequence counter to be 5, got %d", sub.Sequence())
	}
}

func TestPublisherUplink_FanoutAndCloning(t *testing.T) {
	trackLocal1, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "track-1", "stream-1",
	)
	trackLocal2, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "track-2", "stream-2",
	)

	sub1 := NewSubscriberDownlink("sub-1", "pub-1", trackLocal1, nil)
	defer sub1.Close()
	sub2 := NewSubscriberDownlink("sub-2", "pub-1", trackLocal2, nil)
	defer sub2.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	uplink := &PublisherUplink{
		PublisherID: "pub-1",
		subscribers: make(map[string]*SubscriberDownlink),
		ctx:         ctx,
		cancel:      cancel,
	}

	uplink.AddSubscriber(sub1)
	uplink.AddSubscriber(sub2)

	// Simulate receiving a packet and fanning out
	origPkt := &rtp.Packet{
		Header: rtp.Header{
			SequenceNumber: 50,
			Timestamp:      12345,
		},
		Payload: []byte{0x10, 0x20, 0x30},
	}

	uplink.mu.RLock()
	for _, sub := range uplink.subscribers {
		sub.Enqueue(origPkt.Clone())
	}
	uplink.mu.RUnlock()

	time.Sleep(50 * time.Millisecond)

	// Both subscribers should have processed 1 packet independently
	if sub1.Sequence() != 1 {
		t.Errorf("expected sub1.seq to be 1, got %d", sub1.Sequence())
	}
	if sub2.Sequence() != 1 {
		t.Errorf("expected sub2.seq to be 1, got %d", sub2.Sequence())
	}
}

func TestRouter_Lifecycle(t *testing.T) {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create webrtc api: %v", err)
	}

	rtcCfg := webrtc.Configuration{}
	peer1, err := peer.NewPeer(api, rtcCfg, "user_1", "sess_1", "chan_test", "guild_test")
	if err != nil {
		t.Fatalf("failed to create peer1: %v", err)
	}
	defer peer1.Close()
	go func() {
		for range peer1.Candidates {
		}
	}()

	peer2, err := peer.NewPeer(api, rtcCfg, "user_2", "sess_2", "chan_test", "guild_test")
	if err != nil {
		t.Fatalf("failed to create peer2: %v", err)
	}
	defer peer2.Close()
	go func() {
		for range peer2.Candidates {
		}
	}()

	r := NewRouter("chan_test")
	defer r.Close()

	reneg1Called := make(chan struct{}, 1)
	reneg2Called := make(chan struct{}, 1)

	r.AddPeer(peer1, func(offer webrtc.SessionDescription) {
		select {
		case reneg1Called <- struct{}{}:
		default:
		}
	})

	r.AddPeer(peer2, func(offer webrtc.SessionDescription) {
		select {
		case reneg2Called <- struct{}{}:
		default:
		}
	})

	// Add track to peer 1 and create local offer/answer so peer 1 and peer 2 are in stable state
	track1, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "pion",
	)
	if err != nil {
		t.Fatalf("failed to create track1: %v", err)
	}
	_, err = peer1.AddTrack(track1)
	if err != nil {
		t.Fatalf("failed to add track to peer1: %v", err)
	}

	// Trigger initial offer on peer1 to make it stable
	offer1, err := peer1.CreateOffer()
	if err != nil {
		t.Fatalf("failed to create initial offer for peer1: %v", err)
	}
	answer2, err := peer2.HandleOffer(offer1.SDP)
	if err != nil {
		t.Fatalf("failed to handle offer on peer2: %v", err)
	}
	err = peer1.HandleAnswer(answer2.SDP)
	if err != nil {
		t.Fatalf("failed to handle answer on peer1: %v", err)
	}

	// Now both peer1 and peer2 are in SignalingStateStable!
	// Remove peer1 from router
	r.RemovePeer("user_1")

	r.mu.RLock()
	if _, ok := r.peers["user_1"]; ok {
		t.Errorf("user_1 should have been removed from peers")
	}
	if len(r.subscribers["user_1"]) > 0 {
		t.Errorf("user_1 subscriber entries should have been removed")
	}
	r.mu.RUnlock()
}

func TestRouter_PostponedRenegotiation(t *testing.T) {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create api: %v", err)
	}

	p, err := peer.NewPeer(api, webrtc.Configuration{}, "user_retry", "sess_retry", "chan_retry", "guild_retry")
	if err != nil {
		t.Fatalf("failed to create peer: %v", err)
	}
	defer p.Close()
	go func() {
		for range p.Candidates {
		}
	}()

	r := NewRouter("chan_retry")
	defer r.Close()

	renegFired := make(chan struct{}, 2)
	r.AddPeer(p, func(offer webrtc.SessionDescription) {
		renegFired <- struct{}{}
	})

	// Put peer into HaveLocalOffer state by creating an initial offer
	track, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "stream",
	)
	_, _ = p.AddTrack(track)
	initialOffer, err := p.CreateOffer()
	if err != nil {
		t.Fatalf("failed to create initial offer: %v", err)
	}

	// Now signaling state is HaveLocalOffer (NOT Stable)
	if p.PC.SignalingState() == webrtc.SignalingStateStable {
		t.Fatalf("expected state to be non-stable, got %s", p.PC.SignalingState())
	}

	// Trigger renegotiation while unstable -> should be queued in renegotiationPending
	r.TriggerRenegotiation("user_retry")

	r.mu.RLock()
	entry := r.peers["user_retry"]
	pending := entry != nil && entry.renegotiationPending
	r.mu.RUnlock()

	if !pending {
		t.Errorf("expected renegotiationPending to be true while peer is unstable")
	}

	// Now simulate remote answer arriving using a dummy answerer
	answerer, _ := peer.NewPeer(api, webrtc.Configuration{}, "user_mock", "sess_mock", "chan_retry", "guild_retry")
	defer answerer.Close()
	go func() {
		for range answerer.Candidates {
		}
	}()
	mockAnswer, err := answerer.HandleOffer(initialOffer.SDP)
	if err != nil {
		t.Fatalf("failed to handle offer on mock answerer: %v", err)
	}

	// Handle answer on p -> transitions state back to Stable!
	if err := p.HandleAnswer(mockAnswer.SDP); err != nil {
		t.Fatalf("failed to handle answer: %v", err)
	}

	// Verify that the postponed renegotiation fires!
	select {
	case <-renegFired:
		// Successfully executed postponed renegotiation!
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for postponed renegotiation to fire after returning to Stable")
	}
}
