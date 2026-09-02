# 07 — Voice & Video (WebRTC, P2P → own SFU w/ Pion)

> Phases 5–6. The biggest file in the plan — WebRTC is a *protocol suite*, not
> a library. The learning path is deliberately: raw protocols first (P2P mesh),
> then your own SFU. No LiveKit, no mediasoup, no black boxes.

## 0. Mental model (read this whole section before writing any code)

WebRTC = a stack of five problems, each with its own protocol:

```
┌─────────────────────────────────────────────────┐
│ MEDIA          audio/video codecs (Opus, VP8/9, H.264, AV1)     │
│                packaged in RTP, timed by RTCP                    │
│ SECURITY       DTLS handshake keys every session; SRTP encrypts  │
│                all RTP (mandated, no plaintext media)            │
│ TRANSPORT      ICE finds a usable network path between peers     │
│                (STUN for public addr, TURN to relay when stuck)  │
│ NEGOTIATION    SDP offer/answer: "here's my codecs and candidates"│
│ SIGNALING      how offers/answers/ICE candidates travel between  │
│                peers — ★WebRTC does NOT define this. It's YOURS. │★
└─────────────────────────────────────────────────┘
```

Your signaling server = the Elixir gateway (a `VOICE_STATE_UPDATE` /
`VOICE_SIGNALING` dispatch over the existing WebSocket). Everything above the
dashed line is browser/native WebRTC until Phase 5.5, when Pion takes over the
media plane. This mapping — *signaling rides your existing realtime infra* —
is exactly Discord's shape.

Key vocabulary you must be able to explain out loud by end of Phase 5:
SDP, offer/answer, ICE candidate, host/srflx/relay candidate, STUN, TURN,
DTLS-SRTP, RTP/RTCP, SSRC, payload type, JitterBuffer, simulcast, RID,
REMB/TWCC. Make flashcards if needed; this glossary is the entry fee.

## 1. Phase 5a — P2P mesh (learn the protocols, feel the wall)

Build a voice channel that is *literally* a mesh: N users in a voice channel
have N-1 RTCPeerConnections each, all signaling over your gateway.

### Signaling flow over the gateway
```
Client A joins voice channel C:
  → REST POST /channels/C/voice/join   → returns {token, endpoint, guild_id}
    (Discord's shape: voice is a separate WS+UDP endpoint! v1: same gateway)
  → gateway broadcasts VOICE_STATE_UPDATE {channel_id, user_id, ...} (existing event!)
B sees A join → B's client initiates:
  → offer SDP → VOICE_SIGNALING{to: A, sdp} → gateway routes to A's session
  ← answer SDP ← same path back
  ↔ ICE candidates trickle both directions (add iceServers: a public STUN
     like stun.l.google.com:19302 while testing)
A's RTCPeerConnection.ontrack fires → audio element → done.
```

### Exercises (each one is a required observation, write them down)
1. **chrome://webrtc-internals is your primary debugger.** Learn to read:
   ICE candidate pairs (selected pair!), bytes sent/received per SSRC, RTT,
   packetsLost. Never debug WebRTC blind.
2. Force ICE failure paths: filter `host` candidates
   (`iceCandidatePoolSize:0`, mDNS obfuscation off) — observe ICE states
   `checking → connected → failed`. 
3. Test cross-network (phone on LTE + laptop on WiFi): srflx candidates via
   STUN connect. Test two devices behind symmetric NAT (most phone hotspots):
   **STUN fails, you need TURN** → that's Phase 5b's motivation, felt not read.
4. 4 users in a channel = 3 connections each, upload bandwidth = your stream ×
   3. Watch uplink saturate in webrtc-internals. **This is the mesh wall** —
   the reason SFUs exist. Record the numbers; they're your motivation graph.
5. Opus + DTX + red-for-audio: inspect the SDP your browser generates.
   Note `useinbandfec=1`, `minptime`, the presence of `telephone-event` (DTMF).
   Discord's voice quality post explains why they layer RED on Opus.

### Codecs & defaults for Phase 5
- Audio: Opus 64kbps, mono 48kHz to start (Discord uses stereo+higher for
  premium; make it a config). Enable `usedtx: true`, `red: true`.
- Video (Phase 6): VP8 + simulcast, 3 spatial layers (f/h/q = 180p/360p/720p),
  max bitrate 1–2.5Mbps, contentHint 'detail' for screenshare.

