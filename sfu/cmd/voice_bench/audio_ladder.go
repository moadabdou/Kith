package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// LadderRung specifies publisher and subscriber counts for a ladder step.
type LadderRung struct {
	Publishers  int
	Subscribers int
}

// RungResult records observed metrics and saturation indicators for a rung.
type RungResult struct {
	RungIndex     int
	Publishers    int
	Subscribers   int
	TotalStreams  int
	TargetPPS     float64
	ForwardedPPS  float64
	DroppedPPS    float64
	DropPercent   float64
	SubQueueDepth float64
	Duration      time.Duration
	Verdict       string
}

// parseLadderRungs parses a comma-separated list of "pubs:subs" strings,
// e.g. "1:2,2:4,4:8,5:10".
func parseLadderRungs(s string) ([]LadderRung, error) {
	parts := strings.Split(s, ",")
	var rungs []LadderRung
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		pair := strings.Split(p, ":")
		if len(pair) != 2 {
			return nil, fmt.Errorf("invalid rung format '%s', expected 'pubs:subs'", p)
		}
		pubs, err := strconv.Atoi(strings.TrimSpace(pair[0]))
		if err != nil || pubs <= 0 {
			return nil, fmt.Errorf("invalid publisher count in '%s': %w", p, err)
		}
		subs, err := strconv.Atoi(strings.TrimSpace(pair[1]))
		if err != nil || subs <= 0 {
			return nil, fmt.Errorf("invalid subscriber count in '%s': %w", p, err)
		}
		rungs = append(rungs, LadderRung{Publishers: pubs, Subscribers: subs})
	}
	if len(rungs) == 0 {
		return nil, fmt.Errorf("no valid rungs provided")
	}
	return rungs, nil
}

// runAudioLadderDrill executes the gradual step-ladder benchmark.
func runAudioLadderDrill(cfg Config) error {
	rungs, err := parseLadderRungs(cfg.LadderRungs)
	if err != nil {
		return fmt.Errorf("parse ladder rungs: %w", err)
	}

	stepDuration := cfg.LadderStepDuration
	if stepDuration <= 0 {
		stepDuration = 15 * time.Second
	}
	ppsPerPub := cfg.LadderPPS
	if ppsPerPub <= 0 {
		ppsPerPub = 50
	}

	fmt.Printf("%s%s=== STARTING SFU AUDIO STEP-LADDER BENCHMARK ===%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("Configured Rungs: %d | Duration per Rung: %v | PPS per Publisher: %d\n",
		len(rungs), stepDuration, ppsPerPub)
	for i, r := range rungs {
		streams := r.Publishers * r.Subscribers
		targetPPS := streams * ppsPerPub
		fmt.Printf("  • Rung %d: %d pub × %d sub (%d streams, target %d fwd pps)\n",
			i+1, r.Publishers, r.Subscribers, streams, targetPPS)
	}
	fmt.Println()

	var results []RungResult
	kneeFound := false
	var kneeRung int

	for i, rung := range rungs {
		rungNum := i + 1
		fmt.Printf("%s%s--- Executing Rung %d/%d: %d Pubs × %d Subs ---%s\n",
			colorBold, colorYellow, rungNum, len(rungs), rung.Publishers, rung.Subscribers, colorReset)

		res, err := executeLadderRung(context.Background(), cfg, rungNum, rung, stepDuration, ppsPerPub)
		if err != nil {
			fmt.Printf("%s✗ Rung %d failed: %v%s\n", colorRed, rungNum, err, colorReset)
			return err
		}

		results = append(results, *res)

		if res.DroppedPPS > 0 && !kneeFound {
			kneeFound = true
			kneeRung = rungNum
			fmt.Printf("%s%s>>> KNEE DETECTED AT RUNG %d (%d streams, %.1f dropped pps, %.2f%% drop rate) <<<%s\n\n",
				colorBold, colorRed, rungNum, res.TotalStreams, res.DroppedPPS, res.DropPercent, colorReset)
		} else {
			fmt.Printf("%s✓ Rung %d completed cleanly (%.1f fwd pps, 0 drops, queue depth: %.0f)%s\n\n",
				colorGreen, rungNum, res.ForwardedPPS, res.SubQueueDepth, colorReset)
		}

		// Brief stabilization cooldown before next rung
		if i < len(rungs)-1 {
			time.Sleep(2 * time.Second)
		}
	}

	// Print final tabular summary
	printLadderSummary(results, kneeFound, kneeRung)
	return nil
}

