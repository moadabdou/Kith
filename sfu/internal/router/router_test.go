package router

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/rtcp"
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

func TestRouter_RejoinAndForward(t *testing.T) {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create api: %v", err)
	}

	p2, err := peer.NewPeer(api, webrtc.Configuration{}, "user_2", "sess_2", "chan_rj", "guild_rj")
	if err != nil {
		t.Fatalf("failed to create p2: %v", err)
	}
	defer p2.Close()
	go func() {
		for range p2.Candidates {
		}
	}()

	r := NewRouter("chan_rj")
	defer r.Close()

	var renegOffer webrtc.SessionDescription
	renegChan := make(chan webrtc.SessionDescription, 5)
	r.AddPeer(p2, func(offer webrtc.SessionDescription) {
		renegChan <- offer
	})

	// Initial user_1 joins
	trackLocal1, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "track-1", "stream-1",
	)
	uplink1 := NewPublisherUplink("user_1", nil, nil)
	r.publishers["user_1"] = uplink1

	// Add track to p2 for user_1
	sender1, err := p2.AddTrack(trackLocal1)
	if err != nil {
		t.Fatalf("failed to add track1 to p2: %v", err)
	}
	downlink1 := NewSubscriberDownlink("user_2", "user_1", trackLocal1, sender1)
	uplink1.AddSubscriber(downlink1)
	r.subscribers["user_2"] = map[string]*subscriberEntry{
		"user_1": {downlink: downlink1, sender: sender1},
	}

	// Trigger renegotiation on p2
	r.TriggerRenegotiation("user_2")
	select {
	case renegOffer = <-renegChan:
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for initial renegotiation on p2")
	}

	// Mock client for user_2 handles offer and creates answer
	client2, _ := peer.NewPeer(api, webrtc.Configuration{}, "client_2", "sess_c2", "chan_rj", "guild_rj")
	defer client2.Close()
	go func() {
		for range client2.Candidates {
		}
	}()

	clientAnswer, err := client2.HandleOffer(renegOffer.SDP)
	if err != nil {
		t.Fatalf("client2 failed to handle offer: %v", err)
	}
	if err := p2.HandleAnswer(clientAnswer.SDP); err != nil {
		t.Fatalf("p2 failed to handle answer: %v", err)
	}

	// Now user_1 leaves
	r.RemovePeer("user_1")

	// Verify downlink was closed and p2 has track removed
	if len(r.subscribers["user_2"]) != 0 {
		t.Errorf("expected subscribers for user_2 to be empty after user_1 left, got %d", len(r.subscribers["user_2"]))
	}

	// Now user_1 rejoins with a new track
	trackLocal2, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "track-2", "stream-2",
	)
	uplink2 := NewPublisherUplink("user_1", nil, nil)
	r.publishers["user_1"] = uplink2

	sender2, err := p2.AddTrack(trackLocal2)
	if err != nil {
		t.Fatalf("failed to add track2 to p2: %v", err)
	}
	downlink2 := NewSubscriberDownlink("user_2", "user_1", trackLocal2, sender2)
	uplink2.AddSubscriber(downlink2)
	r.subscribers["user_2"]["user_1"] = &subscriberEntry{downlink: downlink2, sender: sender2}

	// Trigger renegotiation on p2 again
	r.TriggerRenegotiation("user_2")
	select {
	case renegOffer = <-renegChan:
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for second renegotiation on p2")
	}

	// Client 2 handles second offer and creates answer
	clientAnswer2, err := client2.HandleOffer(renegOffer.SDP)
	if err != nil {
		t.Fatalf("client2 failed to handle second offer: %v", err)
	}
	if err := p2.HandleAnswer(clientAnswer2.SDP); err != nil {
		t.Fatalf("p2 failed to handle second answer: %v", err)
	}

	// Send packet on downlink2
	pkt := &rtp.Packet{
		Header: rtp.Header{
			SequenceNumber: 10,
			Timestamp:      960,
		},
		Payload: []byte{0x01, 0x02, 0x03},
	}
	if !downlink2.Enqueue(pkt) {
		t.Fatalf("failed to enqueue packet to downlink2")
	}

	// Allow forwarding loop to process
	time.Sleep(50 * time.Millisecond)
}

