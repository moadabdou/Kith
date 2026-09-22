package main

// Phase 6 video chaos drills (Issue #83).
//
// Extends the Phase 5 voice_bench driver with VP8 simulcast publishers,
// per-subscriber RTCP ReceiverReport injection (loss profiles that steer
// the SFU layer selector deterministically), PLI storm generation, screen
// share verification, video failover timing (kill -> first keyframe), and
// resource snapshots for the postmortem report.
//
// Design notes:
//   - The bench publisher emits REAL 3-layer simulcast the same way the
//     router unit tests do: Pion sender with 3 encodings (RIDs f/h/q) plus
//     an injected `a=rid` / `a=simulcast` block on the offer copy handed to
//     the SFU (Pion does not generate the block natively). The SFU then
//     ingests 3 TrackRemotes keyed pubID:video:{f,h,q}.
//   - Only VP8 is used: the SFU keyframe detector + cache are VP8-only.
//   - RTCP feedback SSRCs are intentionally wild: the SFU routes PLI via
//     the downlink's feedback uplink and feeds every RR report into the
//     layer score regardless of SSRC values.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/moadabdou/Kith/sfu/internal/router"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	videoClockRate = 90000
	videoPayload   = 96 // VP8 payload type under RegisterDefaultCodecs
)

// openAppend opens path for appending, creating it when missing.
func openAppend(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared video room setup
// ─────────────────────────────────────────────────────────────────────────────

type videoRoom struct {
	ctx    context.Context
	cancel context.CancelFunc

	pubUser *TestUser
	subUser []*TestUser
	guildID string
	chanID  string

	pubGW *GatewayVoiceSession
	subGW []*GatewayVoiceSession

	pubVS VoiceServerInfo
	subVS []VoiceServerInfo
}

func (r *videoRoom) close() {
	for _, g := range r.subGW {
		if g != nil {
			g.Close()
		}
	}
	if r.pubGW != nil {
		r.pubGW.Close()
	}
	r.cancel()
}

// setupVideoRoom registers 1 publisher + nSubs subscribers, creates a guild
// with a voice channel, joins everyone, and collects voice tokens.
func setupVideoRoom(cfg Config, ctx context.Context, prefix, pass string, nSubs int) (*videoRoom, error) {
	rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	room := &videoRoom{ctx: rctx, cancel: cancel}

	var err error
	room.pubUser, err = registerAndLogin(cfg.APIBase, prefix+"_pub", pass)
	if err != nil {
		room.close()
		return nil, fmt.Errorf("register publisher: %w", err)
	}
	for i := 0; i < nSubs; i++ {
		u, err := registerAndLogin(cfg.APIBase, fmt.Sprintf("%s_sub%d", prefix, i), pass)
		if err != nil {
			room.close()
			return nil, fmt.Errorf("register sub %d: %w", i, err)
		}
		room.subUser = append(room.subUser, u)
	}

	room.guildID, err = createGuild(cfg.APIBase, room.pubUser.Token, prefix+" guild")
	if err != nil {
		room.close()
		return nil, fmt.Errorf("create guild: %w", err)
	}
	room.chanID, err = createVoiceChannel(cfg.APIBase, room.pubUser.Token, room.guildID, prefix+"-video")
	if err != nil {
		room.close()
		return nil, fmt.Errorf("create voice channel: %w", err)
	}
	for i, u := range room.subUser {
		if err := inviteAndJoin(cfg.APIBase, room.pubUser.Token, u.Token, room.chanID); err != nil {
			room.close()
			return nil, fmt.Errorf("invite sub %d: %w", i, err)
		}
	}

	room.pubGW, err = connectGatewayAndJoinVoice(rctx, cfg.GatewayWS, room.pubUser, room.guildID, room.chanID)
	if err != nil {
		room.close()
		return nil, fmt.Errorf("publisher gateway join: %w", err)
	}
	for i, u := range room.subUser {
		g, err := connectGatewayAndJoinVoice(rctx, cfg.GatewayWS, u, room.guildID, room.chanID)
		if err != nil {
			room.close()
			return nil, fmt.Errorf("sub %d gateway join: %w", i, err)
		}
		room.subGW = append(room.subGW, g)
	}

	select {
	case room.pubVS = <-room.pubGW.VoiceServerChan:
	case <-time.After(10 * time.Second):
		room.close()
		return nil, fmt.Errorf("timeout waiting for publisher VOICE_SERVER_UPDATE")
	}
	for i, g := range room.subGW {
		select {
		case vs := <-g.VoiceServerChan:
			room.subVS = append(room.subVS, vs)
		case <-time.After(10 * time.Second):
			room.close()
			return nil, fmt.Errorf("timeout waiting for sub %d VOICE_SERVER_UPDATE", i)
		}
	}
	return room, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Video SFU peers (simulcast publisher + video subscriber)
// ─────────────────────────────────────────────────────────────────────────────

// Simulcast header-extension URIs (RFC 8285). Pion negotiates these by
// default; every RTP packet of a simulcast uplink must carry MID +
// RTP-stream-ID extensions or the receiver cannot map SSRCs to RIDs
// ("Incoming unhandled RTP", verified by probe). This mirrors what Chrome
// sends natively.
const (
	sdesMidURI      = "urn:ietf:params:rtp-hdrext:sdes:mid"
	sdesRTPStreamID = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"
)

// videoExt carries the negotiated extension IDs + values for one simulcast
// layer's packets.
type videoExt struct {
	midID, ridID uint8
	mid, rid     string
}

// senderExtensions resolves the MID/RID extension IDs from the negotiated
// sender parameters plus the transceiver MID. Must run after the answer is
// applied (extension IDs come from negotiation).
func senderExtensions(pc *webrtc.PeerConnection, sender *webrtc.RTPSender, rid string) (*videoExt, error) {
	ext := &videoExt{rid: rid}
	for _, e := range sender.GetParameters().HeaderExtensions {
		switch e.URI {
		case sdesMidURI:
			ext.midID = uint8(e.ID)
		case sdesRTPStreamID:
			ext.ridID = uint8(e.ID)
		}
	}
	if ext.midID == 0 || ext.ridID == 0 {
		return nil, fmt.Errorf("MID/RTP-stream-ID extensions not negotiated (mid=%d rid=%d)", ext.midID, ext.ridID)
	}
	for _, tr := range pc.GetTransceivers() {
		if tr.Sender() == sender {
			ext.mid = tr.Mid()
		}
	}
	if ext.mid == "" {
		return nil, fmt.Errorf("sender transceiver MID unresolved")
	}
	return ext, nil
}

func videoMediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	// Mirror sfu/internal/peer.CreateAPI video feedback.
	for _, fb := range []webrtc.RTCPFeedback{
		{Type: "nack"},
		{Type: "nack", Parameter: "pli"},
		{Type: "goog-remb"},
		{Type: "ccm", Parameter: "fir"},
	} {
		m.RegisterFeedback(fb, webrtc.RTPCodecTypeVideo)
	}
	return m, nil
}

// waitICEConnected blocks until the PeerConnection reaches Connected/Completed.
func waitICEConnected(pc *webrtc.PeerConnection, timeout time.Duration) error {
	if pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
		return nil
	}
	ch := make(chan struct{}, 1)
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	})
	select {
	case <-ch:
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("ICE/DTLS did not connect within %s (state %s)", timeout, pc.ConnectionState())
	}
}

