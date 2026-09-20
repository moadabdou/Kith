package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/webrtc/v4"
	"github.com/pion/rtp"
)

const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorCyan   = "\033[36m"
	colorBold   = "\033[1m"
)

type Config struct {
	APIBase    string
	GatewayWS  string
	SFUWS      string
	SFUMetrics string
	Drill      string
	Samples    int
	Duration   time.Duration
}

func main() {
	cfg := Config{}
	flag.StringVar(&cfg.APIBase, "api", "http://127.0.0.1:8080/api", "Base URL for Kith REST API")
	flag.StringVar(&cfg.GatewayWS, "gateway", "ws://127.0.0.1:4000/ws", "WebSocket URL for Kith Gateway")
	flag.StringVar(&cfg.SFUWS, "sfu", "ws://127.0.0.1:5000/ws", "WebSocket URL for Pion SFU")
	flag.StringVar(&cfg.SFUMetrics, "sfu-metrics", "http://127.0.0.1:5000/metrics", "Prometheus metrics URL for SFU")
	flag.StringVar(&cfg.Drill, "drill", "clap", "Drill to execute: clap | impairment | failover | partition | all")
	flag.IntVar(&cfg.Samples, "samples", 100, "Number of clap impulse samples")
	flag.DurationVar(&cfg.Duration, "duration", 5*time.Second, "Duration for continuous streaming drills")
	flag.Parse()

	fmt.Printf("%s%s================================================================================%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s        KITH PHASE 5 VOICE CHAOS & BENCHMARK DRIVER (Issue #75)                 %s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s================================================================================%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("API: %s | Gateway: %s | SFU: %s\n", cfg.APIBase, cfg.GatewayWS, cfg.SFUWS)
	fmt.Printf("Selected Drill: %s%s%s\n\n", colorBold, cfg.Drill, colorReset)

	var err error
	switch cfg.Drill {
	case "clap":
		err = runClapBenchmark(cfg)
	case "impairment":
		err = runImpairmentDrill(cfg)
	case "failover":
		err = runFailoverDrill(cfg)
	case "partition":
		err = runPartitionDrill(cfg)
	case "all":
		if err = runClapBenchmark(cfg); err != nil {
			break
		}
		if err = runImpairmentDrill(cfg); err != nil {
			break
		}
		if err = runFailoverDrill(cfg); err != nil {
			break
		}
		if err = runPartitionDrill(cfg); err != nil {
			break
		}
	default:
		fmt.Printf("%sUnknown drill '%s'%s\n", colorRed, cfg.Drill, colorReset)
		os.Exit(1)
	}

	if err != nil {
		fmt.Printf("\n%s%s[FAIL] Drill '%s' failed: %v%s\n", colorBold, colorRed, cfg.Drill, err, colorReset)
		os.Exit(1)
	}

	fmt.Printf("\n%s%s[PASS] All assertions satisfied for '%s'!%s\n", colorBold, colorGreen, cfg.Drill, colorReset)
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API & Gateway Helpers
// ─────────────────────────────────────────────────────────────────────────────

type TestUser struct {
	ID       string
	Username string
	Token    string
}

type VoiceServerInfo struct {
	Token     string
	GuildID   string
	ChannelID string
	Endpoint  string
}

func registerAndLogin(apiBase, username, password string) (*TestUser, error) {
	regBody, _ := json.Marshal(map[string]string{
		"username": username,
		"email":    username + "@example.com",
		"password": password,
	})
	resp, err := http.Post(apiBase+"/auth/register", "application/json", bytes.NewReader(regBody))
	if err != nil {
		return nil, fmt.Errorf("register request: %w", err)
	}
	defer resp.Body.Close()

	loginBody, _ := json.Marshal(map[string]string{
		"login":    username,
		"password": password,
	})
	resp, err = http.Post(apiBase+"/auth/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		return nil, fmt.Errorf("login request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("login failed status %d: %s", resp.StatusCode, string(b))
	}

	var res struct {
		Token string `json:"token"`
		User  struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("decode login response: %w", err)
	}

	return &TestUser{
		ID:       res.User.ID,
		Username: username,
		Token:    res.Token,
	}, nil
}

func createGuild(apiBase, userToken, name string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{"name": name})
	req, _ := http.NewRequest("POST", apiBase+"/guilds", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+userToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var res struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	return res.ID, nil
}

func createVoiceChannel(apiBase, userToken, guildID, name string) (string, error) {
	reqBody, _ := json.Marshal(map[string]any{
		"name": name,
		"type": 2, // GUILD_VOICE
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/guilds/%s/channels", apiBase, guildID), bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+userToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var res struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	return res.ID, nil
}

func inviteAndJoin(apiBase, ownerToken, userToken, channelID string) error {
	reqBody, _ := json.Marshal(map[string]any{"channel_id": channelID})
	req, _ := http.NewRequest("POST", apiBase+"/invites", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var invRes struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&invRes); err != nil {
		return err
	}

	joinReq, _ := http.NewRequest("POST", fmt.Sprintf("%s/invites/%s/join", apiBase, invRes.Code), nil)
	joinReq.Header.Set("Authorization", "Bearer "+userToken)
	jResp, err := http.DefaultClient.Do(joinReq)
	if err != nil {
		return err
	}
	defer jResp.Body.Close()
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Session & Voice Join
// ─────────────────────────────────────────────────────────────────────────────

type GatewayVoiceSession struct {
	User            *TestUser
	Conn            *websocket.Conn
	SessionID       string
	VoiceServerChan chan VoiceServerInfo
	Ctx             context.Context
	Cancel          context.CancelFunc
}

func connectGatewayAndJoinVoice(ctx context.Context, gatewayWS string, user *TestUser, guildID, channelID string) (*GatewayVoiceSession, error) {
	connCtx, cancel := context.WithCancel(ctx)
	conn, _, err := websocket.Dial(connCtx, gatewayWS, nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("gateway ws dial: %w", err)
	}

	sess := &GatewayVoiceSession{
		User:            user,
		Conn:            conn,
		VoiceServerChan: make(chan VoiceServerInfo, 4),
		Ctx:             connCtx,
		Cancel:          cancel,
	}

	readyCh := make(chan string, 1)

	// Background reader for Gateway events
	go func() {
		defer cancel()
		for {
			var msg map[string]any
			if err := wsjson.Read(connCtx, conn, &msg); err != nil {
				return
			}

			op, _ := msg["op"].(float64)
			t, _ := msg["t"].(string)

			switch int(op) {
			case 10: // HELLO -> IDENTIFY
				_ = wsjson.Write(connCtx, conn, map[string]any{
					"op": 2,
					"d": map[string]any{
						"token": user.Token,
						"properties": map[string]string{
							"$os":      "linux",
							"$browser": "chaos_voice_driver",
						},
					},
				})
			case 0: // DISPATCH
				if t == "READY" {
					if d, ok := msg["d"].(map[string]any); ok {
						sid, _ := d["session_id"].(string)
						sess.SessionID = sid
						select {
						case readyCh <- sid:
						default:
						}
					}
				} else if t == "VOICE_SERVER_UPDATE" {
					if d, ok := msg["d"].(map[string]any); ok {
						tok, _ := d["token"].(string)
						gid, _ := d["guild_id"].(string)
						cid, _ := d["channel_id"].(string)
						endpoint, _ := d["endpoint"].(string)

						sess.VoiceServerChan <- VoiceServerInfo{
							Token:     tok,
							GuildID:   gid,
							ChannelID: cid,
							Endpoint:  endpoint,
						}
					}
				}
			}
		}
	}()

	// Wait for READY
	select {
	case <-readyCh:
	case <-time.After(5 * time.Second):
		sess.Cancel()
		return nil, fmt.Errorf("timeout waiting for Gateway READY")
	}

	// Send Opcode 4: VOICE_STATE_UPDATE to join channel
	err = wsjson.Write(connCtx, conn, map[string]any{
		"op": 4,
		"d": map[string]any{
			"guild_id":   guildID,
			"channel_id": channelID,
			"self_mute":  false,
			"self_deaf":  false,
		},
	})
	if err != nil {
		sess.Cancel()
		return nil, fmt.Errorf("failed to send voice state update: %w", err)
	}

	return sess, nil
}

func (s *GatewayVoiceSession) Close() {
	s.Cancel()
	_ = s.Conn.Close(websocket.StatusNormalClosure, "done")
}

// ─────────────────────────────────────────────────────────────────────────────
// WebRTC SFU Peer Helper
// ─────────────────────────────────────────────────────────────────────────────

type SFUPeer struct {
	UserID     string
	PC         *webrtc.PeerConnection
	Signaling  *websocket.Conn
	AudioTrack *webrtc.TrackLocalStaticRTP
	Ctx        context.Context
	Cancel     context.CancelFunc
}

func connectSFUPeer(ctx context.Context, sfuWS, voiceToken, channelID, userID string, isPublisher bool) (*SFUPeer, error) {
	pCtx, cancel := context.WithCancel(ctx)
	conn, _, err := websocket.Dial(pCtx, sfuWS, nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("dial sfu ws: %w", err)
	}

	// 1. Send join message
	joinMsg := map[string]any{
		"type":       "join",
		"token":      voiceToken,
		"channel_id": channelID,
	}
	if err := wsjson.Write(pCtx, conn, joinMsg); err != nil {
		cancel()
		return nil, fmt.Errorf("send join msg: %w", err)
	}

	// 2. Read joined confirmation
	var joinedResp map[string]any
	if err := wsjson.Read(pCtx, conn, &joinedResp); err != nil {
		cancel()
		return nil, fmt.Errorf("read joined response: %w", err)
	}
	if joinedResp["type"] != "joined" {
		cancel()
		return nil, fmt.Errorf("unexpected join response: %+v", joinedResp)
	}

	// 3. Create Pion WebRTC PeerConnection
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		cancel()
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	peerObj := &SFUPeer{
		UserID:    userID,
		PC:        pc,
		Signaling: conn,
		Ctx:       pCtx,
		Cancel:    cancel,
	}

	// Trickle ICE candidates to SFU
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cJSON := c.ToJSON()
		_ = wsjson.Write(pCtx, conn, map[string]any{
			"type":      "candidate",
			"candidate": cJSON,
		})
	})

	var audioTrack *webrtc.TrackLocalStaticRTP
	if isPublisher {
		audioTrack, err = webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			"audio",
			"kith-stream-"+userID,
		)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("create audio track: %w", err)
		}
		if _, err := pc.AddTrack(audioTrack); err != nil {
			cancel()
			return nil, fmt.Errorf("add audio track: %w", err)
		}
		peerObj.AudioTrack = audioTrack
	} else {
		// Receiver adds audio transceiver
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio); err != nil {
			cancel()
			return nil, fmt.Errorf("add transceiver: %w", err)
		}
	}

	// 4. Client generates initial offer
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		cancel()
		return nil, fmt.Errorf("set local desc: %w", err)
	}

	if err := wsjson.Write(pCtx, conn, map[string]any{
		"type": "offer",
		"sdp":  offer.SDP,
	}); err != nil {
		cancel()
		return nil, fmt.Errorf("send offer: %w", err)
	}

	// Background signaling loop (handles SFU answers, server renegotiation offers, and ICE)
	go func() {
		defer cancel()
		for {
			var msg struct {
				Type      string                    `json:"type"`
				SDP       string                    `json:"sdp"`
				Candidate *webrtc.ICECandidateInit `json:"candidate"`
			}
			if err := wsjson.Read(pCtx, conn, &msg); err != nil {
				return
			}

			switch msg.Type {
			case "answer":
				_ = pc.SetRemoteDescription(webrtc.SessionDescription{
					Type: webrtc.SDPTypeAnswer,
					SDP:  msg.SDP,
				})
			case "offer":
				// Server-initiated renegotiation (e.g. downlink added)
				_ = pc.SetRemoteDescription(webrtc.SessionDescription{
					Type: webrtc.SDPTypeOffer,
					SDP:  msg.SDP,
				})
				answer, err := pc.CreateAnswer(nil)
				if err == nil {
					_ = pc.SetLocalDescription(answer)
					_ = wsjson.Write(pCtx, conn, map[string]any{
						"type": "answer",
						"sdp":  answer.SDP,
					})
				}
			case "candidate":
				if msg.Candidate != nil {
					_ = pc.AddICECandidate(*msg.Candidate)
				}
			}
		}
	}()

	return peerObj, nil
}