// executeLadderRung executes a single step on the audio ladder.
func executeLadderRung(ctx context.Context, cfg Config, rungNum int, rung LadderRung, duration time.Duration, ppsPerPub int) (*RungResult, error) {
	totalUsers := rung.Publishers + rung.Subscribers
	totalStreams := rung.Publishers * rung.Subscribers
	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%1000000)

	// 1. Provision all test users
	users := make([]*TestUser, totalUsers)
	for i := 0; i < totalUsers; i++ {
		role := "sub"
		if i < rung.Publishers {
			role = "pub"
		}
		username := fmt.Sprintf("u_%s%d_%s", role, i+1, randSuffix)
		u, err := registerAndLogin(cfg.APIBase, username, "password123")
		if err != nil {
			return nil, fmt.Errorf("register user %s_%d: %w", role, i+1, err)
		}
		users[i] = u
	}

	owner := users[0]

	// 2. Create Guild & Voice Channel
	guildID, err := createGuild(cfg.APIBase, owner.Token, fmt.Sprintf("Ladder-Rung-%d-%s", rungNum, randSuffix))
	if err != nil {
		return nil, fmt.Errorf("create guild: %w", err)
	}

	chanID, err := createVoiceChannel(cfg.APIBase, owner.Token, guildID, fmt.Sprintf("voice-%d", rungNum))
	if err != nil {
		return nil, fmt.Errorf("create voice channel: %w", err)
	}

	// 3. Invite all other users to guild
	for i := 1; i < totalUsers; i++ {
		if err := inviteAndJoin(cfg.APIBase, owner.Token, users[i].Token, chanID); err != nil {
			return nil, fmt.Errorf("invite/join user %d: %w", i, err)
		}
	}

	// 4. Connect all users to Gateway and join voice
	gwSessions := make([]*GatewayVoiceSession, totalUsers)
	voiceServers := make([]VoiceServerInfo, totalUsers)
	defer func() {
		for _, s := range gwSessions {
			if s != nil {
				s.Close()
			}
		}
	}()

	for i := 0; i < totalUsers; i++ {
		gw, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, users[i], guildID, chanID)
		if err != nil {
			return nil, fmt.Errorf("gateway connect user %d: %w", i, err)
		}
		gwSessions[i] = gw

		vs, err := gw.WaitForVoiceServerOrRetry(guildID, chanID, 10*time.Second)
		if err != nil {
			return nil, fmt.Errorf("voice server update user %d: %w", i, err)
		}
		voiceServers[i] = vs
	}

	// 5. Connect all users to Pion SFU
	sfuPeers := make([]*SFUPeer, totalUsers)
	defer func() {
		for _, p := range sfuPeers {
			if p != nil {
				p.Close()
			}
		}
	}()

	var receivedSubPackets int64

	// Connect subscribers first so downlinks are established
	for i := rung.Publishers; i < totalUsers; i++ {
		peer, err := connectSFUPeer(ctx, cfg.SFUWS, voiceServers[i].Token, chanID, users[i].ID, false)
		if err != nil {
			return nil, fmt.Errorf("sfu connect subscriber %d: %w", i-rung.Publishers+1, err)
		}
		sfuPeers[i] = peer

		peer.PC.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			for {
				_, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				atomic.AddInt64(&receivedSubPackets, 1)
			}
		})
	}

	// Connect publishers
	for i := 0; i < rung.Publishers; i++ {
		peer, err := connectSFUPeer(ctx, cfg.SFUWS, voiceServers[i].Token, chanID, users[i].ID, true)
		if err != nil {
			return nil, fmt.Errorf("sfu connect publisher %d: %w", i+1, err)
		}
		sfuPeers[i] = peer
	}

	// Stabilization delay for ICE peer connection convergence
	time.Sleep(1500 * time.Millisecond)

	// 6. Start continuous audio packet transmission across publishers
	frameInterval := time.Duration(1000/ppsPerPub) * time.Millisecond
	stopSend := make(chan struct{})
	var wg sync.WaitGroup

	for pubIdx := 0; pubIdx < rung.Publishers; pubIdx++ {
		wg.Add(1)
		go func(p *SFUPeer, idx int) {
			defer wg.Done()
			ticker := time.NewTicker(frameInterval)
			defer ticker.Stop()

			seq := uint16(1000 + idx*5000)
			ts := uint32(10000 + idx*9600)
			ssrc := uint32(0x11000000 + idx*0x1000)

			for {
				select {
				case <-stopSend:
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
		}(sfuPeers[pubIdx], pubIdx)
	}

	// 7. Warm-up phase: allow initial RTP packets to trigger SFU OnTrack and complete downlink renegotiations
	warmup := 2 * time.Second
	if totalStreams > 200 {
		warmup = 5 * time.Second
	}
	if totalStreams > 1000 {
		warmup = 8 * time.Second
	}
	time.Sleep(warmup)

	// 8. Snapshot baseline SFU metrics at steady-state
	metricsBefore, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		close(stopSend)
		return nil, fmt.Errorf("fetch baseline metrics: %w", err)
	}
	fwdBefore := metricsBefore["sfu_packets_forwarded_total"]
	dropBefore := metricsBefore["sfu_packets_dropped_total"]

	startTime := time.Now()

	// 9. Active measurement window
	time.Sleep(duration)
	elapsedSec := time.Since(startTime).Seconds()

	// 10. Snapshot post-run SFU metrics
	metricsAfter, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		close(stopSend)
		return nil, fmt.Errorf("fetch post-run metrics: %w", err)
	}

	close(stopSend)
	wg.Wait()
	fwdAfter := metricsAfter["sfu_packets_forwarded_total"]
	dropAfter := metricsAfter["sfu_packets_dropped_total"]
	queueDepth := metricsAfter["sfu_sub_queue_depth"]

	deltaFwd := fwdAfter - fwdBefore
	deltaDrop := dropAfter - dropBefore
	fwdPPS := deltaFwd / elapsedSec
	dropPPS := deltaDrop / elapsedSec

	dropPct := 0.0
	if (deltaFwd + deltaDrop) > 0 {
		dropPct = (deltaDrop / (deltaFwd + deltaDrop)) * 100.0
	}

	targetPPS := float64(totalStreams * ppsPerPub)

	verdict := "CLEAN"
	if deltaDrop > 0 {
		if dropPct > 5.0 {
			verdict = "SATURATED"
		} else {
			verdict = "KNEE"
		}
	}

	return &RungResult{
		RungIndex:     rungNum,
		Publishers:    rung.Publishers,
		Subscribers:   rung.Subscribers,
		TotalStreams:  totalStreams,
		TargetPPS:     targetPPS,
		ForwardedPPS:  fwdPPS,
		DroppedPPS:    dropPPS,
		DropPercent:   dropPct,
		SubQueueDepth: queueDepth,
		Duration:      duration,
		Verdict:       verdict,
	}, nil
}