// videoPublisher holds the bench simulcast publisher, its layer tracks, and
// the per-layer header-extension values (nil entries = plain packets).
type videoPublisher struct {
	peer   *SFUPeer
	tracks [3]*webrtc.TrackLocalStaticRTP // f, h, q
	exts   [3]*videoExt
}

// connectVideoPublisher dials the SFU, negotiates a 3-layer VP8 simulcast
// uplink (or single-layer when simulcast=false, for screen shares), declares
// the kind via the video:/screen: signal, and returns once ICE connects.
func connectVideoPublisher(ctx context.Context, cfg Config, vs VoiceServerInfo, channelID, userID string, simulcast bool, screen bool) (*videoPublisher, error) {
	return connectVideoPublisherWithSettle(ctx, cfg, vs, channelID, userID, simulcast, screen, 500*time.Millisecond)
}

func connectVideoPublisherWithSettle(ctx context.Context, cfg Config, vs VoiceServerInfo, channelID, userID string, simulcast bool, screen bool, settle time.Duration) (*videoPublisher, error) {
	// Glare/retry: a crossed server renegotiation kills our offer (no
	// answer). Transient under load — retry the whole join.
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		var vp *videoPublisher
		vp, err = connectVideoPublisherAttempt(ctx, cfg, vs, channelID, userID, simulcast, screen, settle)
		if err == nil {
			return vp, nil
		}
		fmt.Printf("%s[warn] publisher connect attempt %d for %s failed: %v%s\n", colorYellow, attempt+1, userID, err, colorReset)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 500 * time.Millisecond):
		}
	}
	return nil, err
}

func connectVideoPublisherAttempt(ctx context.Context, cfg Config, vs VoiceServerInfo, channelID, userID string, simulcast bool, screen bool, settle time.Duration) (*videoPublisher, error) {
	pCtx, cancel := context.WithCancel(ctx)
	conn, err := dialSFUAndJoin(pCtx, cfg.SFUWS, vs.Token, channelID)
	if err != nil {
		cancel()
		return nil, err
	}

	m, err := videoMediaEngine()
	if err != nil {
		cancel()
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	peerObj := &SFUPeer{UserID: userID, PC: pc, Signaling: conn, Ctx: pCtx, Cancel: cancel}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cJSON := c.ToJSON()
		_ = wsjson.Write(pCtx, conn, map[string]any{"type": "candidate", "candidate": cJSON})
	})

	vp := &videoPublisher{peer: peerObj}
	rids := []string{"f"}
	if simulcast {
		rids = []string{"f", "h", "q"}
	}
	trackID := "bench-video"
	streamID := "bench-stream"
	if screen {
		trackID = "bench-screen"
		streamID = "bench-screen-stream"
	}
	for i, rid := range rids {
		tr, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: videoClockRate},
			trackID, streamID, webrtc.WithRTPStreamID(rid),
		)
		if err != nil {
			peerObj.Close()
			return nil, fmt.Errorf("create video track %s: %w", rid, err)
		}
		vp.tracks[i] = tr
	}

	sender, err := pc.AddTrack(vp.tracks[0])
	if err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("add video track: %w", err)
	}
	for _, tr := range vp.tracks[1:] {
		if tr == nil {
			continue
		}
		if err := sender.AddEncoding(tr); err != nil {
			peerObj.Close()
			return nil, fmt.Errorf("add simulcast encoding: %w", err)
		}
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("set local desc: %w", err)
	}

	// Pion generates the rid + simulcast block natively; the offer goes
	// out pristine (Pion rejects hand-edited local SDP).
	if err := wsjson.Write(pCtx, conn, map[string]any{"type": "offer", "sdp": offer.SDP}); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("send offer: %w", err)
	}
	answered := make(chan struct{}, 1)
	runSignalingLoopNotify(pCtx, cancel, conn, pc, func(msgType string) {
		if msgType == "answer" {
			select {
			case answered <- struct{}{}:
			default:
			}
		}
	})

	// Glare guard: if our offer is rejected server-side (e.g. it crossed
	// a server renegotiation under load), no answer ever arrives — fail
	// fast so the caller can retry instead of burning the ICE timeout.
	select {
	case <-answered:
	case <-time.After(8 * time.Second):
		peerObj.Close()
		return nil, fmt.Errorf("no SDP answer within 8s for user %s (likely signaling glare, retry)", userID)
	}

	if err := waitICEConnected(pc, 15*time.Second); err != nil {
		peerObj.Close()
		return nil, err
	}

	// Resolve MID/RID extension values for simulcast layers. The SFU
	// receiver needs these on every packet to map SSRCs to RIDs.
	if simulcast {
		for i, rid := range rids {
			ext, err := senderExtensions(pc, sender, rid)
			if err != nil {
				peerObj.Close()
				return nil, fmt.Errorf("resolve extensions for %s: %w", rid, err)
			}
			vp.exts[i] = ext
		}
	}

	// Declare the kind out-of-band (negotiate-once contract).
	kindMsg := map[string]any{"type": "video", "video": true}
	if screen {
		kindMsg = map[string]any{"type": "screen", "screen": true, "trackId": trackID}
	}
	if err := wsjson.Write(pCtx, conn, kindMsg); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("send kind signal: %w", err)
	}
	time.Sleep(settle) // let SetVideoKind fan out + renegotiation settle
	return vp, nil
}

