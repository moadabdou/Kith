# Load Army + Capacity Table + 1M-User Plan (Phase 7e, Issue #88)

Measure single-node knees BEFORE trusting multi-node numbers (plan/09 §2,
§6). Every row is a measured number with topology + date, never a vibe.
Subscriber-splitting is explicitly CONDITIONAL — built only if the 10k hot
guild test hurts.

## 0. Ground rules (apply to every step)

* **One tier loaded, everything else idle.** Row 1 (#85) proved co-located
  consumers poison tails (gateway fan-out + Meili at 96% CPU, load avg ~13
  on this 8-core / 7.7GB box). Each knee run isolates its tier: stop or
  idle everything not under test, record what ran alongside in the row.
* **Predict first.** Each step states the expected knee + bottleneck BEFORE
  running (plan/09's predict-first discipline). Prediction-vs-actual goes
  in the row, not just the number.
* **Driver honesty.** The load generator's own limits (client FDs, Node
  heap, Go scheduler) are measured first and reported alongside — a knee
  found in the driver is a void run, not a result.
* **Rows append, never overwrite.** `docs/capacity-table.md` Row 1 stands;
  #88 adds Rows 2+. Missed gates recorded honestly with suspected blocker
  (Row 1's bisection is the template).

## 9. Staged execution (one green step at a time)

Each step ships independently verifiable and leaves its artifact committed.
Do not start a step until the previous one's gate passes.

### Step 1 — Tooling + driver baselines ✅ DONE (2026-09-25)

> Status: gate passed. k6 v2.3.0 pinned (`~/.local/bin`); `scripts/bench/
> ws_calibrate.js` (new — black-hole calibrator, not phase7 extension);
> 20k idle sockets, 0 failures, no bend (~6KB heap/socket, lag flat);
> Go 1.27.1/GOMAXPROCS=8, driver builds clean, RSS ~25–30MB baseline;
> Row 1 repro at 200/s matches shape (med 5.9ms/p95 25ms, p99 gate trips
> identically). Row 2 committed.

Install k6 (binary download via proxy; verify `k6 version`). Calibrate the
drivers against themselves:

* Node WS driver: open N idle sockets against a black-hole server
  (`node -e` echo sink or `nc -l`), ramp until the DRIVER bends (FD,
  heap, event-loop lag). Record driver ceiling — every later WS number is
  valid only below it.
* Go bench: `GOMAXPROCS`, heap baseline for 0-subscriber idle.
* k6: re-run Row 1 script at low rate to confirm reproducibility window
  (±X% vs Row 1 numbers; box state documented).

* Tests: none (tooling only) — but the driver-ceiling numbers are committed
  as Row 2 (the meta-row: "what our harnesses can prove").
* Gate: k6 installed + version pinned; driver ceilings documented; Row 1
  repro within stated window.
* Unlocks: every later measurement is interpretable.

### Step 2 — k6 REST baselines ✅ DONE (2026-09-25)

> Status: gate passed. Ladder 200→1600/s isolated single API: med
> 3.6→2.1ms *falling*, p95 flat 5–14ms, zero real errors (38 hits at 1600
> are 429 limiter engagements, not failures); CPU profile all-runtime, no
> app hotspot. Prediction (knee 400–600/s) was wrong — no knee ≤1600/s.
> xN delta +0.3ms med (noise): second replica buys nothing unsaturated.
> Rows 3–4 committed. Consequence: API tier is not the binding constraint;
> replicas = ceil(rate/1600) with headroom.

* Single API direct (`:8080`, indexer off, gateway stopped, Meili idle):
  arrival-rate ramp to find the knee (p50/p95/p99 vs rate). This isolates
  the Go+PG+Scylla path from the co-located noise Row 1 bisected.
* Then the #85 topology (2× API behind Caddy) at the same rates: the delta
  is the LB + second-replica contribution, nothing else.
* Vary: indexer on/off (Row 1 showed 15.8ms → 4.4ms med), gateway on/off.

* Tests: k6 thresholds as assertions (existing `thresholds` block extends
  per-run; a missed gate fails the run, honestly recorded).
* Gate: Row 3 (single-node knee with bottleneck named) + Row 4 (xN delta)
  committed; each names its limiting resource (CPU profile or pool-wait
  evidence, not guesses).
* Unlocks: REST rows anchor the 1M-user write math.

### Step 3 — WS army I: idle ramp (BEAM FD/memory knee) — IN PROGRESS

> Status 2026-09-25: `scripts/chaos/ws_idle_army.js` (new — batched +
> paced RATE modes, per-rung BEAM scrape, resume probe, bend criteria) +
> `ws_split_army.sh` (multi-driver) + `sample_cliff.sh`/`remote_probe.exs`
> (BEAM introspection). Findings so far:
>
> * **emfile cliff (found + fixed):** gateway containers shipped a 2048 FD
>   limit → code_server couldn't load beams at ~2k conns/node → Bandit
>   restarts → mass clean-1000 drop of ~4k sockets, instant recovery.
>   Fixed: `ulimits: nofile 65536` on both gateways (compose.yml). Lesson:
>   FDs are the FIRST capacity number, before memory/schedulers.
> * **Teardown flood (found + fixed, committed `b1620f4`):** mass
>   disconnects queued thousands of sync `drop_session`/`unsubscribe`
>   calls on single processes → 5s timeouts → sessions crashing →
>   supervisor cascades → node wedge. Fix: fire-and-forget casts
>   (`drop_session`, `unsubscribe_async/2` shared with sync path via
>   `do_unsubscribe/2`). Post-fix: zero restarts, zero crashes, zero
>   held-drops across 4.3k teardowns. Teardown must never crash the
>   teardown-er.
> * **Holding (proven):** 15k single-driver paced + 16.9k split distinct
>   (guilds+users), zero drops, resume probes pass, mem/conn linear
>   ~120–150KB marginal. No gateway knee found.
> * **Births (open):** IDENTIFY service rate ~100–200/s combined on this
>   box; past it, 15s READY timeouts (server 4000s). Single shared guild
>   actor serializes all subscribes — per-driver guild sharding did NOT
>   raise the ceiling (7.4k vs 8.8k, box-dirt confounded), pointing at
>   per-node rather than per-actor bottleneck.
> * **Box-bound beyond ~17k:** 7.7GB box in swap (10.8GB swapped) at 17k
>   held; failures are birth-side timeouts under swap pressure while held
>   stays perfect.
>
> Remaining for the gate: Row 5 commit (holding floor 8.5k/node,
> birth ~100–200/s, emfile + teardown findings as the bottleneck
> evidence).

Extend `scripts/chaos/phase7_gateway.js` (IDENTIFY + heartbeat + seq
tracking already exist) with an `idle` mode: N clients, no chat, batched
connect (e.g. 500/batch, backpressure on driver event-loop lag), holding
for soak windows. Ramp 0→driver-ceiling in steps; at each step record:
gateway BEAM memory/conn (`:observer`/`:erlang.memory`), FD count,
scheduler utilization, heartbeat ACK loss, gateway pprof if knee found.

* Tests: driver-side asserts (no silent disconnects below ceiling; every
  client READY within timeout). Gateway-side: no 4008/4009 storm, resume
  still works for a probe client at each step.
* Gate: Row 5 (idle knee: N conns @ M MB/conn, bottleneck = FD/memory/
  scheduler — whichever bends first) committed with driver headroom noted.
* Unlocks: the conn count every fan-out test below must stay under.

### Step 4 — WS army II: fan-out (the Discord-shaped tests)

Same driver + a poster (k6 or Go, one writer per guild to avoid
rate-limit self-throttling — cf. phase7_gateway.sh user rotation):

* 100 msg/s into a 200-subscriber guild (= 20k frames/s fan-out).
* 100 msg/s × 10 such guilds (actor parallelism across schedulers).
* One message into a 10k-subscriber guild (worst case: single-actor hot
  spot — measure dispatch time distribution + actor mailbox depth).
* Metrics per test: fan-out latency NATS→socket p50/p99 (existing
  `gateway_fanout_latency_seconds` histogram), per-guild-actor
  `message_queue_len` top-10, missed/dup frames per client (driver already
  tracks `dup_ids`).

* Tests: zero missed frames below the knee (driver asserts); resume probe
  client recovers with monotonic replay at each step.
* Gate: Row 6 (fan-out table: guild-size × rate → p99 + actor queue depth)
  committed. **The 10k verdict goes here**: hurts (p99 or queue blows past
  gate) → subscriber-splitting gets built (Step 4b); holds → documented
  decision + Discord comparison, no build.
* Unlocks: fan-out numbers anchor the 1M-user read math.

### Step 4b — Subscriber-splitting (CONDITIONAL, only if Step 4 hurts)

Shard one guild's subscribers across K sub-actors (plan/01 §5 §8 sketch):
single-writer seq per sub-actor, NATS consumer fans out to K actors, each
serves 1/K of the sockets. Same dedup + lease discipline as Phase 7c.

* Tests: 10k hot guild re-run (must hold gate); 200-sub regression (no
  behavior change); ordering note (per-sub-actor seq — document client
  impact like the 09 §3 cross-node ordering exercise).
* Gate: Row 6 amended with split numbers; code + tests merged.
* Unlocks: nothing downstream needs it; pure capacity headroom.

### Step 5 — Mixed soak (30 min, leak hunt)

20k conns (under Step 3 knee) + chat traffic (Step 4 rates at 0.5×) +
presence churn + typing, sustained 30 min. Grafana screenshots or it didn't
happen: BEAM memory slope (≈0 = clean), FD slope, GC pause p99, NATS
consumer lag, Scylla compaction backlog, API heap slope.

* Tests: slope asserts (linear fit on sampled series; slope ≈ 0 within
  noise band). Any positive slope → heap dump / `:observer` allocation
  breakdown before sign-off.
* Gate: Row 7 (soak: slopes + Grafana links/screenshots) committed; leaks
  fixed or filed as follow-ups with owner.
* Unlocks: confidence the knees above are sustainable, not 5-minute wonders.

### Step 6 — SFU pps knee (replace ~1M pps arithmetic with measurement)

Extend `sfu/cmd/voice_bench` toward packet-rate saturation: N publishers ×
M subscribers ladder (audio-only first — cheapest packets, highest rate),
per-subscriber forwarded/dropped counters from `/metrics`, queue-depth at
saturation, CPU profile at the knee. Then the layer-mix row: same ladder
with f/h/q simulcast (3× packets per publisher) + one screenshare.

* Tests: drop-rate asserts (0 drops below knee; knee = first sustained
  drop rate > 0); keyframe latency sampled at each rung (PLI storm guard
  from Phase 6 must hold).
* Gate: Row 8 (1 SFU = N viewers @ layer mix, pps ceiling, bottleneck =
  CPU/egress/queue — measured, not arithmetic) committed.
* Unlocks: SFU rows anchor the 1M-user voice math.

### Step 7 — Capacity table close + 1M-user paper plan

Fill any missing cells (single PG write rate from Row 1 bisection,
Scylla per-node from Row 1 + Phase 3 numbers, NATS retention from config).
Then the paper plan, one line per tier, each checked against one
measurement in Rows 1–8:

* "1M concurrent users, avg 10 guilds each, 5% in voice, 1 msg/user/min,
  avg guild size 50" → gateway nodes, API replicas, Scylla nodes, SFU
  boxes, egress bytes. Show the division at each line
  (e.g. "X msg/s ÷ Y msg/s-per-API = Z replicas").
* Compare order-of-magnitude vs Discord's public talks (few hundred media
  servers, millions of concurrent voice users) — same methodology, smaller
  constants.

* Tests: arithmetic review (every divisor traces to a Row; no orphan
  numbers). Second pair of eyes on the docs diff.
* Gate: `docs/capacity-table.md` complete through Row 8+; 1M-user plan
  committed (new section or `docs/capacity-plan-1m.md`); issue #88's
  acceptance boxes ticked.

## 8. Acceptance (issue #88 + this plan)

* [x] k6 REST: single-node knee + xN delta rows (Steps 1–2).
* [ ] WS army: idle knee + fan-out table + 10k verdict rows (Steps 3–4).
  Step 3 evidence collected (holding ≥17k, births ~100–200/s, emfile +
  teardown bugs found + fixed); Row 5 commit pending.
* [ ] Step 4b built IFF the 10k test hurts, else documented decision.
* [ ] 30-min soak slopes ≈ 0 (Step 5).
* [ ] SFU pps ceiling + layer-mix row (Step 6).
* [ ] Capacity table complete; 1M-user plan, every line traced to a Row
  (Step 7).