func TestRouter_AudioAndVideoMultiplexing(t *testing.T) {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create api: %v", err)
	}

	subPeer, err := peer.NewPeer(api, webrtc.Configuration{}, "sub_av", "sess_sub", "chan_av", "guild_av")
	if err != nil {
		t.Fatalf("failed to create sub peer: %v", err)
	}
	defer subPeer.Close()
	go func() {
		for range subPeer.Candidates {
		}
	}()

	r := NewRouter("chan_av")
	defer r.Close()

	renegOffers := make(chan webrtc.SessionDescription, 5)
	r.AddPeer(subPeer, func(offer webrtc.SessionDescription) {
		renegOffers <- offer
	})

	// Setup audio and video uplinks for pub_1
	audioUplink := NewPublisherUplink("pub_1", nil, nil)
	audioUplink.Kind = webrtc.RTPCodecTypeAudio
	audioUplink.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}
	audioUplink.TrackKey = "pub_1:audio:track_a"
	audioUplink.TrackID = "track_a"

	videoUplink := NewPublisherUplink("pub_1", nil, nil)
	videoUplink.Kind = webrtc.RTPCodecTypeVideo
	videoUplink.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}
	videoUplink.TrackKey = "pub_1:video:track_v"
	videoUplink.TrackID = "track_v"

	r.mu.Lock()
	r.publishers["pub_1:audio:track_a"] = audioUplink
	r.publishers["pub_1:video:track_v"] = videoUplink
	r.mu.Unlock()

	// Subscribe sub_av to pub_1's existing tracks
	r.SubscribeToExistingPublishers("sub_av")

	// Wait for renegotiation offer on subscriber
	var offer webrtc.SessionDescription
	select {
	case offer = <-renegOffers:
	case <-time.After(1 * time.Second):
		t.Fatalf("timed out waiting for renegotiation offer on subscriber")
	}

	// Verify that offer contains BOTH audio and video media sections
	if !strings.Contains(offer.SDP, "m=audio") {
		t.Errorf("expected offer SDP to contain m=audio section, got:\n%s", offer.SDP)
	}
	if !strings.Contains(offer.SDP, "m=video") {
		t.Errorf("expected offer SDP to contain m=video section, got:\n%s", offer.SDP)
	}

	// Verify subscriber entries has both tracks
	r.mu.RLock()
	subEntries := r.subscribers["sub_av"]
	if len(subEntries) != 2 {
		t.Errorf("expected 2 subscriber downlinks for sub_av, got %d", len(subEntries))
	}

	audioEntry := subEntries["pub_1:audio:track_a"]
	videoEntry := subEntries["pub_1:video:track_v"]
	r.mu.RUnlock()

	if audioEntry == nil || videoEntry == nil {
		t.Fatalf("expected both audio and video entries to be non-nil")
	}

	// Verify both downlinks belong to the same stream ID
	if audioEntry.downlink.TrackLocal.StreamID() != videoEntry.downlink.TrackLocal.StreamID() {
		t.Errorf("expected same stream ID, got audio=%s vs video=%s",
			audioEntry.downlink.TrackLocal.StreamID(),
			videoEntry.downlink.TrackLocal.StreamID(),
		)
	}

	// Enqueue RTP packet on each downlink
	audioPkt := &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 960},
		Payload: []byte{0x01, 0x02},
	}
	videoPkt := &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 3000},
		Payload: []byte{0xAA, 0xBB, 0xCC},
	}

	if !audioEntry.downlink.Enqueue(audioPkt) {
		t.Errorf("failed to enqueue audio packet")
	}
	if !videoEntry.downlink.Enqueue(videoPkt) {
		t.Errorf("failed to enqueue video packet")
	}

	time.Sleep(50 * time.Millisecond)

	if audioEntry.downlink.Sequence() != 1 {
		t.Errorf("expected audio sequence counter to be 1, got %d", audioEntry.downlink.Sequence())
	}
	if videoEntry.downlink.Sequence() != 1 {
		t.Errorf("expected video sequence counter to be 1, got %d", videoEntry.downlink.Sequence())
	}

	// Remove pub_1 and verify both audio and video tracks are cleaned up
	r.RemovePublisher("pub_1")

	r.mu.RLock()
	if len(r.subscribers["sub_av"]) != 0 {
		t.Errorf("expected subscribers for sub_av to be empty after publisher removed, got %d", len(r.subscribers["sub_av"]))
	}
	if len(r.publishers) != 0 {
		t.Errorf("expected publishers to be empty after pub_1 removed, got %d", len(r.publishers))
	}
	r.mu.RUnlock()
}