// connectVideoSubscriber dials the SFU as a receive-only video viewer,
// retrying the join on signaling glare like the publisher path.
func connectVideoSubscriber(ctx context.Context, cfg Config, vs VoiceServerInfo, channelID, userID string) (*SFUPeer, error) {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		var s *SFUPeer
		s, err = connectVideoSubscriberAttempt(ctx, cfg, vs, channelID, userID)
		if err == nil {
			return s, nil
		}
		fmt.Printf("%s[warn] subscriber connect attempt %d for %s failed: %v%s\n", colorYellow, attempt+1, userID, err, colorReset)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 500 * time.Millisecond):
		}
	}
	return nil, err
}

func connectVideoSubscriberAttempt(ctx context.Context, cfg Config, vs VoiceServerInfo, channelID, userID string) (*SFUPeer, error) {
	pCtx, cancel := context.WithCancel(ctx)
	conn, err := dialSFUAndJoin(pCtx, cfg.SFUWS, vs.Token, channelID)
	if err != nil {
		cancel()
		return nil, err
	}

	m, err := videoMediaEngine()
	if err != nil {
		cancel()
		return nil, err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	peerObj := &SFUPeer{UserID: userID, PC: pc, Signaling: conn, Ctx: pCtx, Cancel: cancel}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cJSON := c.ToJSON()
		_ = wsjson.Write(pCtx, conn, map[string]any{"type": "candidate", "candidate": cJSON})
	})

	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("add video transceiver: %w", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("set local desc: %w", err)
	}
	if err := wsjson.Write(pCtx, conn, map[string]any{"type": "offer", "sdp": offer.SDP}); err != nil {
		peerObj.Close()
		return nil, fmt.Errorf("send offer: %w", err)
	}
	answered := make(chan struct{}, 1)
	runSignalingLoopNotify(pCtx, cancel, conn, pc, func(msgType string) {
		if msgType == "answer" {
			select {
			case answered <- struct{}{}:
			default:
			}
		}
	})

	select {
	case <-answered:
	case <-time.After(8 * time.Second):
		peerObj.Close()
		return nil, fmt.Errorf("no SDP answer within 8s for user %s (likely signaling glare, retry)", userID)
	}

	if err := waitICEConnected(pc, 15*time.Second); err != nil {
		peerObj.Close()
		return nil, err
	}
	return peerObj, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// VP8 synthetic media
// ─────────────────────────────────────────────────────────────────────────────

// vp8Payload builds a single-packet VP8 frame payload. keyframe=true emits a
// keyframe start (S=1, PID=0, frame-tag P=0) matching the SFU detector.
// Sizes are capped to maxFrameBytes: beyond ~1400B the UDP write path
// rejects packets (probed: >=1600B fails with "short buffer"), which also
// mirrors real VP8 packetization (encoders MTU-split at ~1200B).
func vp8Payload(keyframe bool, size int) []byte {
	if size < 4 {
		size = 4
	}
	p := make([]byte, size)
	p[0] = 0x10 // X=0,R=0,N=0,S=1,PartID=0
	p[1] = 0x00 // frame tag byte 0: P=0 (key) ...
	if !keyframe {
		p[1] = 0x01 // ... P=1 (interframe)
	}
	p[2] = 0x9d
	p[3] = 0x01
	return p
}

var vp8Detector = router.DetectorFor("video/VP8")

func isVP8KeyframeStart(payload []byte) bool {
	if vp8Detector == nil {
		return false
	}
	return vp8Detector.IsKeyframeStart(payload)
}

// streamLayer writes synthetic VP8 frames on one layer track at ~30fps:
// a keyframe every keyEvery frames, interframes otherwise. The first
// WriteRTP error is logged (unbound tracks fail silently otherwise).
// ext carries the MID/RID header extensions for simulcast layers;
// nil sends plain packets (single-layer screen shares).
func streamLayer(ctx context.Context, wg *sync.WaitGroup, track *webrtc.TrackLocalStaticRTP, ssrc uint32, seqStart uint16, keyEvery int, frameBytes int, ext *videoExt) {
	defer wg.Done()
	seq := seqStart
	ts := uint32(1000)
	frame := 0
	loggedErr := false
	tick := time.NewTicker(33 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		key := frame%keyEvery == 0
		hdr := rtp.Header{
			Version:        2,
			PayloadType:    videoPayload,
			SequenceNumber: seq,
			Timestamp:      ts,
			SSRC:           ssrc,
			Marker:         true,
		}
		if ext != nil {
			hdr.Extension = true
			hdr.ExtensionProfile = 0x1000
			_ = hdr.SetExtension(ext.midID, []byte(ext.mid))
			_ = hdr.SetExtension(ext.ridID, []byte(ext.rid))
		}
		pkt := &rtp.Packet{Header: hdr, Payload: vp8Payload(key, frameBytes)}
		if err := track.WriteRTP(pkt); err != nil && !loggedErr {
			loggedErr = true
			fmt.Printf("%s[streamLayer ssrc=%d] first WriteRTP error: %v%s\n", colorYellow, ssrc, err, colorReset)
		}
		seq++
		ts += 3000 // 90kHz / 30fps
		frame++
	}
}