// printLadderSummary formats and renders the final benchmark table.
func printLadderSummary(results []RungResult, kneeFound bool, kneeRung int) {
	fmt.Printf("%s%s========================================================================================================%s\n",
		colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s                       SFU AUDIO STEP-LADDER BENCHMARK SUMMARY (Issue #96)                              %s\n",
		colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s========================================================================================================%s\n",
		colorBold, colorCyan, colorReset)
	fmt.Printf("%-5s | %-11s | %-8s | %-11s | %-12s | %-11s | %-8s | %-7s | %-12s\n",
		"Rung", "Pubs / Subs", "Streams", "Target PPS", "Fwd PPS", "Drop PPS", "Drop %", "Queue", "Verdict")
	fmt.Println("------+-------------+----------+-------------+--------------+-------------+----------+---------+-------------")

	for _, r := range results {
		verdictColor := colorGreen
		if r.Verdict == "KNEE" {
			verdictColor = colorYellow
		} else if r.Verdict == "SATURATED" {
			verdictColor = colorRed
		}

		fmt.Printf("%-5d | %-4d / %-4d | %-8d | %-11.0f | %-12.1f | %-11.1f | %-7.2f%% | %-7.0f | %s%-12s%s\n",
			r.RungIndex,
			r.Publishers, r.Subscribers,
			r.TotalStreams,
			r.TargetPPS,
			r.ForwardedPPS,
			r.DroppedPPS,
			r.DropPercent,
			r.SubQueueDepth,
			verdictColor, r.Verdict, colorReset,
		)
	}
	fmt.Printf("%s========================================================================================================%s\n\n",
		colorCyan, colorReset)

	if kneeFound {
		fmt.Printf("%s[RESULT] SFU Saturation Knee detected at Rung %d.%s\n", colorYellow, kneeRung, colorReset)
	} else {
		fmt.Printf("%s[RESULT] All configured rungs completed with 0 drops (no saturation knee reached).%s\n",
			colorGreen, colorReset)
	}
}