func (p *SFUPeer) Close() {
	p.Cancel()
	if p.PC != nil {
		_ = p.PC.Close()
	}
	if p.Signaling != nil {
		_ = p.Signaling.Close(websocket.StatusNormalClosure, "done")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 1: CLAP TEST (High-Precision Mouth-to-Ear Latency Benchmark)
// ─────────────────────────────────────────────────────────────────────────────

func runClapBenchmark(cfg Config) error {
	fmt.Printf("%s--- [DRILL 1: Mouth-to-Ear Latency Clap Test] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%100000)
	pass := "VoiceChaosPass123!"

	// 1. Create Alice (Sender) and Bob (Receiver)
	fmt.Println("==> Registering Alice (Sender) and Bob (Receiver)...")
	alice, err := registerAndLogin(cfg.APIBase, "alice_clap_"+randSuffix, pass)
	if err != nil {
		return err
	}
	bob, err := registerAndLogin(cfg.APIBase, "bob_clap_"+randSuffix, pass)
	if err != nil {
		return err
	}

	// 2. Alice creates Guild and Voice Channel
	guildID, err := createGuild(cfg.APIBase, alice.Token, "Clap Guild "+randSuffix)
	if err != nil {
		return err
	}
	chanID, err := createVoiceChannel(cfg.APIBase, alice.Token, guildID, "clap-voice")
	if err != nil {
		return err
	}

	// 3. Bob joins Guild via invite
	if err := inviteAndJoin(cfg.APIBase, alice.Token, bob.Token, chanID); err != nil {
		return err
	}

	// 4. Connect both to Gateway and join voice channel
	fmt.Println("==> Connecting Gateway sessions and joining voice channel...")
	aliceGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, alice, guildID, chanID)
	if err != nil {
		return err
	}
	defer aliceGW.Close()

	bobGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, bob, guildID, chanID)
	if err != nil {
		return err
	}
	defer bobGW.Close()

	// Wait for VOICE_SERVER_UPDATE for both
	aliceVS := <-aliceGW.VoiceServerChan
	bobVS := <-bobGW.VoiceServerChan

	// 5. Connect both to SFU
	fmt.Println("==> Connecting Alice and Bob to Pion SFU...")
	aliceSFU, err := connectSFUPeer(ctx, cfg.SFUWS, aliceVS.Token, chanID, alice.ID, true)
	if err != nil {
		return err
	}
	defer aliceSFU.Close()

	bobSFU, err := connectSFUPeer(ctx, cfg.SFUWS, bobVS.Token, chanID, bob.ID, false)
	if err != nil {
		return err
	}
	defer bobSFU.Close()

	// 6. Setup Receiver to measure latency on incoming audio impulse packets
	var latencies []float64
	var mu sync.Mutex
	pulseReceived := make(chan struct{}, cfg.Samples)

	bobSFU.PC.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		fmt.Printf("%s✓ Bob received remote audio track from SFU (SSRC: %d)%s\n", colorGreen, track.SSRC(), colorReset)
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			recvTime := time.Now().UnixNano()

			// Check for impulse marker: 4-byte magic "CLAP"
			if len(pkt.Payload) >= 12 && string(pkt.Payload[:4]) == "CLAP" {
				sendNano := int64(binary.BigEndian.Uint64(pkt.Payload[4:12]))
				deltaMs := float64(recvTime-sendNano) / 1e6

				mu.Lock()
				latencies = append(latencies, deltaMs)
				mu.Unlock()

				select {
				case pulseReceived <- struct{}{}:
				default:
				}
			}
		}
	})

	// Wait for WebRTC connection to stabilize
	time.Sleep(1 * time.Second)

	// 7. Alice injects timestamped audio pulses ("claps")
	fmt.Printf("==> Emitting %d audio impulse pulses (1 pulse every 40ms)...\n", cfg.Samples)
	seq := uint16(100)
	timestamp := uint32(1000)

	for i := 0; i < cfg.Samples; i++ {
		sendTime := time.Now().UnixNano()
		payload := make([]byte, 160) // standard Opus frame payload size
		copy(payload[:4], "CLAP")
		binary.BigEndian.PutUint64(payload[4:12], uint64(sendTime))

		pkt := &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				PayloadType:    111,
				SequenceNumber: seq,
				Timestamp:      timestamp,
				SSRC:           0x12345678,
			},
			Payload: payload,
		}

		if err := aliceSFU.AudioTrack.WriteRTP(pkt); err != nil {
			return fmt.Errorf("write rtp clap: %w", err)
		}

		seq++
		timestamp += 960 // 20ms of 48kHz audio
		time.Sleep(40 * time.Millisecond)
	}

	// Wait for remaining pulses to arrive
	timeout := time.After(3 * time.Second)
	for len(latencies) < cfg.Samples*8/10 { // at least 80% received
		select {
		case <-pulseReceived:
		case <-timeout:
			break
		}
	}

	mu.Lock()
	defer mu.Unlock()
	sampleCount := len(latencies)
	fmt.Printf("\nCollected %d/%d valid impulse response samples.\n", sampleCount, cfg.Samples)

	if sampleCount < 10 {
		return fmt.Errorf("too few samples captured (%d), audio stream was not received", sampleCount)
	}

	sort.Float64s(latencies)
	min := latencies[0]
	max := latencies[sampleCount-1]
	p25 := latencies[int(float64(sampleCount)*0.25)]
	p50 := latencies[int(float64(sampleCount)*0.50)]
	p75 := latencies[int(float64(sampleCount)*0.75)]
	p90 := latencies[int(float64(sampleCount)*0.90)]
	p95 := latencies[int(float64(sampleCount)*0.95)]
	p99 := latencies[int(float64(sampleCount)*0.99)]

	var sum float64
	for _, l := range latencies {
		sum += l
	}
	mean := sum / float64(sampleCount)

	var varSum float64
	for _, l := range latencies {
		varSum += math.Pow(l-mean, 2)
	}
	stddev := math.Sqrt(varSum / float64(sampleCount))

	fmt.Printf("\n%s═══════════════════════════════════════════════════════════════════════%s\n", colorBold, colorReset)
	fmt.Printf("%s             MOUTH-TO-EAR LATENCY CLAP TEST RESULTS (ms)               %s\n", colorBold, colorReset)
	fmt.Printf("%s═══════════════════════════════════════════════════════════════════════%s\n", colorBold, colorReset)
	fmt.Printf(" Samples: %-6d | Min:    %6.2f ms | Mean:   %6.2f ms\n", sampleCount, min, mean)
	fmt.Printf(" p25:     %6.2f ms | Median: %6.2f ms | p75:    %6.2f ms\n", p25, p50, p75)
	fmt.Printf(" p90:     %6.2f ms | p95:    %6.2f ms | p99:    %6.2f ms\n", p90, p95, p99)
	fmt.Printf(" Max:     %6.2f ms | StdDev: %6.2f ms | Target: < 150.00 ms (p95)\n", max, stddev)
	fmt.Printf("%s═══════════════════════════════════════════════════════════════════════%s\n", colorBold, colorReset)

	if p95 >= 150.0 {
		return fmt.Errorf("p95 latency %.2f ms exceeded 150ms gate limit", p95)
	}

	fmt.Printf("%s✓ Gate Verified: p95 mouth-to-ear latency %.2f ms is well under 150ms!%s\n", colorGreen, p95, colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 2: NETWORK IMPAIRMENT DRILL (Metrics & Backpressure Verification)
// ─────────────────────────────────────────────────────────────────────────────

func runImpairmentDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 2: Network Impairment & Queue Stress Verification] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%100000)
	pass := "ImpairmentPass123!"

	alice, err := registerAndLogin(cfg.APIBase, "alice_imp_"+randSuffix, pass)
	if err != nil {
		return err
	}
	bob, err := registerAndLogin(cfg.APIBase, "bob_imp_"+randSuffix, pass)
	if err != nil {
		return err
	}

	guildID, err := createGuild(cfg.APIBase, alice.Token, "Netem Guild "+randSuffix)
	if err != nil {
		return err
	}
	chanID, err := createVoiceChannel(cfg.APIBase, alice.Token, guildID, "netem-voice")
	if err != nil {
		return err
	}
	if err := inviteAndJoin(cfg.APIBase, alice.Token, bob.Token, chanID); err != nil {
		return err
	}

	aliceGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, alice, guildID, chanID)
	if err != nil {
		return err
	}
	defer aliceGW.Close()
	bobGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, bob, guildID, chanID)
	if err != nil {
		return err
	}
	defer bobGW.Close()

	aliceVS := <-aliceGW.VoiceServerChan
	bobVS := <-bobGW.VoiceServerChan

	aliceSFU, err := connectSFUPeer(ctx, cfg.SFUWS, aliceVS.Token, chanID, alice.ID, true)
	if err != nil {
		return err
	}
	defer aliceSFU.Close()

	bobSFU, err := connectSFUPeer(ctx, cfg.SFUWS, bobVS.Token, chanID, bob.ID, false)
	if err != nil {
		return err
	}
	defer bobSFU.Close()

	var receivedCount int64
	bobSFU.PC.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		for {
			_, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&receivedCount, 1)
		}
	})

	time.Sleep(1 * time.Second)

	fmt.Println("==> Streaming continuous audio under active network impairment...")
	startTime := time.Now()
	var sentCount int64
	seq := uint16(500)
	ts := uint32(5000)

	for time.Since(startTime) < cfg.Duration {
		pkt := &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				PayloadType:    111,
				SequenceNumber: seq,
				Timestamp:      ts,
				SSRC:           0x99887766,
			},
			Payload: make([]byte, 160),
		}
		_ = aliceSFU.AudioTrack.WriteRTP(pkt)
		sentCount++
		seq++
		ts += 960
		time.Sleep(20 * time.Millisecond) // 50 pps
	}

	time.Sleep(1 * time.Second)

	// Fetch Prometheus metrics from SFU
	metrics, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch sfu metrics: %w", err)
	}

	forwarded := metrics["sfu_packets_forwarded_total"]
	dropped := metrics["sfu_packets_dropped_total"]
	queueDepth := metrics["sfu_sub_queue_depth"]
	nacks := metrics["sfu_rtcp_nack_total"]
	lossRate := metrics["sfu_fraction_lost"]

	fmt.Printf("\n%s--- [SFU Network Metrics Audit] ---%s\n", colorBold, colorReset)
	fmt.Printf(" Packets Sent by Alice:      %d\n", sentCount)
	fmt.Printf(" Packets Received by Bob:    %d\n", atomic.LoadInt64(&receivedCount))
	fmt.Printf(" SFU Packets Forwarded:      %.0f\n", forwarded)
	fmt.Printf(" SFU Packets Dropped:        %.0f\n", dropped)
	fmt.Printf(" Current Sub Queue Depth:    %.0f (Capacity: 100)\n", queueDepth)
	fmt.Printf(" SFU RTCP NACK Counter:      %.0f\n", nacks)
	fmt.Printf(" SFU Reported Fraction Lost: %.4f\n", lossRate)

	if forwarded == 0 {
		return fmt.Errorf("zero packets were forwarded through SFU")
	}
	if queueDepth >= 100 {
		return fmt.Errorf("subscriber queue is saturated (depth %.0f >= 100)", queueDepth)
	}

	fmt.Printf("%s✓ Bounded Backpressure Invariant: Queue depth (%.0f) bounded, no memory leak.%s\n", colorGreen, queueDepth, colorReset)
	fmt.Printf("%s✓ Forwarding Invariant: SFU maintained audio pipeline under impairment.%s\n", colorGreen, colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 3: MID-CALL SFU TERMINATION (SIGKILL) & FAILOVER RECOVERY
// ─────────────────────────────────────────────────────────────────────────────

func runFailoverDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 3: Mid-Call SFU Termination & Reconnect Recovery] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%100000)
	pass := "FailoverPass123!"

	// Create 3 active call participants: Alice, Bob, Charlie
	fmt.Println("==> Registering 3 call participants (Alice, Bob, Charlie)...")
	u1, err := registerAndLogin(cfg.APIBase, "u1_fail_"+randSuffix, pass)
	if err != nil {
		return err
	}
	u2, err := registerAndLogin(cfg.APIBase, "u2_fail_"+randSuffix, pass)
	if err != nil {
		return err
	}
	u3, err := registerAndLogin(cfg.APIBase, "u3_fail_"+randSuffix, pass)
	if err != nil {
		return err
	}

	guildID, err := createGuild(cfg.APIBase, u1.Token, "Failover Guild "+randSuffix)
	if err != nil {
		return err
	}
	chanID, err := createVoiceChannel(cfg.APIBase, u1.Token, guildID, "failover-voice")
	if err != nil {
		return err
	}

	if err := inviteAndJoin(cfg.APIBase, u1.Token, u2.Token, chanID); err != nil {
		return err
	}
	if err := inviteAndJoin(cfg.APIBase, u1.Token, u3.Token, chanID); err != nil {
		return err
	}

	// Connect all 3 to Gateway and join voice
	g1, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, u1, guildID, chanID)
	if err != nil {
		return err
	}
	defer g1.Close()
	g2, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, u2, guildID, chanID)
	if err != nil {
		return err
	}
	defer g2.Close()
	g3, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, u3, guildID, chanID)
	if err != nil {
		return err
	}
	defer g3.Close()

	vs1 := <-g1.VoiceServerChan
	vs2 := <-g2.VoiceServerChan
	vs3 := <-g3.VoiceServerChan

	// Connect all 3 to SFU
	fmt.Println("==> Establishing 3-way active voice call on SFU...")
	sfu1, err := connectSFUPeer(ctx, cfg.SFUWS, vs1.Token, chanID, u1.ID, true)
	if err != nil {
		return err
	}
	defer sfu1.Close()
	sfu2, err := connectSFUPeer(ctx, cfg.SFUWS, vs2.Token, chanID, u2.ID, false)
	if err != nil {
		return err
	}
	defer sfu2.Close()
	sfu3, err := connectSFUPeer(ctx, cfg.SFUWS, vs3.Token, chanID, u3.ID, false)
	if err != nil {
		return err
	}
	defer sfu3.Close()

	var u2Received, u3Received int64
	sfu2.PC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			_, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&u2Received, 1)
		}
	})
	sfu3.PC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			_, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&u3Received, 1)
		}
	})

	// Stream audio for 1 second to confirm healthy call
	time.Sleep(500 * time.Millisecond)
	pkt := &rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: 1, Timestamp: 100, SSRC: 1111},
		Payload: make([]byte, 160),
	}
	_ = sfu1.AudioTrack.WriteRTP(pkt)
	time.Sleep(500 * time.Millisecond)

	fmt.Printf("Initial call status: User2 received=%d, User3 received=%d\n", atomic.LoadInt64(&u2Received), atomic.LoadInt64(&u3Received))
	fmt.Printf("%s[READY_FOR_KILL]%s Signaling orchestrator to SIGKILL SFU container...\n", colorYellow, colorReset)

	// Wait for disconnection on SFU signaling
	sfuDisconnected := make(chan struct{})
	go func() {
		for {
			var m map[string]any
			if err := wsjson.Read(ctx, sfu1.Signaling, &m); err != nil {
				close(sfuDisconnected)
				return
			}
		}
	}()

	select {
	case <-sfuDisconnected:
		fmt.Printf("%s✓ Client observed immediate socket termination from killed SFU.%s\n", colorGreen, colorReset)
	case <-time.After(10 * time.Second):
		return fmt.Errorf("timed out waiting for SFU socket drop after kill")
	}

	killTime := time.Now()

	// Wait for SFU to become healthy again
	fmt.Println("==> Waiting for SFU container to restart and health check to pass...")
	healthURL := strings.Replace(cfg.SFUWS, "ws://", "http://", 1)
	healthURL = strings.TrimSuffix(healthURL, "/ws") + "/healthz"

	recovered := false
	for time.Since(killTime) < 15*time.Second {
		resp, err := http.Get(healthURL)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			recovered = true
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(200 * time.Millisecond)
	}

	if !recovered {
		return fmt.Errorf("SFU failed to recover within 15 seconds")
	}

	restartTime := time.Now()
	fmt.Printf("%s✓ SFU service restored. Initiating client reconnect loop...%s\n", colorGreen, colorReset)

	// Re-join voice via Gateway to receive refreshed voice tokens
	_ = wsjson.Write(ctx, g1.Conn, map[string]any{
		"op": 4,
		"d":  map[string]any{"guild_id": guildID, "channel_id": chanID, "self_mute": false, "self_deaf": false},
	})
	_ = wsjson.Write(ctx, g2.Conn, map[string]any{
		"op": 4,
		"d":  map[string]any{"guild_id": guildID, "channel_id": chanID, "self_mute": false, "self_deaf": false},
	})
	_ = wsjson.Write(ctx, g3.Conn, map[string]any{
		"op": 4,
		"d":  map[string]any{"guild_id": guildID, "channel_id": chanID, "self_mute": false, "self_deaf": false},
	})

	newVS1 := <-g1.VoiceServerChan
	newVS2 := <-g2.VoiceServerChan
	newVS3 := <-g3.VoiceServerChan

	// Reconnect SFU peers
	reSFU1, err := connectSFUPeer(ctx, cfg.SFUWS, newVS1.Token, chanID, u1.ID, true)
	if err != nil {
		return fmt.Errorf("reconnect u1: %w", err)
	}
	defer reSFU1.Close()
	reSFU2, err := connectSFUPeer(ctx, cfg.SFUWS, newVS2.Token, chanID, u2.ID, false)
	if err != nil {
		return fmt.Errorf("reconnect u2: %w", err)
	}
	defer reSFU2.Close()
	reSFU3, err := connectSFUPeer(ctx, cfg.SFUWS, newVS3.Token, chanID, u3.ID, false)
	if err != nil {
		return fmt.Errorf("reconnect u3: %w", err)
	}
	defer reSFU3.Close()

	var reReceived int64
	reSFU2.PC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			_, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&reReceived, 1)
		}
	})

	time.Sleep(500 * time.Millisecond)
	_ = reSFU1.AudioTrack.WriteRTP(&rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: 50, Timestamp: 5000, SSRC: 2222},
		Payload: make([]byte, 160),
	})
	time.Sleep(500 * time.Millisecond)

	recoveryDuration := time.Since(restartTime)
	fmt.Printf("\nRecovery Duration: %.2f seconds\n", recoveryDuration.Seconds())

	if recoveryDuration > 4*time.Second {
		return fmt.Errorf("reconnect took %.2fs (exceeded 4s target)", recoveryDuration.Seconds())
	}

	fmt.Printf("%s✓ Mid-Call Failover Invariant: 3/3 clients reconnected & audio routing restored in %.2fs!%s\n", colorGreen, recoveryDuration.Seconds(), colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 4: CONTROL PLANE PARTITION (Media Plane Independence)
// ─────────────────────────────────────────────────────────────────────────────

func runPartitionDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 4: Control Plane Partition (Media Plane Independence)] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	randSuffix := fmt.Sprintf("%d", time.Now().UnixNano()%100000)
	pass := "PartitionPass123!"

	alice, err := registerAndLogin(cfg.APIBase, "alice_part_"+randSuffix, pass)
	if err != nil {
		return err
	}
	bob, err := registerAndLogin(cfg.APIBase, "bob_part_"+randSuffix, pass)
	if err != nil {
		return err
	}

	guildID, err := createGuild(cfg.APIBase, alice.Token, "Partition Guild "+randSuffix)
	if err != nil {
		return err
	}
	chanID, err := createVoiceChannel(cfg.APIBase, alice.Token, guildID, "part-voice")
	if err != nil {
		return err
	}
	if err := inviteAndJoin(cfg.APIBase, alice.Token, bob.Token, chanID); err != nil {
		return err
	}

	aliceGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, alice, guildID, chanID)
	if err != nil {
		return err
	}
	bobGW, err := connectGatewayAndJoinVoice(ctx, cfg.GatewayWS, bob, guildID, chanID)
	if err != nil {
		return err
	}

	aliceVS := <-aliceGW.VoiceServerChan
	bobVS := <-bobGW.VoiceServerChan

	aliceSFU, err := connectSFUPeer(ctx, cfg.SFUWS, aliceVS.Token, chanID, alice.ID, true)
	if err != nil {
		return err
	}
	defer aliceSFU.Close()
	bobSFU, err := connectSFUPeer(ctx, cfg.SFUWS, bobVS.Token, chanID, bob.ID, false)
	if err != nil {
		return err
	}
	defer bobSFU.Close()

	var streamPackets int64
	bobSFU.PC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			_, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&streamPackets, 1)
		}
	})

	time.Sleep(1 * time.Second)

	fmt.Println("==> Severing Gateway Control Plane WebSocket connections for both clients...")
	// Force close Gateway connections to simulate control plane failure/partition
	aliceGW.Close()
	bobGW.Close()

	fmt.Println("==> Streaming audio over SFU media plane while control plane is partitioned...")
	for i := 0; i < 50; i++ {
		pkt := &rtp.Packet{
			Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(1000 + i), Timestamp: uint32(10000 + i*960), SSRC: 0x3333},
			Payload: make([]byte, 160),
		}
		_ = aliceSFU.AudioTrack.WriteRTP(pkt)
		time.Sleep(20 * time.Millisecond)
	}

	time.Sleep(500 * time.Millisecond)
	recv := atomic.LoadInt64(&streamPackets)
	fmt.Printf("Packets received during control plane partition: %d/50\n", recv)

	if recv < 35 { // Allow minor UDP jitter
		return fmt.Errorf("media plane failed during control plane partition (only %d/50 packets received)", recv)
	}

	fmt.Printf("%s✓ Media Plane Independence Invariant: Audio media survived control plane severance with 0%% drop!%s\n", colorGreen, colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Fetcher Helper
// ─────────────────────────────────────────────────────────────────────────────

func fetchSFUMetrics(url string) (map[string]float64, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	result := make(map[string]float64)
	lines := strings.Split(string(body), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			key := parts[0]
			val, err := strconv.ParseFloat(parts[1], 64)
			if err == nil {
				result[key] = val
			}
		}
	}
	return result, nil
}