// waitForDownlinks blocks until every drain has received at least minPkts
// packets (i.e. all downlinks flow media), so drill timelines start from a
// synchronized healthy call even when a join needed a glare retry.
func waitForDownlinks(drains []*videoDrain, minPkts int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ready := true
		for _, d := range drains {
			if atomic.LoadInt64(&d.packets) < minPkts {
				ready = false
				break
			}
		}
		if ready {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("not all downlinks flowing after %s", timeout)
}

// drainVideo consumes all inbound video RTP, counting packets and keyframes.
// It also records the downlink SSRC + last sequence number so injected RTCP
// feedback is addressed at the real downlink: the SFU routes inbound RTCP
// to read streams by DESTINATION SSRC (pion/srtp destinationSSRC), so wild
// SSRCs are dropped as "unhandled".
type videoDrain struct {
	packets   int64
	keyframes int64
	mediaSSRC uint32 // downlink SSRC from first received packet
	lastSeq   uint32 // last received sequence number
}

func (d *videoDrain) attach(pc *webrtc.PeerConnection) {
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			atomic.AddInt64(&d.packets, 1)
			// Track the LIVE downlink SSRC (not just the first): after a
			// layer switch the new downlink has a new SSRC, and RTCP must
			// target it or the SFU drops it as unhandled.
			atomic.StoreUint32(&d.mediaSSRC, uint32(pkt.SSRC))
			atomic.StoreUint32(&d.lastSeq, uint32(pkt.SequenceNumber))
			if isVP8KeyframeStart(pkt.Payload) {
				atomic.AddInt64(&d.keyframes, 1)
			}
		}
	})
}

func (d *videoDrain) ssrc() uint32 { return atomic.LoadUint32(&d.mediaSSRC) }

// sendRR injects a crafted ReceiverReport from a subscriber to steer its
// layer score: fractionLost is in 1/256 units (e.g. 26 ≈ 10%). mediaSSRC
// must be the subscriber's downlink SSRC (see videoDrain).
func sendRR(pc *webrtc.PeerConnection, fractionLost uint8, jitter uint32, mediaSSRC uint32) error {
	return pc.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverReport{
		SSRC: 0xBEEF,
		Reports: []rtcp.ReceptionReport{{
			SSRC:               mediaSSRC,
			FractionLost:       fractionLost,
			Jitter:             jitter,
			LastSequenceNumber: 12345,
		}},
	}})
}

// sendPLI fires one PictureLossIndication from a subscriber at mediaSSRC.
func sendPLI(pc *webrtc.PeerConnection, mediaSSRC uint32) error {
	return pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{
		SenderSSRC: 0xBEEF,
		MediaSSRC:  mediaSSRC,
	}})
}

