package main

// Phase 7d pool failover drill (Issue #87, Step 6b).
//
// Unlike video_failover (restart-in-place: kill -> wait for the SAME SFU ->
// rejoin), this drill kills the placed SFU and does NOT restart it: every
// member must land on the PEER sfu via gateway placement.
//
// Contract under test, end to end:
//  1. Pre-kill co-location: all members' VOICE_SERVER_UPDATEs point at the
//     same endpoint (channel-assigned placement, Step 2).
//  2. Kill evidence: orchestrator KillFile timestamp (true kill instant) +
//     client-observed socket drop.
//  3. Failover: each member re-requests via Op 4 (mirrors the Step 3c client
//     hint) and/or receives the Step 4 null-then-reallocate push. First
//     non-empty endpoint != dead wins; a null must always be followed by a
//     reallocation (ordering assertion).
//  4. Post-kill co-location: all final endpoints identical and != dead.
//  5. Media: kill -> first post-kill video keyframe <= 2s (worst sub).
//
// Dialing follows placement: the drill dials vs.Endpoint (gateway-assigned),
// mapped to host-dialable URLs by sfuWSForEndpoint (the driver runs on host;
// compose service names only resolve in-container).

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// sfuWSForEndpoint maps a gateway-placed endpoint to a WS URL dialable from
// the drill driver (host network). Compose service names (sfu, sfu-2) only
// resolve inside containers; the published host ports mirror them.
func sfuWSForEndpoint(endpoint string) string {
	ep := strings.TrimSpace(endpoint)
	if strings.HasPrefix(ep, "ws://") || strings.HasPrefix(ep, "wss://") {
		if strings.HasSuffix(ep, "/ws") {
			return ep
		}
		return strings.TrimSuffix(ep, "/") + "/ws"
	}
	ep = strings.TrimPrefix(strings.TrimPrefix(ep, "http://"), "https://")
	host, port, found := strings.Cut(ep, ":")
	if !found {
		host, port = ep, "5000"
	}
	switch host {
	case "sfu", "sfu-2", "sfu.kith.local", "localhost", "":
		host = "127.0.0.1"
	}
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("ws://%s:%s/ws", host, port)
}

// poolPlacedEndpoint extracts the raw endpoint the gateway assigned
// ("" = null: reallocation in progress).
func poolPlacedEndpoint(vs VoiceServerInfo) string {
	return strings.TrimSpace(vs.Endpoint)
}

// poolDeadEndpoint extracts the dead_endpoint annotation on null pushes
// ("" when absent: legacy push, always actionable).
func poolDeadEndpoint(vs VoiceServerInfo) string {
	return strings.TrimSpace(vs.DeadEndpoint)
}

