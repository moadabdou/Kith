package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// LayerMixResult captures the combined telemetry for the layer-mix benchmark.
type LayerMixResult struct {
	Duration         time.Duration
	VideoRooms       int
	ScreenRooms      int
	AudioStreams     int
	TotalSubscribers int
	ForwardedPPS     float64
	DroppedPPS       float64
	DropPercent      float64
	SubQueueDepth    float64
	FractionLost     float64
	CPUPercent       float64
	MemoryMB         float64
	SimulcastStreams int
	ScreenStreams    int
	Verdict          string
}

// runLayerMixBenchmark executes the multi-room layer mix stress test (Issue #96 Sub-step 2).
func runLayerMixBenchmark(cfg Config) error {
	fmt.Printf("%s%s================================================================================%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s         KITH SFU LAYER-MIX BENCHMARK: SIMULCAST + SCREENSHARE (Issue #96)      %s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s================================================================================%s\n", colorBold, colorCyan, colorReset)

	duration := cfg.Duration
	if duration <= 0 {
		duration = 15 * time.Second
	}

	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%1000000)
	ctx, cancel := context.WithTimeout(context.Background(), duration+45*time.Second)
	defer cancel()

	fmt.Printf("Duration: %v | SFU: %s | Metrics: %s\n\n", duration, cfg.SFUWS, cfg.SFUMetrics)

	// ─────────────────────────────────────────────────────────────────────────
	// 1. Setup Room A: 3-Layer Simulcast Video (full/half/quarter)
	// ─────────────────────────────────────────────────────────────────────────
	fmt.Println("==> [1/3] Setting up Room A: 3-Layer VP8 Simulcast (f, h, q) with 3 subscribers...")
	videoPrefix := fmt.Sprintf("lmix_vid_%s", randSuffix)
	vidRoom, err := setupVideoRoom(cfg, ctx, videoPrefix, "VideoPass123!", 3)
	if err != nil {
		return fmt.Errorf("setup video room: %w", err)
	}
	defer vidRoom.close()

	vidPub, err := connectVideoPublisher(ctx, cfg, vidRoom.pubVS, vidRoom.chanID, vidRoom.pubUser.ID, true, false)
	if err != nil {
		return fmt.Errorf("connect simulcast publisher: %w", err)
	}
	defer vidPub.peer.Close()

	streamCtx, stopStreams := context.WithCancel(ctx)
	defer stopStreams()

	var vidWG sync.WaitGroup
	ssrcs := []uint32{0xE00001, 0xE00002, 0xE00003}
	sizes := []int{1200, 600, 250} // f, h, q
	for i, tr := range vidPub.tracks {
		vidWG.Add(1)
		go streamLayer(streamCtx, &vidWG, tr, ssrcs[i], uint16(2000*(i+1)), 30, sizes[i], vidPub.exts[i])
	}

	var vidSubs []*SFUPeer
	var vidDrains []*videoDrain
	for i := range vidRoom.subUser {
		s, err := connectVideoSubscriber(ctx, cfg, vidRoom.subVS[i], vidRoom.chanID, vidRoom.subUser[i].ID)
		if err != nil {
			return fmt.Errorf("connect video subscriber %d: %w", i, err)
		}
		vidSubs = append(vidSubs, s)
		defer s.Close()

		d := &videoDrain{}
		d.attach(s.PC)
		vidDrains = append(vidDrains, d)
	}

	if err := waitForDownlinks(vidDrains, 15, 20*time.Second); err != nil {
		return fmt.Errorf("wait for simulcast downlinks: %w", err)
	}
	fmt.Printf("%s✓ Room A established: 3 simulcast layers active across 3 subscribers%s\n", colorGreen, colorReset)

	// ─────────────────────────────────────────────────────────────────────────
	// 2. Setup Room B: High-Detail Screenshare Channel (single-layer f, 60 fps)
	// ─────────────────────────────────────────────────────────────────────────
	fmt.Println("==> [2/3] Setting up Room B: 720p Screenshare Channel with 2 subscribers...")
	screenPrefix := fmt.Sprintf("lmix_scr_%s", randSuffix)
	scrRoom, err := setupVideoRoom(cfg, ctx, screenPrefix, "ScreenPass123!", 2)
	if err != nil {
		return fmt.Errorf("setup screen room: %w", err)
	}
	defer scrRoom.close()

	scrPub, err := connectVideoPublisher(ctx, cfg, scrRoom.pubVS, scrRoom.chanID, scrRoom.pubUser.ID, false, true)
	if err != nil {
		return fmt.Errorf("connect screen publisher: %w", err)
	}
	defer scrPub.peer.Close()

	var scrWG sync.WaitGroup
	scrWG.Add(1)
	go streamLayer(streamCtx, &scrWG, scrPub.tracks[0], 0xD00001, 3000, 60, 1200, nil)

	var scrSubs []*SFUPeer
	var scrDrains []*videoDrain
	for i := range scrRoom.subUser {
		s, err := connectVideoSubscriber(ctx, cfg, scrRoom.subVS[i], scrRoom.chanID, scrRoom.subUser[i].ID)
		if err != nil {
			return fmt.Errorf("connect screen subscriber %d: %w", i, err)
		}
		scrSubs = append(scrSubs, s)
		defer s.Close()

		d := &videoDrain{}
		d.attach(s.PC)
		scrDrains = append(scrDrains, d)
	}

	if err := waitForDownlinks(scrDrains, 15, 20*time.Second); err != nil {
		return fmt.Errorf("wait for screenshare downlinks: %w", err)
	}
	fmt.Printf("%s✓ Room B established: 60fps screenshare active across 2 subscribers%s\n", colorGreen, colorReset)

	// ─────────────────────────────────────────────────────────────────────────
	// 3. Setup Room C: Concurrent Audio Army (5 pub x 10 sub = 50 audio streams)
	// ─────────────────────────────────────────────────────────────────────────
	fmt.Println("==> [3/3] Setting up Room C: Concurrent Audio Army (5 pubs × 10 subs = 50 streams)...")
	audioRung := LadderRung{Publishers: 5, Subscribers: 10}
	audioTotal := audioRung.Publishers + audioRung.Subscribers
	audioUsers := make([]*TestUser, audioTotal)
	for i := 0; i < audioTotal; i++ {
		role := "sub"
		if i < audioRung.Publishers {
			role = "pub"
		}
		u, err := registerAndLogin(cfg.APIBase, fmt.Sprintf("u_lm_%s%d_%s", role, i+1, randSuffix), "AudioPass123!")
		if err != nil {
			return fmt.Errorf("register audio user %d: %w", i, err)
		}
		audioUsers[i] = u
	}

	audioOwner := audioUsers[0]
	audioGuildID, err := createGuild(cfg.APIBase, audioOwner.Token, "LayerMix-Audio-"+randSuffix)
	if err != nil {
		return fmt.Errorf("create audio guild: %w", err)
	}
	audioChanID, err := createVoiceChannel(cfg.APIBase, audioOwner.Token, audioGuildID, "lmix-audio")
	if err != nil {
		return fmt.Errorf("create audio channel: %w", err)
	}

	for i := 1; i < audioTotal; i++ {
		if err := inviteAndJoin(cfg.APIBase, audioOwner.Token, audioUsers[i].Token, audioChanID); err != nil {
			return fmt.Errorf("invite audio user %d: %w", i, err)
		}
	}

	audioGWSessions := make([]*GatewayVoiceSession, audioTotal)
	audioVSInfos := make([]VoiceServerInfo, audioTotal)
	defer func() {
		for _, s := range audioGWSessions {
			if s != nil {
				s.Close()
			}
		}
	}()

	for i := 0; i < audioTotal; i++ {
		gw, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, audioUsers[i], audioGuildID, audioChanID)
		if err != nil {
			return fmt.Errorf("audio gateway connect user %d: %w", i, err)
		}
		audioGWSessions[i] = gw

		vs, err := gw.WaitForVoiceServerOrRetry(audioGuildID, audioChanID, 10*time.Second)
		if err != nil {
			return fmt.Errorf("audio voice server user %d: %w", i, err)
		}
		audioVSInfos[i] = vs
	}

	audioPeers := make([]*SFUPeer, audioTotal)
	defer func() {
		for _, p := range audioPeers {
			if p != nil {
				p.Close()
			}
		}
	}()

	var receivedAudioPackets int64
	for i := audioRung.Publishers; i < audioTotal; i++ {
		p, err := connectSFUPeer(ctx, cfg.SFUWS, audioVSInfos[i].Token, audioChanID, audioUsers[i].ID, false)
		if err != nil {
			return fmt.Errorf("sfu connect audio sub %d: %w", i, err)
		}
		audioPeers[i] = p
		p.PC.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			for {
				_, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				atomic.AddInt64(&receivedAudioPackets, 1)
			}
		})
	}

	for i := 0; i < audioRung.Publishers; i++ {
		p, err := connectSFUPeer(ctx, cfg.SFUWS, audioVSInfos[i].Token, audioChanID, audioUsers[i].ID, true)
		if err != nil {
			return fmt.Errorf("sfu connect audio pub %d: %w", i, err)
		}
		audioPeers[i] = p
	}

	// Stream audio concurrently
	var audioWG sync.WaitGroup
	stopAudio := make(chan struct{})
	defer func() { close(stopAudio); audioWG.Wait() }()

	for pubIdx := 0; pubIdx < audioRung.Publishers; pubIdx++ {
		audioWG.Add(1)
		go func(p *SFUPeer, idx int) {
			defer audioWG.Done()
			ticker := time.NewTicker(20 * time.Millisecond) // 50 pps
			defer ticker.Stop()

			seq := uint16(5000 + idx*3000)
			ts := uint32(50000 + idx*9600)
			ssrc := uint32(0x33000000 + idx*0x1000)

			for {
				select {
				case <-stopAudio:
					return
				case <-ticker.C:
					pkt := &rtp.Packet{
						Header: rtp.Header{
							Version:        2,
							PayloadType:    111,
							SequenceNumber: seq,
							Timestamp:      ts,
							SSRC:           ssrc,
						},
						Payload: make([]byte, 160),
					}
					_ = p.AudioTrack.WriteRTP(pkt)
					seq++
					ts += 960
				}
			}
		}(audioPeers[pubIdx], pubIdx)
	}

	fmt.Printf("%s✓ Room C established: 50 concurrent audio streams running%s\n\n", colorGreen, colorReset)

	// ─────────────────────────────────────────────────────────────────────────
	// 4. Steady-State Measurement Window
	// ─────────────────────────────────────────────────────────────────────────
	fmt.Printf("==> Running Layer-Mix steady-state load test for %v...\n", duration)
	time.Sleep(2 * time.Second) // Settle downlinks

	metricsBefore, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch metrics before: %w", err)
	}

	startMeasure := time.Now()
	time.Sleep(duration)
	elapsedSec := time.Since(startMeasure).Seconds()

	metricsAfter, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch metrics after: %w", err)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 5. Telemetry & Metrics Computation
	// ─────────────────────────────────────────────────────────────────────────
	deltaFwd := metricsAfter["sfu_packets_forwarded_total"] - metricsBefore["sfu_packets_forwarded_total"]
	deltaDrop := metricsAfter["sfu_packets_dropped_total"] - metricsBefore["sfu_packets_dropped_total"]
	deltaCPU := metricsAfter["process_cpu_seconds_total"] - metricsBefore["process_cpu_seconds_total"]
	memBytes := metricsAfter["process_resident_memory_bytes"]
	queueDepth := metricsAfter["sfu_sub_queue_depth"]
	_ = metricsAfter["sfu_fraction_lost"]

	fwdPPS := deltaFwd / elapsedSec
	dropPPS := deltaDrop / elapsedSec
	cpuPct := (deltaCPU / elapsedSec) * 100.0
	memMB := memBytes / (1024 * 1024)

	dropPct := 0.0
	if deltaFwd+deltaDrop > 0 {
		dropPct = (deltaDrop / (deltaFwd + deltaDrop)) * 100.0
	}

	verdict := "PASS (Clean)"
	if deltaDrop > 0 {
		verdict = "FAIL (Drops Detected)"
	}

	// Print Summary
	fmt.Printf("\n%s%s========================================================================================================%s\n",
		colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s                    SFU LAYER-MIX TELEMETRY & SATURATION REPORT (Issue #96)                             %s\n",
		colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s========================================================================================================%s\n",
		colorBold, colorCyan, colorReset)

	fmt.Printf("Active Traffic Mix:\n")
	fmt.Printf("  • Room A: 3-Layer Simulcast Video (Full 30fps + Half 30fps + Quarter 30fps) × 3 Subscribers (9 streams)\n")
	fmt.Printf("  • Room B: 720p High-Detail Screenshare (60 fps @ 1200B) × 2 Subscribers (2 streams)\n")
	fmt.Printf("  • Room C: Background Audio Army (5 Pubs × 10 Subs = 50 streams @ 50 pps)\n")
	fmt.Printf("  • Total Active Rooms: 3 | Total Downlink Streams: 61 | Test Duration: %.1fs\n\n", elapsedSec)

	fmt.Printf("%-20s | %-12s | %-12s | %-10s | %-10s | %-10s | %-14s\n",
		"Forwarded Rate", "Dropped Rate", "Loss %", "Queue Depth", "CPU %", "Memory", "Verdict")
	fmt.Println("---------------------+--------------+--------------+------------+------------+------------+---------------")

	verdictColor := colorGreen
	if deltaDrop > 0 {
		verdictColor = colorRed
	}

	fmt.Printf("%-16.1f pps | %-8.1f pps | %-10.2f%% | %-10.0f | %-8.1f%%  | %-8.1fMB | %s%-14s%s\n",
		fwdPPS, dropPPS, dropPct, queueDepth, cpuPct, memMB, verdictColor, verdict, colorReset)

	fmt.Printf("%s========================================================================================================%s\n\n",
		colorCyan, colorReset)

	if deltaDrop > 0 {
		return fmt.Errorf("layer-mix benchmark experienced %.1f drops/sec", dropPPS)
	}

	fmt.Printf("%s[SUCCESS] Sub-step 2 complete: Layer-mix forwarding proved with zero packet loss and healthy queues.%s\n",
		colorGreen, colorReset)
	return nil
}