// sendNACKBurst fires N NACKs for seqnos just below lastSeq (plausibly
// recent, so the SFU translator can map them) to raise repair effort.
func sendNACKBurst(pc *webrtc.PeerConnection, mediaSSRC uint32, lastSeq uint32, n int) error {
	for i := 0; i < n; i++ {
		nack := &rtcp.TransportLayerNack{
			SenderSSRC: 0xBEEF,
			MediaSSRC:  mediaSSRC,
			Nacks: []rtcp.NackPair{{
				PacketID:    uint16(lastSeq) - uint16((i+1)*7),
				LostPackets: 0x0001,
			}},
		}
		if err := pc.WriteRTCP([]rtcp.Packet{nack}); err != nil {
			return err
		}
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 1: PLI STORM (join/leave burst vs the 500ms limiter)
// ─────────────────────────────────────────────────────────────────────────────

func runPLIStormDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 1: PLI Storm vs Rate Limiter] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	const nSubs = 10
	room, err := setupVideoRoom(cfg, ctx, "plistorm", "PLIStormPass123!", nSubs)
	if err != nil {
		return err
	}
	defer room.close()

	before, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch baseline metrics: %w", err)
	}

	fmt.Println("==> Publisher streaming 3-layer VP8...")
	pub, err := connectVideoPublisher(ctx, cfg, room.pubVS, room.chanID, room.pubUser.ID, true, false)
	if err != nil {
		return fmt.Errorf("connect publisher: %w", err)
	}
	defer pub.peer.Close()

	streamCtx, stopStream := context.WithCancel(ctx)
	var streamWG sync.WaitGroup
	ssrcs := []uint32{0xF00001, 0xF00002, 0xF00003}
	for i, tr := range pub.tracks {
		streamWG.Add(1)
		go streamLayer(streamCtx, &streamWG, tr, ssrcs[i], uint16(1000*(i+1)), 30, 800, pub.exts[i])
	}
	defer func() { stopStream(); streamWG.Wait() }()

	time.Sleep(2 * time.Second) // let uplinks ingest + caches warm

	fmt.Printf("==> %d subscribers joining rapidly, each firing PLI bursts...\n", nSubs)
	var subs []*SFUPeer
	var drains []*videoDrain
	for i := range room.subUser {
		s, err := connectVideoSubscriber(ctx, cfg, room.subVS[i], room.chanID, room.subUser[i].ID)
		if err != nil {
			return fmt.Errorf("connect sub %d: %w", i, err)
		}
		subs = append(subs, s)
		d := &videoDrain{}
		d.attach(s.PC)
		drains = append(drains, d)
		time.Sleep(100 * time.Millisecond)
	}
	// Synchronize: all 10 downlinks must flow before the storm starts.
	if err := waitForDownlinks(drains, 30, 30*time.Second); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond) // settle

	// Storm: every sub fires 3 PLIs ~150ms apart inside ~1s, each
	// addressed at its own downlink SSRC.
	for round := 0; round < 3; round++ {
		for i, s := range subs {
			if ssrc := drains[i].ssrc(); ssrc != 0 {
				_ = sendPLI(s.PC, ssrc)
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	time.Sleep(1500 * time.Millisecond) // trailing coalesced forwards land

	for _, s := range subs {
		s.Close()
	}

	after, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch post-storm metrics: %w", err)
	}
	recv := after["sfu_pli_requests_received_total"] - before["sfu_pli_requests_received_total"]
	fwd := after["sfu_pli_requests_forwarded_total"] - before["sfu_pli_requests_forwarded_total"]
	rtcpPLI := after["sfu_rtcp_pli_total"] - before["sfu_rtcp_pli_total"]

	fmt.Printf("\n%s--- [PLI Limiter Audit] ---%s\n", colorBold, colorReset)
	fmt.Printf(" Subscriber RTCP PLIs arrived:  %.0f\n", rtcpPLI)
	fmt.Printf(" Limiter requests received:     %.0f\n", recv)
	fmt.Printf(" Limiter requests forwarded:    %.0f\n", fwd)
	if recv > 0 {
		fmt.Printf(" Coalescing ratio (recv/fwd):   %.1f:1\n", recv/max1(fwd))
	}

	if rtcpPLI < nSubs {
		return fmt.Errorf("only %.0f PLIs arrived, want >= %d", rtcpPLI, nSubs)
	}
	if fwd > 6 {
		return fmt.Errorf("limiter forwarded %.0f PLIs during storm, want <= 6 (500ms window + settle)", fwd)
	}
	if recv > 0 && recv/max1(fwd) < 3 {
		return fmt.Errorf("coalescing ratio %.1f:1 too low, want >= 3:1", recv/max1(fwd))
	}
	fmt.Printf("%s✓ PLI Limiter Invariant: %.0f requests coalesced to %.0f publisher keyframes.%s\n", colorGreen, recv, fwd, colorReset)
	return nil
}

func max1(v float64) float64 {
	if v < 1 {
		return 1
	}
	return v
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 2: THROTTLED SIMULCAST SWITCHING (per-sub RTCP injection)
// ─────────────────────────────────────────────────────────────────────────────

func runLayerThrottleDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 2: Throttled Simulcast Switching] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	room, err := setupVideoRoom(cfg, ctx, "layerthrottle", "LayerPass123!", 3)
	if err != nil {
		return err
	}
	defer room.close()

	before, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch baseline metrics: %w", err)
	}

	fmt.Println("==> Publisher streaming 3-layer VP8 (keyframes every ~1s/layer)...")
	pub, err := connectVideoPublisher(ctx, cfg, room.pubVS, room.chanID, room.pubUser.ID, true, false)
	if err != nil {
		return fmt.Errorf("connect publisher: %w", err)
	}
	defer pub.peer.Close()

	streamCtx, stopStream := context.WithCancel(ctx)
	var streamWG sync.WaitGroup
	ssrcs := []uint32{0xE00001, 0xE00002, 0xE00003}
	sizes := []int{1200, 600, 250} // f biggest, q smallest (observability only)
	for i, tr := range pub.tracks {
		streamWG.Add(1)
		go streamLayer(streamCtx, &streamWG, tr, ssrcs[i], uint16(2000*(i+1)), 30, sizes[i], pub.exts[i])
	}
	defer func() { stopStream(); streamWG.Wait() }()

	fmt.Println("==> 3 subscribers joining (clean / degraded / severe)...")
	var subs []*SFUPeer
	var drains []*videoDrain
	for i := range room.subUser {
		s, err := connectVideoSubscriber(ctx, cfg, room.subVS[i], room.chanID, room.subUser[i].ID)
		if err != nil {
			return fmt.Errorf("connect sub %d: %w", i, err)
		}
		subs = append(subs, s)
		d := &videoDrain{}
		d.attach(s.PC)
		drains = append(drains, d)
	}
	// Synchronize: injection starts from a healthy call even if a join
	// needed a glare retry.
	if err := waitForDownlinks(drains, 30, 30*time.Second); err != nil {
		return err
	}

	// Loss profiles: sub0 clean (stays f), sub1 ~8% (drops to h),
	// sub2 ~35% + NACK bursts (drops f->h->q). eval tick 1s, cooldown 10s:
	// budget ~18s for the full cascade.
	// Two-phase profiles. Phase 1 (6s): sub1 ~10% (f->h), sub2 ~35%
	// (f->h). Phase 2 (12s): sub1 drops to ~3% — below the 5% DOWN
	// threshold but above the 1% good threshold, so its EWMA settles in
	// the hold band (no further DOWN, no UP: stays h). Sub2 stays at
	// ~35% and cascades h->q after the 10s cooldown. Sub0 clean on f.
	fmt.Println("==> Injecting per-subscriber loss profiles (phase 1: 6s)...")
	phase2At := time.Now().Add(6 * time.Second)
	phase2Logged := false
	deadline := time.Now().Add(18 * time.Second)
	for time.Now().Before(deadline) {
		moderate := time.Now().After(phase2At)
		if moderate && !phase2Logged {
			phase2Logged = true
			fmt.Println("==> Phase 2: sub1 holding at ~3%...")
		}
		for i, s := range subs {
			ssrc := drains[i].ssrc()
			if ssrc == 0 {
				continue // no downlink media yet
			}
			switch i {
			case 0:
				_ = sendRR(s.PC, 0, 5, ssrc)
			case 1:
				if moderate {
					_ = sendRR(s.PC, 8, 30, ssrc) // ~3.1%: hold band
				} else {
					_ = sendRR(s.PC, 26, 30, ssrc) // ~10%: f->h
				}
			default:
				_ = sendRR(s.PC, 90, 60, ssrc) // ~35%: f->h->q
				_ = sendNACKBurst(s.PC, ssrc, drains[i].lastSeq, 2)
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context done during injection")
		case <-time.After(1 * time.Second):
		}
	}
	time.Sleep(2 * time.Second) // last switches + metric settle

	after, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch post drill metrics: %w", err)
	}
	layerF := after[`sfu_layer_distribution{layer="f"}`] - 0 // gauges: absolute
	layerH := after[`sfu_layer_distribution{layer="h"}`]
	layerQ := after[`sfu_layer_distribution{layer="q"}`]
	down := after[`sfu_layer_switches_total{direction="down"}`] - before[`sfu_layer_switches_total{direction="down"}`]
	up := after[`sfu_layer_switches_total{direction="up"}`] - before[`sfu_layer_switches_total{direction="up"}`]

	fmt.Printf("\n%s--- [Layer Switching Audit] ---%s\n", colorBold, colorReset)
	fmt.Printf(" Downlink distribution: f=%.0f h=%.0f q=%.0f\n", layerF, layerH, layerQ)
	fmt.Printf(" Switches during drill: down=%.0f up=%.0f\n", down, up)
	for i, d := range drains {
		fmt.Printf(" Sub%d received: %d packets / %d keyframes\n", i, atomic.LoadInt64(&d.packets), atomic.LoadInt64(&d.keyframes))
	}

	if down < 1 {
		return fmt.Errorf("no DOWN switches observed (want >= 1)")
	}
	if layerH < 1 || layerQ < 1 {
		return fmt.Errorf("subscribers did not stabilize on distinct layers (f=%.0f h=%.0f q=%.0f)", layerF, layerH, layerQ)
	}
	if down > 8 {
		return fmt.Errorf("%.0f DOWN switches look like flapping (want <= 8 over ~20s)", down)
	}
	for i, d := range drains {
		if atomic.LoadInt64(&d.packets) == 0 {
			return fmt.Errorf("sub%d received zero packets", i)
		}
	}
	fmt.Printf("%s✓ Layer Switching Invariant: clean->f, degraded->h, severe->q with %.0f bounded DOWN switches.%s\n", colorGreen, down, colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 3: SCREEN SHARE DETAIL (metrics-only)
// ─────────────────────────────────────────────────────────────────────────────

func runScreenDetailDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 3: Screen Share Detail Verification] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	room, err := setupVideoRoom(cfg, ctx, "screendetail", "ScreenPass123!", 1)
	if err != nil {
		return err
	}
	defer room.close()

	before, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch baseline metrics: %w", err)
	}

	fmt.Println("==> Publisher sharing screen (single-layer f)...")
	pub, err := connectVideoPublisher(ctx, cfg, room.pubVS, room.chanID, room.pubUser.ID, false, true)
	if err != nil {
		return fmt.Errorf("connect screen publisher: %w", err)
	}
	defer pub.peer.Close()

	streamCtx, stopStream := context.WithCancel(ctx)
	var streamWG sync.WaitGroup
	streamWG.Add(1)
	// Low-motion screen content: keyframe every 60 (~2s). Frame bytes stay
	// under the ~1400B UDP write ceiling (see vp8Payload).
	go streamLayer(streamCtx, &streamWG, pub.tracks[0], 0xD00001, 3000, 60, 1200, nil)
	defer func() { stopStream(); streamWG.Wait() }()

	sub, err := connectVideoSubscriber(ctx, cfg, room.subVS[0], room.chanID, room.subUser[0].ID)
	if err != nil {
		return fmt.Errorf("connect sub: %w", err)
	}
	defer sub.Close()
	d := &videoDrain{}
	d.attach(sub.PC)

	time.Sleep(4 * time.Second)
	if ssrc := d.ssrc(); ssrc != 0 {
		_ = sendPLI(sub.PC, ssrc) // keyframe round-trip on screen content
	}
	time.Sleep(2 * time.Second)

	after, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch post drill metrics: %w", err)
	}
	fwd := after["sfu_packets_forwarded_total"] - before["sfu_packets_forwarded_total"]
	pliRecv := after["sfu_pli_requests_received_total"] - before["sfu_pli_requests_received_total"]
	pliFwd := after["sfu_pli_requests_forwarded_total"] - before["sfu_pli_requests_forwarded_total"]
	switches := (after[`sfu_layer_switches_total{direction="down"}`] - before[`sfu_layer_switches_total{direction="down"}`]) +
		(after[`sfu_layer_switches_total{direction="up"}`] - before[`sfu_layer_switches_total{direction="up"}`])
	recv := atomic.LoadInt64(&d.packets)
	keys := atomic.LoadInt64(&d.keyframes)

	fmt.Printf("\n%s--- [Screen Share Audit] ---%s\n", colorBold, colorReset)
	fmt.Printf(" SFU packets forwarded (delta): %.0f\n", fwd)
	fmt.Printf(" Subscriber received: %d packets / %d keyframes\n", recv, keys)
	fmt.Printf(" Bench PLI received by limiter: %.0f\n", pliRecv)
	fmt.Printf(" PLI forwarded to screen pub:  %.0f\n", pliFwd)
	fmt.Printf(" Layer switches (must be 0):   %.0f\n", switches)

	if recv == 0 {
		return fmt.Errorf("subscriber received zero screen packets")
	}
	if keys == 0 {
		return fmt.Errorf("subscriber never got a screen keyframe")
	}
	if pliRecv < 1 {
		return fmt.Errorf("bench PLI never reached the limiter (RTCP addressing wrong)")
	}
	if pliFwd < 1 {
		return fmt.Errorf("PLI was not forwarded to the screen publisher")
	}
	if switches != 0 {
		return fmt.Errorf("screen uplink was layer-switched (%.0f), must stay f-only", switches)
	}
	fmt.Printf("%s✓ Screen Detail Invariant: single-layer f screen stable, PLI round-trip works, no switching.%s\n", colorGreen, colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILL 4: VIDEO FAILOVER (SIGKILL -> first keyframe < 2s)
// ─────────────────────────────────────────────────────────────────────────────

// waitKillFile blocks until the orchestrator writes the kill timestamp
// (epoch nanos) — the shell records it right after issuing SIGKILL, so
// kill->recovery is measured from the true kill instant instead of the
// (TCP-timeout-inflated) socket-drop observation.
func waitKillFile(path string, timeout time.Duration) (time.Time, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil {
			var nanos int64
			if _, err := fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &nanos); err == nil && nanos > 0 {
				return time.Unix(0, nanos), true
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return time.Time{}, false
}

func runVideoFailoverDrill(cfg Config) error {
	fmt.Printf("\n%s--- [DRILL 4: Mid-Call SFU SIGKILL -> First Video Keyframe] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	room, err := setupVideoRoom(cfg, ctx, "videofailover", "VideoFailPass123!", 2)
	if err != nil {
		return err
	}
	defer room.close()

	fmt.Println("==> Establishing video call (1 publisher + 2 subscribers)...")
	pub, err := connectVideoPublisher(ctx, cfg, room.pubVS, room.chanID, room.pubUser.ID, true, false)
	if err != nil {
		return fmt.Errorf("connect publisher: %w", err)
	}
	defer pub.peer.Close()

	var subs []*SFUPeer
	var drains []*videoDrain
	for i := range room.subUser {
		s, err := connectVideoSubscriber(ctx, cfg, room.subVS[i], room.chanID, room.subUser[i].ID)
		if err != nil {
			return fmt.Errorf("connect sub %d: %w", i, err)
		}
		subs = append(subs, s)
		d := &videoDrain{}
		d.attach(s.PC)
		drains = append(drains, d)
	}

	streamCtx, stopStream := context.WithCancel(ctx)
	var streamWG sync.WaitGroup
	ssrcs := []uint32{0xC00001, 0xC00002, 0xC00003}
	for i, tr := range pub.tracks {
		streamWG.Add(1)
		go streamLayer(streamCtx, &streamWG, tr, ssrcs[i], uint16(4000*(i+1)), 30, 800, pub.exts[i])
	}

	time.Sleep(2 * time.Second)
	fmt.Printf("Pre-kill check: sub0=%d sub1=%d packets\n",
		atomic.LoadInt64(&drains[0].packets), atomic.LoadInt64(&drains[1].packets))
	if atomic.LoadInt64(&drains[0].packets) == 0 || atomic.LoadInt64(&drains[1].packets) == 0 {
		stopStream()
		streamWG.Wait()
		return fmt.Errorf("call not healthy before kill")
	}
	fmt.Printf("%s[READY_FOR_KILL]%s Signaling orchestrator to SIGKILL SFU container...\n", colorYellow, colorReset)

	// Kill evidence, in order of truth: (1) the orchestrator's kill
	// timestamp file (true kill instant — socket-drop observation lags
	// ~1.5s behind the kill on blackholed TCP); (2) socket death.
	sfuDisconnected := make(chan struct{})
	go func() {
		for {
			var m map[string]any
			if err := wsjson.Read(ctx, pub.peer.Signaling, &m); err != nil {
				close(sfuDisconnected)
				return
			}
		}
	}()

	killTime := time.Now()
	if cfg.KillFile != "" {
		if ts, ok := waitKillFile(cfg.KillFile, 30*time.Second); ok {
			killTime = ts
			fmt.Printf("Kill timestamp from orchestrator: %s\n", killTime.Format("15:04:05.000"))
		}
	}
	select {
	case <-sfuDisconnected:
		fmt.Printf("%s✓ Client observed socket termination from killed SFU.%s\n", colorGreen, colorReset)
	case <-time.After(30 * time.Second):
		stopStream()
		streamWG.Wait()
		return fmt.Errorf("timed out waiting for SFU socket drop after kill")
	}
	stopStream()
	streamWG.Wait()
	pub.peer.Close()
	for _, s := range subs {
		s.Close()
	}

	// Wait for the SFU to come back.
	healthURL := strings.Replace(cfg.SFUWS, "ws://", "http://", 1)
	healthURL = strings.TrimSuffix(healthURL, "/ws") + "/healthz"
	recovered := false
	var restartTime time.Time
	for time.Since(killTime) < 15*time.Second {
		resp, err := http.Get(healthURL)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			recovered = true
			restartTime = time.Now()
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !recovered {
		return fmt.Errorf("SFU failed to recover within 15 seconds")
	}
	fmt.Printf("%s✓ SFU service restored %.2fs after kill. Rejoining call...%s\n", colorGreen, time.Since(killTime).Seconds(), colorReset)

	// Fresh voice tokens via gateway rejoin (gateway sessions survived).
	_ = wsjson.Write(ctx, room.pubGW.Conn, map[string]any{
		"op": 4, "d": map[string]any{"guild_id": room.guildID, "channel_id": room.chanID, "self_mute": false, "self_deaf": false},
	})
	for _, g := range room.subGW {
		_ = wsjson.Write(ctx, g.Conn, map[string]any{
			"op": 4, "d": map[string]any{"guild_id": room.guildID, "channel_id": room.chanID, "self_mute": false, "self_deaf": false},
		})
	}
	select {
	case room.pubVS = <-room.pubGW.VoiceServerChan:
	case <-time.After(10 * time.Second):
		return fmt.Errorf("no fresh token for publisher after restart")
	}
	room.subVS = nil
	for i, g := range room.subGW {
		select {
		case vs := <-g.VoiceServerChan:
			room.subVS = append(room.subVS, vs)
		case <-time.After(10 * time.Second):
			return fmt.Errorf("no fresh token for sub %d after restart", i)
		}
	}

	pubReconnStart := time.Now()
	rePub, err := connectVideoPublisherWithSettle(ctx, cfg, room.pubVS, room.chanID, room.pubUser.ID, true, false, 100*time.Millisecond)
	if err != nil {
		return fmt.Errorf("reconnect publisher: %w", err)
	}
	defer rePub.peer.Close()

	// Reconnect subscribers in parallel: serial ICE would cost ~500ms each.
	firstKey := make([]chan time.Time, len(room.subUser))
	for i := range firstKey {
		firstKey[i] = make(chan time.Time, 1)
	}
	type subResult struct {
		idx int
		sub *SFUPeer
		err error
	}
	subCh := make(chan subResult, len(room.subUser))
	for i := range room.subUser {
		go func(i int) {
			s, err := connectVideoSubscriber(ctx, cfg, room.subVS[i], room.chanID, room.subUser[i].ID)
			subCh <- subResult{idx: i, sub: s, err: err}
		}(i)
	}
	for range room.subUser {
		res := <-subCh
		if res.err != nil {
			return fmt.Errorf("reconnect sub %d: %w", res.idx, res.err)
		}
		defer res.sub.Close()
		idx := res.idx
		res.sub.PC.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			for {
				pkt, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				if isVP8KeyframeStart(pkt.Payload) {
					select {
					case firstKey[idx] <- time.Now():
					default:
					}
					return
				}
			}
		})
	}
	fmt.Printf("Rejoin complete: publisher %.2fs, all subs %.2fs after restart\n",
		time.Since(pubReconnStart).Seconds(), time.Since(restartTime).Seconds())

	// Publisher resumes with an immediate keyframe burst so the fresh SFU
	// (empty keyframe cache) has an anchor within milliseconds.
	restreamCtx, restop := context.WithCancel(ctx)
	var restreamWG sync.WaitGroup
	for i, tr := range rePub.tracks {
		restreamWG.Add(1)
		go func(i int, tr *webrtc.TrackLocalStaticRTP) {
			defer restreamWG.Done()
			seq := uint16(5000 + i*1000)
			ts := uint32(777000)
			// Burst: first 10 frames are all keyframes, then steady 30fps.
			for f := 0; ; f++ {
				select {
				case <-restreamCtx.Done():
					return
				default:
				}
				key := f < 10 || f%30 == 0
				hdr := rtp.Header{Version: 2, PayloadType: videoPayload, SequenceNumber: seq, Timestamp: ts, SSRC: ssrcs[i], Marker: true}
				if ext := rePub.exts[i]; ext != nil {
					hdr.Extension = true
					hdr.ExtensionProfile = 0x1000
					_ = hdr.SetExtension(ext.midID, []byte(ext.mid))
					_ = hdr.SetExtension(ext.ridID, []byte(ext.rid))
				}
				pkt := &rtp.Packet{Header: hdr, Payload: vp8Payload(key, 800)}
				_ = tr.WriteRTP(pkt)
				seq++
				ts += 3000
				if f < 10 {
					time.Sleep(20 * time.Millisecond)
				} else {
					time.Sleep(33 * time.Millisecond)
				}
			}
		}(i, tr)
	}
	defer func() { restop(); restreamWG.Wait() }()

	var worst time.Duration
	for i, ch := range firstKey {
		select {
		case t := <-ch:
			d := t.Sub(killTime)
			fmt.Printf("Sub%d first post-kill keyframe: %.2fs after kill\n", i, d.Seconds())
			if d > worst {
				worst = d
			}
		case <-time.After(15 * time.Second):
			restop()
			return fmt.Errorf("sub%d never received a post-kill keyframe", i)
		}
	}

	fmt.Printf("\nKill -> first video keyframe (worst sub): %.2f seconds\n", worst.Seconds())
	if worst > 2*time.Second {
		return fmt.Errorf("video recovery took %.2fs (exceeded 2s target)", worst.Seconds())
	}
	fmt.Printf("%s✓ Video Failover Invariant: call survived SIGKILL, first keyframes in %.2fs!%s\n", colorGreen, worst.Seconds(), colorReset)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOURCE SNAPSHOT (postmortem evidence)
// ─────────────────────────────────────────────────────────────────────────────

// runResourceSnapshot scrapes SFU /metrics + docker stats and appends a TSV
// row labeled `label` to the snapshot file. Labels: before/drill name/after.
func runResourceSnapshot(cfg Config, label, snapshotFile, container string) error {
	m, err := fetchSFUMetrics(cfg.SFUMetrics)
	if err != nil {
		return fmt.Errorf("fetch sfu metrics: %w", err)
	}

	dockerOut := ""
	if container != "" {
		out, err := exec.Command("docker", "stats", "--no-stream", "--format",
			"{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}", container).Output()
		if err == nil {
			dockerOut = strings.TrimSpace(string(out))
		} else {
			dockerOut = "docker-stats-unavailable"
		}
	}

	get := func(k string) float64 { return m[k] }
	row := fmt.Sprintf("%s\t%s\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%s\n",
		time.Now().UTC().Format(time.RFC3339), label,
		get("go_goroutines"),
		get("go_memstats_heap_alloc_bytes"),
		get("go_memstats_heap_sys_bytes"),
		get("go_memstats_stack_inuse_bytes"),
		get("process_resident_memory_bytes"),
		get("process_cpu_seconds_total"),
		get("sfu_active_rooms"),
		get("sfu_connected_peers"),
		get("sfu_sub_queue_depth"),
		get("sfu_packets_forwarded_total"),
		get("sfu_packets_dropped_total"),
		get("sfu_rtcp_nack_total"),
		dockerOut,
	)
	fmt.Printf("%s", row)
	if snapshotFile != "" {
		f, err := openAppend(snapshotFile)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := f.WriteString(row); err != nil {
			return err
		}
	}
	return nil
}
