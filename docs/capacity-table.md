# Capacity Table (seeded by #85, extended by #88)

Measured knees, not vibes (plan/09 §2, §6). Each row: topology, load,
measured result, date. Gate targets in **bold**; misses are recorded
honestly with the suspected blocker.

## Row 1 — 2× API behind Caddy (Issue #85, 2026-09-23)

- Topology: `api` (node 1, indexer on) + `api-2` (node 2, indexer off),
  Caddy round-robin on `/api/*`, Redis-backed global rate limit,
  Scylla single node @ ONE, full stack co-located (8 cores / 7 GB box,
  load avg ~13 under test).
- Load: `scripts/bench/messages_write_load.js`, 1000 msg/s target,
  1000 users × 50 channels, via `http://127.0.0.1:80`.
- Result:
  - Error rate 0.00% (5/72744); rate-limit 429s ≈ 0 (shared budget holds).
  - Latency avg 27.9ms, med 15.8ms, p90 58.9ms, p95 96.7ms.
  - Sustained arrival capped ~855/s (dropped iterations; target 1000/s unmet).
  - **Gate p99 < 10ms @ 1000 msg/s: MISSED (environmental).**
- Bisection (same box, short runs):
  - Single replica direct: med 6.5ms, p95 73ms — also misses; not an LB artifact.
  - Sequential single-client writes via LB: med ~4–5ms — per-request path healthy.
  - Indexer off: med 15.8ms → 4.4ms, p95 97ms → 51ms (Meili was at 96% CPU).
  - Gateway stopped: avg 27.9ms → 7.7ms, med 15.8ms → 5.2ms, p95 97ms → 22ms.
  - Conclusion: tail comes from co-located consumers (gateway NATS fan-out
    path, search indexer + Meilisearch) + box oversubscription, not the
    API replicas. Re-run on bigger iron or with consumers isolated before
    trusting multi-node numbers (#88).
- xN correctness (same run window):
  - Same JWT → 200 on both replicas.
  - 8 alternating POSTs, one bucket: exactly 5×201 then 429s (global budget).
  - Snowflake nodes: api-1 → node 1, api-2 → node 2, zero collisions.
  - Caddy split verified ~50/50 per-instance counters (after force-recreate;
    note: `up -d` alone did not reload the edited Caddyfile).

## Row 2 — Driver ceilings + Row 1 repro window (Issue #88 Step 1, 2026-09-25)

- Tooling: k6 v2.3.0 (pinned, `~/.local/bin`), Node v26.8.1 (native WS),
  Go 1.27.1 / GOMAXPROCS=8. Box: 8 cores / 7.7GB (same as Row 1).
- Node WS driver vs black-hole (`scripts/bench/ws_calibrate.js`, batched
  1000, localhost): **20k idle sockets, 0 failures, no bend found**.
  ~6KB heap + ~8KB RSS per socket, event-loop lag flat 0ms. Batch connect
  ~1–2s/1000 (localhost handshake bound, irrelevant for held sockets).
  Raw: `scripts/bench/results/ws_driver_ceiling.json`.
  Implication: WS numbers below 20k are driver-valid; the 50k army (Step 3)
  needs split drivers or a higher single-process run first.
- Go bench: builds clean (`voice_bench` incl. pool drills); driver RSS
  ~25–30MB loaded (Phase 6 postmortem §6 — committed baseline, deltas
  measured live in Step 6).
- Row 1 repro at 200 msg/s via Caddy (2× API, 30s sustain): med 5.9ms,
  p90 15.8ms, p95 25.0ms, 0.00% HTTP errors; k6 latency checks 10.8% fail
  (p99<10ms gate trips — same verdict as Row 1). Shape matches Row 1
  (1000/s: med 15.8ms, p95 96.7ms) scaled to rate: per-request path
  healthy, tail from co-located load. Repro window holds.
- Harness noise (not a result): k6 summary-json write fails with
  permission denied on `/bench/results` (container path mapping) — metrics
  still captured via stdout log.

## Row 3 — Single-API knee hunt (Issue #88 Step 2, 2026-09-25)

- Topology: single `api-1` direct (`:8080`), indexer OFF, both gateways
  STOPPED, Meili idle. Scylla single node @ ONE, PG co-located. Isolation
  per §0 (removes the Row 1 noise sources).
- Load: same k6 script, ladder 200→400→600→800→1200→1600 msg/s, 30s
  sustain each. Prediction before run 1: knee at ~400–600/s from box
  oversubscription. **Prediction wrong** — see below.
- Result (med / p95 / errors):
  - 200: 3.56ms / 5.32ms / 0
  - 400: 3.59ms / 6.07ms / 0
  - 600: 3.37ms / 8.64ms / 0
  - 800: 3.11ms / 8.17ms / 2 (0.00%)
  - 1200: 2.36ms / 14.12ms / 7 (0.01%)
  - 1600: 2.05ms / 8.20ms / 38 (0.05%)
- Findings:
  - **No knee ≤1600/s.** Median *falls* with rate (batching/JIT warmup,
    Scylla memtable sweet spot); p95 flat 5–14ms, noisy not
    rate-correlated. p99 47ms at 1600 (gate trips on tail only).
  - The 38 "errors" at 1600 are **429 rate-limit hits** (0.69/s) — the
    shared Redis budget engaging under bursty VUs, not failures.
  - CPU profile at load: all runtime (syscalls 24%, futex, scheduler) —
    no application hotspot. API is I/O-wait dominated, not CPU-bound.
  - Bottleneck for 1M math: **not the API tier** (single node holds 1600/s
    at med 2ms). Rate limiter engages first — budget sizing, not capacity,
    is the API-tier question.
- Raw: `scripts/bench/results/k6_output.log` (last run), `api_cpu.pprof`,
  `api_heap.pprof`.

## Row 4 — 2× API xN delta (Issue #88 Step 2, 2026-09-25)

- Topology: Row 3 isolation + Caddy round-robin over api-1/api-2
  (`:80`), same rates 400 + 800 for direct comparison.
- Result: 400 → med 3.92ms / p95 6.46ms / 0 err; 800 → med 3.30ms /
  p95 8.15ms / 0 err. Deltas vs Row 3: +0.3ms med, +0.4ms p95 — noise.
- Finding: **horizontal API scaling buys nothing while a single node is
  unsaturated.** LB tax ≈ 0.2ms. xN matters only past the single-node
  knee, which Step 2 did not reach (above 1600/s on this box). For the 1M
  plan: API replicas = ceil(write_rate / 1600) with headroom, not ×N for
  latency.

## Row 5 — WS idle holding + birth rate (Issue #88 Step 3, 2026-09-25)

- Topology: 2× gateway (ulimits 64k — see emfile note), idle sockets,
  single shared user per driver except where noted, HEARTBEAT 8s,
  everything else idle. Box: 8-core / 7.7GB (same as Rows 1–4).
- Tooling: `scripts/chaos/ws_idle_army.js` (new — batched + paced RATE
  modes, per-rung BEAM scrape, resume probe, bend criteria) +
  `ws_split_army.sh` (multi-driver, per-driver guild/user sharding) +
  `sample_cliff.sh`/`remote_probe.exs` (remote BEAM introspection).
  Raw JSONs: `scripts/chaos/results/ws_idle_*.json`.
- Holding (proven, zero drops, resume probes pass every rung):
  - 15k single driver paced 100/s: 15,000 held, 0 fail, ~130KB/conn
    marginal, gw mem 1.9GB total. (`ws_idle_clean15k.json`)
  - 16.9k split distinct (2 guilds + 2 users): 8906 + 8059 held, 128
    birth-side fails on one driver, 0 drops. (`ws_idle_fullscale_d*.json`)
  - 10k single: 10,000 held, 0 fail. (`ws_idle_fd65k.json` rung)
  - 8.8k split shared-guild blast: 0 drops. (Pre-fix baseline behavior
    for holding; fails were birth-side.)
- **No gateway holding knee found ≤17k combined (8.5k/node).**
  Per-conn marginal ~120–150KB, linear, no scheduler distress (run-queue
  ≈ 0 in-window samples), no 4008/4009 storm. Floor for Step 7 math:
  8k idle conns/node with headroom on this box class.
- Births (open bottleneck): IDENTIFY service rate ~100–200/s combined.
  Single driver @100/s climbs indefinitely; 2×100/s starves past
  ~5–7k/driver with 15s READY timeouts (server 4000s). Per-driver guild
  sharding did NOT raise the ceiling → points at per-node (Bandit
  acceptors / ConnSupervisor / PG pool), not per-actor. Follow-up in
  Step 4 or dedicated birth-rate study.
- Bugs found by the army (both fixed, both would have corrupted every
  later number):
  - **emfile cliff:** gateway containers shipped FD limit 2048 →
    code_server failed loading beams at ~2k conns/node → Bandit
    restarts (6×) → mass clean-1000 drop of ~4k sockets, instant
    recovery. Zero 4009/4008 (app never decided anything). Fixed:
    `ulimits: nofile 65536` on both gateways (compose.yml). Lesson: FDs
    are the FIRST capacity number, before memory/schedulers.
  - **Teardown flood (committed `b1620f4`):** mass disconnects queued
    thousands of sync `drop_session`/`unsubscribe` calls on single
    processes → 5s timeouts → sessions crashing → supervisor cascades
    → node wedge. Fixed: fire-and-forget casts (`drop_session`,
    `unsubscribe_async/2` shared via `do_unsubscribe/2`). Post-fix:
    zero restarts, zero crashes, zero held-drops across 4.3k teardowns.
- Box-bound beyond ~17k: 7.7GB box in swap (10.8GB swapped) at 17k held;
  failures are birth-side timeouts under swap pressure while held stays
  perfect. Bigger iron (or fewer co-located tiers) needed past this.

## Row 6 — WS fan-out: T1 pass, T2/T3 stall map, 4b split (Issue #88 Step 4, 2026-09-25/26)

- Topology: 2× gateway (pool: router + 8 workers/node; ETS metrics),
  api-1 write path (indexer off for isolation), single box 8c/7.7GB.
  Gate redefined mid-step and recorded here: **server dispatch p99
  (holder node) + client loss counting**. Client end-to-end kept as
  diagnostic only (it includes the API write path and driver intake).
- **T1 — 200 subs × 100 msg/s × 60s: PASS.** Posted 5998-5999, 0×429/err.
  Delivery 1,199,600/1,199,600 = 100%, 0 missed/dups/closed. Server
  dispatch p99 10ms (holder buckets; Prometheus 25–32ms) vs 50ms SLO —
  5x headroom. One actor pushes 20k frames/s in SLO. Prediction confirmed.
- **T2 — 10 guilds × 100 msg/s: MISSED (box-bound, mapped).** Offered
  1000 writes/s; single API accepted ~770/s with 2s median POST tails;
  35k events sat unread (consumer lag), redelivery storms followed, box
  load 55–59. Delivery ~15% in-window, zero corruption anywhere.
  Pre-registered call holds: implicates box/broker, not any one actor.
  Write path cleared by isolation (997/s at 14ms with no subscribers).
- **T2-lite (10 × 30/s) and full-scale repeats: same fixed-rate signature**
  at 3x different offered rates → serial funnel, not capacity. Probe
  caught it: NatsConsumer mailbox 3–5k deep, Metrics agent 1.6k deep,
  actors/sessions shallow. Fixed: ETS lock-free metrics (agent gone from
  queues), router + guild-partitioned workers, sampled logging.
  Consumer backlog fell 10x, box load 60 → 28.
- **T3 one-shot — 4 msgs into 10,000 subs: 100% delivery (40,000/40,000),
  server tail >1s, e2e ~1–2.4s.** Pre-set 4b trigger (p99 > 500ms)
  TRIPPED → subscriber-splitting built (Step 4b): threshold-gated lanes
  (32 lanes past 1000 subs), control keeps voice/presence/typing,
  same lease+dedup per lane, per-session seq untouched (ordering
  impact: timing only). Unit-green (7 split tests), full suite 222
  green (testvectors packaging gap fixed: gateway builds from repo root
  so the shared golden file ships in the test stage). Live 10k
  re-run pending fresh iron.
- **Instruments hardened along the way:** server-p99 gate (holder-node
  buckets; mirror samples carry a VM-clock offset), collect-late
  driver (no per-frame parse; accounting identical), poster
  Little's-law cap (50 in-flight), write/dispatch/observer clocks split.
- **Why 500-concurrent births fail (measured 2026-09-26).** Sustained
  ceiling is ~100–200 births/s (Step 3); 10k births were thrown at
  400–500 concurrent. Per-subscribe service is 113–246µs with an empty
  mailbox (measured, not the 50ms first guessed) — the freeze is
  congestion collapse, not slow service: every birth fans into 22
  synchronous calls (11 subscribes + 11 voice checks), bursts pile them
  thousands deep, 15s timeouts convert waiting work into waste, and
  resubscribe timers + NATS redeliveries reschedule the waste back into
  the same queues. Pushing 5x over yields near-zero, not full speed.
  Fix direction: pace under the ceiling (procedural, free), per-user
  channel cache (needs TOCTOU care), parallelize the pure permission
  math with one writer (same split pattern as 4b lanes).
- **Open, named:** single-actor dispatch tail (only ~15% ≤50ms at
  100/s on this box; prime suspect: per-subscriber permission walk,
  never profiled); multi-guild rate ceiling; soak; SFU pps; 1M plan.

## Rows to come (#88 follow-ups)

- Fresh-iron re-runs (200-sub regression, 10k lanes, multi-guild).
- 30-min soak slopes, SFU pps ceiling + layer mix, 1M-user paper plan.
