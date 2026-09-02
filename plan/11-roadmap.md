# 11 — Roadmap (START HERE)

> ~24 weeks part-time (evenings/weekends ≈ 8–12 h/wk), 11 phases. Each phase:
> build → chaos experiment → gate checklist → postmortem. The gates are the
> curriculum; the code is just the vehicle.
>
> Rule for being "done" with a phase: all gate boxes ticked + postmortem written
> (`../postmortems/phase-N.md`, half a page: what surprised you / what Discord
> did differently / what you'd change).

## Phase 0 — Foundations (wk 1–2)

**Build:** monorepo layout, `compose.yml` (PG + api + gateway-hello-world +
client shell + caddy + prometheus/grafana), Go REST with register/login/JWT,
Postgres schema v1 (`02-rest-api.md` §2), snowflake lib, minimal React client
(login + guild list + channel + send/read messages via polling — polling
*on purpose*, so Phase 1's WebSocket moment lands emotionally).

**Read first:** 00-architecture (whole file), 02-rest-api, Discord API docs
on snowflakes + rate limits.

**Chaos:** kill the api container mid-request-loop; watch the client's
behavior with no retry logic. (Baseline pain — you'll fix it forever after.)

**Gate:**
- [ ] `scripts/smoke.sh`: register→login→guild→channel→message→read-back
- [ ] prometheus scrapes api + gateway; one grafana dashboard exists
- [ ] snowflake IDs sortable; unit tests for the bit layout
- [ ] rate-limit headers on POST /messages (in-memory version OK)

## Phase 1 — Gateway & realtime core (wk 3–5) ← the heart of the project

**Build:** Elixir gateway per `01-gateway.md`: WS termination, full Discord
op protocol (op 1/2/6/10/11 + close codes), per-guild GenServer actors,
per-session seq + in-memory replay buffer, RESUME path. Event bus v1: do
**Redis Streams first, then NATS JetStream** — build the bus as an interface
in the api (`events.Publisher`) so the swap is a config change; write the
comparison paragraph. Dual-write dance: publish-after-commit (02 §3).

**Read first:** 01-gateway (whole), "How Discord Scaled Elixir to 5M users".

**Chaos:** SIGKILL gateway container while your client is subscribed →
client auto-reconnects + RESUMes → verify zero missed events for the buffer
window. Then break RESUME (op 9 path) and verify full resync works.

**Gate:**
- [ ] client replaced polling with WS; message send→render < 100ms locally
- [ ] RESUME replays gaps correctly (test: disconnect 5s, 30s, 10min —
      third one must yield INVALID_SESSION, not corruption)
- [ ] heartbeats + zombie close (4009) verified
- [ ] Redis→NATs comparison written (throughput, delivery guarantees, ops feel)
- [ ] fan-out p99 metric exists (NATS→socket)

## Phase 2 — Presence & typing (wk 6–7)

**Build:** `05-presence-typing.md` §1–2. ETS presence store, idle state
machine, PRESENCE_UPDATE + TYPING_START events, REQUEST_GUILD_MEMBERS with
chunking, member sidebar in the client (groups by role, online-only).

**Read first:** 05 §1–2, Discord's lazy-guild-members/chunking material.

**Chaos:** kill -9 a client app → presence must flip to offline only after
heartbeat timeout (watch the zombie window). Flood typing from a script →
server-side throttle holds.

**Gate:**
- [ ] presence state machine correct incl. zombie timeout
- [ ] 10k-member seeded guild chunks without gateway memory blowup
- [ ] three-tier consistency comparison written (typing vs presence vs messages)
- [ ] member sidebar renders online members grouped by hoisted role

## Phase 3 — Messages at scale + search (wk 8–10)

**Build:** ScyllaDB schema + bucket math (`03-message-store.md`), message
store behind an interface in Go, the PG→Scylla dual-write migration, TWCS,
pagination cursors across buckets; then search rung 1 (pg_trgm, measure the
cliff) → rung 2 (Meilisearch + indexer pipeline + reconciliation) per `04-search.md`.

**Read first:** "How Discord Tripled Its Message Capacity" (the whole post is
your spec), 03 + 04.

**Chaos:** freeze Meilisearch 60s → consumer lag graph → unfreeze → drains to
zero lost docs (verified by reconciliation job). Kill a Scylla node mid-write-burst.

**Gate:** see `03-message-store.md` §10 and `04-search.md` §5 — all boxes.

## Phase 4 — Roles & permissions (wk 11–12)

**Build:** `06-permissions.md`: role CRUD, bitfield lib, pure `Resolve()`,
channel overwrites, enforcement at REST + gateway fan-out filter, golden
JSON test vectors consumed by Go + Elixir + TS, permission UI (role editor,
lock icons on hidden channels).

**Read first:** 06 (whole), Discord docs "Permissions".

**Chaos:** the TOCTOU attack (06 §5 last case): demote a user mid-session,
prove the gateway stops delivering their private-channel events. Run the
attack against a pre-fix build first and *watch it leak*.

**Gate:** see `06-permissions.md` §7.

## Phase 5 — Voice: P2P mesh → TURN → SFU (wk 13–16)

**Build (in order, do not skip rungs):** `07-voice-video.md` §1–3.
(a) P2P mesh over gateway signaling + the 5 mandatory webrtc-internals
exercises; (b) coturn + HMAC-cred flow, relay verification; (c) Pion SFU v1
(audio only): room actors, router, RTCP handling, voice states bridged to
gateway events. Client: voice channel UI (join/leave, speaking indicators
via audio level, mute/deafen).

**Read first:** webrtcforthecurious.com (all), Pion `sfu` example (all lines).

**Chaos:** `tc netem` 5% loss → NACK/PLI counters make sense. Kill SFU
mid-call → rejoin lands on second SFU instance.

**Gate:** see `07-voice-video.md` §6 Phase 5.

## Phase 6 — Video, screenshare, simulcast (wk 17–19)

**Build:** `07` §4: 3-layer simulcast, per-subscriber layer switching on TWCC,
PLI rate-limiting, screenshare with contentHint, SFU metrics dashboard.

**Chaos:** join/leave storm (10 clients rapid) → keyframe cascade → prove
your PLI limiter holds. DevTools-throttled subscribers land on different layers.

**Gate:** see `07-voice-video.md` §6 Phase 6.

## Phase 7 — Scale & failover (wk 20–22) ← the payoff phase

**Build:** `09-scalability-failover.md` whole file: multi-node compose
topology, libcluster + Horde, guild-actor lease, k6/WS-army load tests,
capacity table, chaos catalog as scripts, SLO dashboard + two burn-rate alerts.

**Read first:** 09 (whole), "The Tail at Scale".

**Chaos:** this phase IS the chaos catalog (09 §4, drills 1–9,
predict-written-first discipline).

**Gate:** see `09-scalability-failover.md` §7.

## Phase 8 — Media pipeline + Rust (wk 23–24, stretch)

**Build:** `08-media-pipeline.md`: upload flow (direct-then-presigned
refactor), Rust media workers (image thumbs, ffmpeg poster frames, EXIF strip),
content-addressed storage, Caddy CDN layer + signed-URL decision; Go-then-Rust
read-states service with the overlaid p99 comparison (`05-presence-typing.md` §3).

**Read first:** "Why Discord is switching from Go to Rust" (twice — before
and after building).

**Chaos:** decompression-bomb upload, kill worker mid-job (idempotency
redelivery).

**Gate:** see `08-media-pipeline.md` §5 + `05-presence-typing.md` §4 Phase 8.

## Phase 9 — Real deployment (wk ~22+ interleaved, then 2 wk focused)

**Build:** `10-deployment.md`: Oracle VMs, TLS, the networking gauntlet
(security lists, double firewall, UDP range), runbook, backups + restore
drill, monitoring over the internet, then the real test: **friends +
phones on LTE join a guild call.** Optional stretch: k3s port (10 §5).

**Gate:** see `10-deployment.md` §6 — the friend-on-LTE box is the real
graduation.

## Stretch goals (post-plan, pick by interest)

- protobuf/msgpack event envelope (measure vs JSON — Discord did this)
- DMs + group DMs (channel model gymnastics: no guild_id — fan-out by user)
- reactions/threads (event-volume + pagination variants)
- Elixir NIF or Rustler port of a hot path (fan-out coalescing)
- mobile client (Capacitor or React Native — WebRTC on mobile is its own course)
- k3s + helm, PDBs, the ops-competence track

## If you fall behind (you will — plan for it)

Priority order when compressing: 1→7 are the core arc. Phase 2 can shrink to
presence-only (skip member chunking). Phase 6 can shrink to simulcast-without-
screenshare. Phase 8 is fully cuttable. **Never cut: Phase 1's resume semantics,
Phase 3's bucketing migration, Phase 5's P2P-before-SFU, Phase 7's chaos
catalog.** Those four are the "why is Discord possible" curriculum.

## Weekly rhythm that works

- 2× weeknight sessions (2h): build
- 1 weekend block (4h): build + the chaos experiment + metrics
- 30 min/week: postmortem notes in progress, read the phase's one required post
- End of phase: update capacity table + re-read 00-architecture (it reads
  differently every time — that's your progress meter)