func runPoolFailoverDrill(cfg Config) error {
	fmt.Printf("\n%s--- [POOL FAILOVER: Mid-Call SFU SIGKILL -> Peer SFU (no restart)] ---%s\n", colorBold, colorReset)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	room, err := setupVideoRoom(cfg, ctx, "poolfailover", "PoolFailPass123!", 2)
	if err != nil {
		return err
	}
	defer room.close()

	// 1. Pre-kill co-location: every member placed together.
	placed := poolPlacedEndpoint(room.pubVS)
	if placed == "" {
		return fmt.Errorf("publisher has empty voice endpoint pre-kill")
	}
	for i, vs := range room.subVS {
		if poolPlacedEndpoint(vs) != placed {
			return fmt.Errorf("pre-kill split-brain: pub on %q but sub %d on %q", placed, i, poolPlacedEndpoint(vs))
		}
	}
	fmt.Printf("%s[PLACED_ON %s]%s all 3 members co-located pre-kill\n", colorYellow, placed, colorReset)

	// Dial what the gateway told us (not the static -sfu flag).
	cfg.SFUWS = sfuWSForEndpoint(placed)
	fmt.Printf("Dialing assigned SFU: %s\n", cfg.SFUWS)

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
	ssrcs := []uint32{0xD00001, 0xD00002, 0xD00003}
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
	fmt.Printf("%s[READY_FOR_KILL]%s Signaling orchestrator to SIGKILL the placed SFU (no restart)...\n", colorYellow, colorReset)

	// 2. Kill evidence: orchestrator timestamp + socket drop.
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
		fmt.Printf("%s✓ Client observed socket termination from killed SFU (%.2fs after kill).%s\n", colorGreen, time.Since(killTime).Seconds(), colorReset)
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

	dead := placed

	// 3. Failover: re-request via Op 4 (Step 3c hint) and collect the first
	// good endpoint per member — whether it arrives as the Op 4 answer
	// (confirm-path fast lane) or the Step 4 null-then-reallocate push.
	// A null must always be followed by a reallocation (ordering).
	sendReOp4 := func(gw *GatewayVoiceSession) {
		_ = wsjson.Write(ctx, gw.Conn, map[string]any{
			"op": 4, "d": map[string]any{"guild_id": room.guildID, "channel_id": room.chanID, "self_mute": false, "self_deaf": false},
		})
	}
	sendReOp4(room.pubGW)
	for _, g := range room.subGW {
		sendReOp4(g)
	}

	collectGood := func(gw *GatewayVoiceSession, who string) (VoiceServerInfo, bool, error) {
		sawNull := false
		timeout := time.After(25 * time.Second)
		for {
			select {
			case vs := <-gw.VoiceServerChan:
				ep := poolPlacedEndpoint(vs)
				if ep == "" {
					sawNull = true
					fmt.Printf("  [%s] observed null-endpoint (reallocation in progress)\n", who)
					continue
				}
				if ep == dead {
					fmt.Printf("  [%s] WARNING: placed back on dead %q, continuing to wait\n", who, ep)
					continue
				}
				fmt.Printf("  [%s] good endpoint %q (%.2fs after kill, sawNull=%v)\n", who, ep, time.Since(killTime).Seconds(), sawNull)
				return vs, sawNull, nil
			case <-timeout:
				return VoiceServerInfo{}, sawNull, fmt.Errorf("%s: no good endpoint within 25s (sawNull=%v)", who, sawNull)
			case <-ctx.Done():
				return VoiceServerInfo{}, sawNull, ctx.Err()
			}
		}
	}

	newPubVS, pubSawNull, err := collectGood(room.pubGW, "pub")
	if err != nil {
		return err
	}
	newSubVS := make([]VoiceServerInfo, len(room.subGW))
	nullCount := 0
	if pubSawNull {
		nullCount++
	}
	for i, g := range room.subGW {
		vs, sawNull, err := collectGood(g, fmt.Sprintf("sub%d", i))
		if err != nil {
			return err
		}
		newSubVS[i] = vs
		if sawNull {
			nullCount++
		}
	}
	fmt.Printf("Null-then-reallocate observed by %d/3 members (remainder took the confirm fast lane)\n", nullCount)

	// 4. Post-kill co-location: all on the same survivor, none on the dead.
	survivor := poolPlacedEndpoint(newPubVS)
	for i, vs := range newSubVS {
		if ep := poolPlacedEndpoint(vs); ep != survivor {
			return fmt.Errorf("post-kill split-brain: pub on %q but sub %d on %q", survivor, i, ep)
		}
	}
	if survivor == dead {
		return fmt.Errorf("post-kill placement still on dead endpoint %q", dead)
	}
	fmt.Printf("%s✓ Post-kill co-location: all 3 on %s (dead was %s)%s\n", colorGreen, survivor, dead, colorReset)

	// 5. Rebuild media on the survivor; measure kill -> first keyframe.
	cfg.SFUWS = sfuWSForEndpoint(survivor)
	fmt.Printf("Re-dialing survivor SFU: %s\n", cfg.SFUWS)

	reconnStart := time.Now()
	rePub, err := connectVideoPublisherWithSettle(ctx, cfg, newPubVS, room.chanID, room.pubUser.ID, true, false, 100*time.Millisecond)
	if err != nil {
		return fmt.Errorf("reconnect publisher: %w", err)
	}
	defer rePub.peer.Close()

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
			s, err := connectVideoSubscriber(ctx, cfg, newSubVS[i], room.chanID, room.subUser[i].ID)
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
	fmt.Printf("Rejoin complete in %.2fs\n", time.Since(reconnStart).Seconds())

	restreamCtx, restop := context.WithCancel(ctx)
	var restreamWG sync.WaitGroup
	for i, tr := range rePub.tracks {
		restreamWG.Add(1)
		go func(i int, tr *webrtc.TrackLocalStaticRTP) {
			defer restreamWG.Done()
			seq := uint16(5000 + i*1000)
			ts := uint32(777000)
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

	fmt.Printf("\nKill -> first video keyframe on peer SFU (worst sub): %.2f seconds\n", worst.Seconds())
	if worst > 2*time.Second {
		return fmt.Errorf("pool recovery took %.2fs (exceeded 2s target)", worst.Seconds())
	}
	fmt.Printf("%s✓ Pool Failover Invariant: call survived SIGKILL with NO restart, all 3 co-located on peer, first keyframes in %.2fs!%s\n", colorGreen, worst.Seconds(), colorReset)

	// 6. Steady-state control: healthy re-requests must NOT move. Re-Op 4
	// twice per member; every answer must repeat the survivor endpoint.
	// Nulls are classified like a real client (Step 4 stale-null guard):
	// a null is ACTIONABLE only when it names our live endpoint (or names
	// nothing — legacy). A null naming the SFU we already left is the late
	// poller flip arriving after the confirm fast lane moved us — expected,
	// ignore it.
	fmt.Println("==> Control: healthy re-requests stay on the survivor...")
	liveByMember := map[int]string{0: survivor}
	for i, vs := range newSubVS {
		liveByMember[i+1] = poolPlacedEndpoint(vs)
	}
	allGW := append([]*GatewayVoiceSession{room.pubGW}, room.subGW...)
	for round := 0; round < 2; round++ {
		for _, g := range allGW {
			_ = wsjson.Write(ctx, g.Conn, map[string]any{
				"op": 4, "d": map[string]any{"guild_id": room.guildID, "channel_id": room.chanID, "self_mute": false, "self_deaf": false},
			})
		}
		for i, g := range allGW {
			select {
			case vs := <-g.VoiceServerChan:
				ep := poolPlacedEndpoint(vs)
				if ep == "" {
					// Stale-null guard, driver side (mirrors the client):
					// actionable only when it names our live endpoint.
					if dead := poolDeadEndpoint(vs); dead == "" || dead == liveByMember[i] {
						restop()
						return fmt.Errorf("control: member %d got actionable null on healthy pool (dead=%q)", i, dead)
					}
					fmt.Printf("  [member %d] ignoring stale null for %q (live on %q)\n", i, poolDeadEndpoint(vs), liveByMember[i])
					continue
				}
				if ep != survivor {
					restop()
					return fmt.Errorf("control: member %d moved %q -> %q on healthy pool", i, survivor, ep)
				}
				liveByMember[i] = ep
			case <-time.After(10 * time.Second):
				restop()
				return fmt.Errorf("control: member %d got no answer to healthy re-request", i)
			}
		}
	}
	// And no ACTIONABLE null within a quiet window (stale ones are fine).
	quiet := time.After(3 * time.Second)
drainLoop:
	for {
		select {
		case vs := <-room.pubGW.VoiceServerChan:
			if poolPlacedEndpoint(vs) == "" && (poolDeadEndpoint(vs) == "" || poolDeadEndpoint(vs) == liveByMember[0]) {
				restop()
				return fmt.Errorf("control: actionable null on healthy pool")
			}
		case vs := <-room.subGW[0].VoiceServerChan:
			if poolPlacedEndpoint(vs) == "" && (poolDeadEndpoint(vs) == "" || poolDeadEndpoint(vs) == liveByMember[1]) {
				restop()
				return fmt.Errorf("control: actionable null on healthy pool")
			}
		case vs := <-room.subGW[1].VoiceServerChan:
			if poolPlacedEndpoint(vs) == "" && (poolDeadEndpoint(vs) == "" || poolDeadEndpoint(vs) == liveByMember[2]) {
				restop()
				return fmt.Errorf("control: actionable null on healthy pool")
			}
		case <-quiet:
			break drainLoop
		case <-ctx.Done():
			restop()
			return ctx.Err()
		}
	}
	fmt.Printf("%s✓ Steady-State Control: healthy re-requests stable on %s, stale nulls ignored, zero actionable nulls%s\n", colorGreen, survivor, colorReset)
	return nil
}