## 2. Phase 5b — TURN server (relay path, required for real networks)

- Run **coturn** (coturn/coturn docker) with `listening-port=3478`, TLS on 5349,
  `fingerprint`, `lt-cred-mech` with a shared auth secret + REST-style
  HMAC time-limited credentials (generate in Go, hand to clients in the
  join-voice response).
- Exercise: on symmetric-NAT (hotspot) clients, verify in webrtc-internals
  that the selected candidate pair is now `relay ↔ relay` or `relay ↔ srflx`,
  and that media flows. Observe TURN bandwidth = all relayed media (cost lesson:
  Discord's TURN bill would be enormous — hence P2P where possible + SFU).
- Understand: TURN is media-neutral — your Phase 5c SFU is, from ICE's
  perspective, just another peer that happens to never need TURN.

## 3. Phase 5c — your own SFU in Go with Pion

Now replace the mesh: every client has exactly ONE peer connection — to your
SFU. SFU receives everyone's streams and *forwards* (never mixes, never
transcodes — say that sentence until it's reflexive).

### SFU architecture (pion-webrtc v4)
```
cmd/sfu/main.go            — HTTP-ish bootstrap + WebSocket signaling endpoint
internal/
  ├── room/                — Room actor (goroutine + channels), one per voice channel
  │      state: tracks, subscribers, router matrix
  ├── peer/                — Peer: one RTCPeerConnection, track reading/writing
  ├── router/              — per-track forwarder: N subscribers × buffering
  └── signaling/           — WS protocol: join/offer/answer/candidate/leave
```

### The core loop (study until obvious)
```go
// Inbound: publisher's audio track
track.OnRTP(func(pkt *rtp.Packet) {
    for _, sub := range track.Subscribers() {
        sub.WriteRTP(pkt)     // rewrite SSRC + payload type, enqueue
    }
})
```
Every hard problem in an SFU lives inside that loop:
- **SSRC rewriting**: each subscriber negotiated their own SSRCs; you must
  rewrite packet headers per subscriber (pion: `track.WriteRTP` via
  `webrtc.TrackLocalStaticRTP` does this for you — but know what it does).
- **Backpressure**: a slow subscriber's queue must be *dropped-from*, never
  blocking (audio: drop whole frames; video: drop up-to-latest non-keyframe —
  you cannot decode a P-frame stream with a hole; you must wait for an IDR.
  This single fact drives most SFU complexity — internalize it).
- **Keyframe management**: on join, subscriber can't render until keyframe.
  Send PLI (Picture Loss Indication) to publishers; rate-limit PLIs (a
  feedback storm of 20 subscribers × PLI = publisher encodes 20 keyframes —
  classic SFU collapse).
- **RTCP pass-through**: PLI/NACK/REMB/TWCC must flow subscriber→SFU→publisher.

### Buffering: use pion's `buffer` + `interceptor` packages
- NACK: retransmit from a small history ring (audio: often skip; video: yes).
- Jitter handling at the *subscriber* — SFUs forward ASAP; the jitter buffer
  lives in the receiving client (or in your SFU only for... nothing. Forward.)

### Room lifecycle events (tie into the gateway)
```
join:    REST POST /channels/:id/voice/join → voice token + SFU WS URL
connect: WS to SFU (auth token), SDP offer/answer with SFU
state:   SFU → gateway (internal event bus topic "voice") → VOICE_STATE_UPDATE
         broadcast to guild (self-muted, deafened, joined/left)
leave:   WS close / heartbeat timeout → cleanup → VOICE_STATE_UPDATE
```
The gateway remains the source of truth for *who is where* (voice states);
the SFU is the source of truth for *media*. Two ownerships, one event stream
— same data-ownership discipline from `00-architecture.md` §6.

### Metrics & debugging
- Per-subscriber: packets forwarded/s, queue depth, NACKs sent/received,
  PLIs, fraction-lost (from RTCP receiver reports).
- Log selected ICE candidate pair per peer (relay usage % = your TURN cost).
- pion has `webrtc.PeerConnection.GetStats()` — poll 1/s → Prometheus.

## 4. Phase 6 — Video, screenshare, simulcast

### Simulcast (the concept + your implementation)
Publisher sends 3 encodings of the same track (RID: f/h/q). Each subscriber
picks ONE layer based on their bandwidth/CPU. The SFU's job: per-subscriber
layer *selection* + *switching*.

```
Transceiver sender: Go Pion publisher (or browser):
  AddTransceiverFromTrack(track, Simulcast: f 180p 150kbps / h 360p 500kbps / q 720p 2.5Mbps)
Subscriber-side layer switching:
  - send RTCP ReceiverReport / use pion's SimulcastInterceptor to demux by RID
  - switching UP: safe anytime; switching DOWN: drop until next keyframe of the lower layer
  - react to subscriber bandwidth via TWCC → pion BandwidthEstimator
```
Required experiments:
1. Three subscribers with throttled downlinks (Chrome DevTools network tab:
   Fast 3G / Slow 3G / offline-flicker) → verify each stabilizes on a
   different RID. Watch in webrtc-internals.
2. Force a PLI storm: join/leave 10 clients rapidly → observe keyframe
  cascade → implement PLI rate limiting (1 per publisher per 500ms, coalesce
  subscriber requests).
3. Screenshare with `contentHint: "detail"`, observe encoder behavior change
   (no screen for 2s? Layer collapse? Write what you see — screenshare is
   bursty content and behaves differently from a face cam).

### Congestion control (conceptual mastery + knobs)
- Google Congestion Control over TWCC: receivers acknowledge transport-wide
  sequence numbers → sender-side estimator → target bitrate → encoder.
- Your SFU mostly *reacts* (layer switching) rather than controls — but with
  20 subscribers × 3 layers you now face **SFU egress bandwidth math**:
  500-member channel × 360p@500kbps ≈ 250Mbps egress from one SFU process.
  This is why Discord has many media servers and a region-picker. Do the
  arithmetic for your own deployment limits (see 09 §6: SFU sharding by channel).

### Adaptive failure drills (Phase 6 chaos)
- Kill the SFU process mid-call → clients get WS close → gateway emits voice
  states cleared → clients re-join → land on SFU instance #2 (Phase 7 adds
  the LB/redirect). Media reconnects within ~2s without user action.