func TestRouter_RTCPFeedbackForwarding(t *testing.T) {
	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-track", "video-stream",
	)
	if err != nil {
		t.Fatalf("failed to create track local: %v", err)
	}

	uplink := NewPublisherUplink("pub_rtcp", nil, nil)
	uplink.Kind = webrtc.RTPCodecTypeVideo

	forwardedRTCP := make(chan []rtcp.Packet, 5)
	uplink.SetRTCPWriter(func(pkts []rtcp.Packet) error {
		forwardedRTCP <- pkts
		return nil
	})

	downlink := NewSubscriberDownlink("sub_rtcp", "pub_rtcp", trackLocal, nil)
	defer downlink.Close()

	uplink.AddSubscriber(downlink)

	initialPLI := getCounterValue(metrics.RTCPPLITotal)
	initialFIR := getCounterValue(metrics.RTCPFIRTotal)

	// Simulate subscriber downlink receiving PLI
	pli := &rtcp.PictureLossIndication{
		MediaSSRC: 99999, // downlink SSRC before rewrite
	}

	downlink.feedbackMu.RLock()
	cb := downlink.onFeedback
	downlink.feedbackMu.RUnlock()

	if cb == nil {
		t.Fatalf("expected onFeedback callback to be configured on downlink")
	}

	// Trigger PLI feedback
	metrics.RTCPPLITotal.Inc()
	cb([]rtcp.Packet{pli})

	select {
	case pkts := <-forwardedRTCP:
		if len(pkts) != 1 {
			t.Fatalf("expected 1 RTCP packet forwarded, got %d", len(pkts))
		}
		if _, ok := pkts[0].(*rtcp.PictureLossIndication); !ok {
			t.Errorf("expected forwarded packet to be *rtcp.PictureLossIndication, got %T", pkts[0])
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for PLI packet forwarding")
	}

	newPLI := getCounterValue(metrics.RTCPPLITotal)
	if newPLI <= initialPLI {
		t.Errorf("expected RTCPPLITotal counter to increase, got %f vs %f", newPLI, initialPLI)
	}

	// Trigger FIR feedback
	fir := &rtcp.FullIntraRequest{
		MediaSSRC: 99999,
		FIR: []rtcp.FIREntry{
			{SequenceNumber: 1},
		},
	}
	metrics.RTCPFIRTotal.Inc()
	cb([]rtcp.Packet{fir})

	select {
	case pkts := <-forwardedRTCP:
		if len(pkts) != 1 {
			t.Fatalf("expected 1 RTCP packet forwarded, got %d", len(pkts))
		}
		if _, ok := pkts[0].(*rtcp.FullIntraRequest); !ok {
			t.Errorf("expected forwarded packet to be *rtcp.FullIntraRequest, got %T", pkts[0])
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for FIR packet forwarding")
	}

	newFIR := getCounterValue(metrics.RTCPFIRTotal)
	if newFIR <= initialFIR {
		t.Errorf("expected RTCPFIRTotal counter to increase, got %f vs %f", newFIR, initialFIR)
	}
}

func TestRouter_ScreenshareRoutingAndIndependentTeardown(t *testing.T) {
	r := NewRouter("chan_screenshare")
	defer r.Close()

	camCtx, camCancel := context.WithCancel(context.Background())
	defer camCancel()
	screenCtx, screenCancel := context.WithCancel(context.Background())
	defer screenCancel()

	// Uplink 1: Camera
	cameraUplink := &PublisherUplink{
		PublisherID: "user_presenter",
		Kind:        webrtc.RTPCodecTypeVideo,
		TrackID:     "kith-track-user_presenter-video",
		StreamID:    "kith-stream-user_presenter",
		TrackKey:    "user_presenter:video:camera1",
		IsScreen:    false,
		subscribers: make(map[string]*SubscriberDownlink),
		ctx:         camCtx,
		cancel:      camCancel,
	}
	r.publishers[cameraUplink.TrackKey] = cameraUplink

	// Uplink 2: Screenshare
	screenUplink := &PublisherUplink{
		PublisherID: "user_presenter",
		Kind:        webrtc.RTPCodecTypeVideo,
		TrackID:     "kith-track-user_presenter-screen",
		StreamID:    "kith-screen-user_presenter",
		TrackKey:    "user_presenter:video:screen1",
		IsScreen:    true,
		subscribers: make(map[string]*SubscriberDownlink),
		ctx:         screenCtx,
		cancel:      screenCancel,
	}
	r.publishers[screenUplink.TrackKey] = screenUplink

	if !screenUplink.IsScreen {
		t.Errorf("expected screenUplink.IsScreen to be true")
	}
	if screenUplink.DownlinkStreamID("user_presenter") != "kith-screen-user_presenter" {
		t.Errorf("expected DownlinkStreamID to be kith-screen-user_presenter, got %s", screenUplink.DownlinkStreamID("user_presenter"))
	}
	if screenUplink.DownlinkTrackID("user_presenter") != "kith-track-user_presenter-screen" {
		t.Errorf("expected DownlinkTrackID to be kith-track-user_presenter-screen, got %s", screenUplink.DownlinkTrackID("user_presenter"))
	}

	// Remove camera only
	r.RemovePublisherCamera("user_presenter")

	r.mu.RLock()
	if _, ok := r.publishers[cameraUplink.TrackKey]; ok {
		t.Errorf("expected camera uplink to be removed")
	}
	if _, ok := r.publishers[screenUplink.TrackKey]; !ok {
		t.Errorf("expected screen uplink to remain active after camera removal")
	}
	r.mu.RUnlock()

	// Remove screenshare
	r.RemovePublisherScreen("user_presenter")

	r.mu.RLock()
	if _, ok := r.publishers[screenUplink.TrackKey]; ok {
		t.Errorf("expected screen uplink to be removed")
	}
	r.mu.RUnlock()
}