- Network partition SFU ↔ gateway: SFU keeps forwarding media (it doesn't
  need the gateway for the data plane! — observe this independence), but
  presence desyncs. Write up why the *media plane* surviving a *control plane*
  partition is a feature (it's how Discord keeps calls alive during gateway
  events).

## 5. Security (do not skip)

- DTLS-SRTP is automatic — verify with Wireshark that you literally cannot
  read the media (one mandatory capture exercise; filter `udp.port==40000`,
  see ciphertext).
- Signaling auth: voice join tokens are short-lived JWTs (channel + user +
  SFU instance claims), minted by REST, verified by SFU.
- ICE credentials: ephemeral TURN credentials (HMAC, §2), never static.
- Gateway permission check at join: CONNECT permission for voice channels
  (06 §3 — the voice join route exercises the same Resolve()).

## 6. Phase 5/6 gates

Phase 5:
- [ ] 3-user P2P mesh call works incl. one TURN-relayed participant
- [ ] webrtc-internals literacy: can identify selected pair, SSRCs, loss, RTT
- [ ] SFU replaces mesh; same 3 users, one connection each
- [ ] Audio p95 mouth-to-ear < 150ms (measure: clap test recorded on both ends)
- [ ] PLI/NACK counters exist and make sense on a lossy network (tc netem: 
      `tc qdisc add dev eth0 root netem loss 5% delay 40ms`)

Phase 6:
- [ ] 3-layer simulcast switching under DevTools-throttled clients
- [ ] PLI rate-limiter proven under join/leave storm
- [ ] Screenshare 1080p at 'detail' hint usable
- [ ] SFU-kill chaos drill: call survives via reconnect < 2s

## 7. Reading (in order)
- webrtcforthecurious.com (read fully, it's short and perfect)
- Pion example apps: `pion/webrtc/examples` + `pion/sfu` (the totemic
  minimal SFU — read every line, it's ~1k LOC), then `pion/ion-sfu` (archived
  but the router/buffer patterns came from here), LiveKit's sfu source (Go,
  production-grade — read for patterns, don't copy)
- Discord: "Discord Voice Quests"... no — the right ones: "How Discord
  Scaled Voice" / their RTC media posts (see 12-references §Phase 5)
- RFCs as reference (not cover-to-cover): 8825 (overview), 8829 (JSEP),
  8445 (ICE), 5389 (STUN), 8656 (TURN), 3550 (RTP), 8108, 4585/5104 (FIR/PLI)
