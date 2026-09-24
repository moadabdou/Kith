# SFU Pool — Channel-Assigned Failover (Phase 7d, Issue #87)

Two SFU instances with deterministic channel placement. The gateway is the
single decider of placement; the client only detects failure and obeys.
Voice roster recovery across gateway actor restarts rides on the
double-layer scheme in §5 — without it, failover reallocations land on an
empty roster.

## 1. Architecture

```
                        gateway guild actor (Horde, lease-gated)
                        │  placement = hash(channel_id) over live SFUs
                        │  VOICE_SERVER_UPDATE (endpoint | null)
                        ▼
   client ──Op 4──▶ gateway ──push──▶ client ──join──▶ sfu-1 / sfu-2
     │ media failure        │ background health poller (5–10s, out-of-band)
     │ re-send Op 4         │ flips live list; requests never block on probe
     └──────────────────────┘
```

* **Placement:** `:erlang.phash2(channel_id)` over the live SFU list, in
  `dispatch_voice_server_update` (`gateway/lib/gateway/guild/actor.ex:1170`).
  Single-endpoint default keeps backwards compat when no pool is configured.
* **Failure signal (Discord-shaped):** client re-sends Op 4 for its current
  channel on `SfuClient.giveUp()` — a hint ("I need fresh voice server
  info"), never a verdict. Capped retries, reset on `connected`, so one
  deaf client can't Op 4-storm its guild.
* **Directed teardown (Discord's null-endpoint):** when the poller marks an
  SFU dead, the gateway pushes `VOICE_SERVER_UPDATE` with `endpoint: null`
  to affected sessions ("tear down, don't reconnect yet"), then follows with
  the fresh allocation. Client contract:
  `connected → (null) → parked → (real endpoint) → connecting → connected`,
  with a timeout surfacing `failed` if reallocation never arrives.
* **Health tracking is out-of-band.** Requests never wait on a probe; the
  poller flips the placement list. The drill harness may flip the list
  itself when it kills the container — legitimate for chaos.

## 2. Compose: sfu-2

Second `sfu` service in `compose.yml` with a disjoint UDP range and WS port.
Also reconciles the existing mismatch: compose exposes `50000-50020` while
`plan/10` specifies `40000-40100` — pick one range scheme and apply to both
instances (e.g. sfu-1 `40000-40050`, sfu-2 `40050-40100`, or keep `50000+`
and fix plan/10; the split is what matters, not the numbers).

## 3. Gateway placement + health

* `Gateway.Guild.Actor`: `dispatch_voice_server_update/3` selects from the
  live list via channel hash; dead node excluded by the poller-maintained
  list, never hashed back onto the corpse.
* Poller: `GET /healthz` per SFU on an interval, flips liveness; one
  in-flight check per SFU (coalesced — 50 members failing at once must not
  fire 50 probes).
* Null-then-reallocate push to every session whose channel was placed on the
  dead node. Leverages the existing endpoint-change rebuild path
  (`VoiceContext.tsx:244-263` — dedupe fails on null/changed endpoint).

## 4. Client changes

* `SfuClient.giveUp()` → surface `failed`; `VoiceContext` re-sends Op 4 for
  the current channel (capped counter, backoff, reset on `connected`).
* Null-endpoint handling: tear down `SfuClient`, park in `connecting`, wait
  for the real allocation; timeout → `failed`.
* Tier 2 voice-intent fix (§5.2): preserve `activeVoiceRef` +
  `sessionStorage kith_active_voice` on `SESSION_RESET` (stop wiping at
  `VoiceContext.tsx:361-365`); tear down SFU transport but keep intent and
  volunteer it on the next READY if the snapshot misses us.

## 5. Double-layer voice recovery (actor-restart amnesia)

Problem: `voice_states` is actor-RAM-only (`actor.ex:242`, seeded empty in
`init`). After a Horde restart the map is empty while browsers and SFU rooms
still show the call — control plane says empty, data plane says busy. Heal
must converge from two caches; either alone leaves a hole.

### 5.1 Tier 1 — session mirrors acknowledged intent, pushes on resubscribe

* WS handler (`handler.ex:370-372`) tells the session
  `{:voice_intent, gid, channel/mute/deaf}` **after** `update_voice_state`
  returns `{:ok, _}`. Errors cache nothing. Leaves clear at send-time.
* Session keeps `%{gid => {channel_id, mute, deaf}}` — per-guild, ack-only.
* On resubscribe after actor `:DOWN` (`session.ex:435-453`), the session
  piggybacks its cache. The actor applies it only when ALL hold:
  1. **Accept-if-absent** — no existing entry for that user (a browser Op 4
     arriving first wins automatically; map is keyed by `user_id`).
  2. **Lease-gated** — applied only while holding the dispatch lease
     (a SIGSTOP-stale actor must not absorb pushes).
  3. **Permission re-checked** — same `can_view`/`can_connect` as a fresh
     Op 4 (a banned user's stale cache must not rejoin them).
  4. **Session stamped from the call** — channel/mute from the push,
     `session_id` from the subscribing session itself. Never route to a
     session id presented by another process.
* Heals survivor-node sessions at resubscribe speed (~0.7s in D1). Failure
  mode is today's behavior (falls back to browser path).

### 5.2 Tier 2 — browser volunteers intent on fresh READY

* `SESSION_RESET` preserves intent: tear down `SfuClient`, keep
  `activeVoiceRef` + storage, status → `connecting`.
* On fresh READY: snapshot lists me → adopt it (authoritative, today's
  path). Else if preserved intent exists, is fresh (timestamped at store,
  ~10-min sanity cap; `sessionStorage` already bounds it to the tab), and no
  explicit leave happened → re-send Op 4.
* No solicit-state opcode: fresh READY always follows dead-session recovery,
  so the volunteer moment is guaranteed. Volunteer-on-READY *is* the
  request, pre-answered.

### 5.3 Coverage

|                        | Actor alive | Actor dead                          |
|------------------------|-------------|-------------------------------------|
| Session alive          | works today | Tier 1 restores at resubscribe      |
| Session dead           | works today | Tier 2 volunteers on READY          |

Tab closed → nothing to recover, TTL cleanup correctly forgets. Multi-tab
same user → idempotent (same channel) or last-wins (matches Discord's
one-voice-session semantics).

## 6. Limits (documented, not fixed)

* No cross-SFU media: a channel lives wholly on one SFU (Discord fleet vs
  our hash ring — say so).
* No region picker; hash affinity is placement, not latency-optimal.
* Gap events on node death stay lost by design (Phase 7c non-goal, unchanged).
* Voice snapshot from Tier 1/2 is a render hint; a fresh Op 4 is always
  authority for placement.

## 7. Tests

### Gateway (`mix test`)

`gateway/test/gateway/voice_test.exs` (extends "Voice state management",
"Channel type validation & VOICE_SERVER_UPDATE dispatch"):

* hash affinity: same `channel_id` → same endpoint across calls; distinct
  channels spread over both SFUs (property-ish: N channels, both endpoints
  hit, per-channel stable).
* dead-node exclusion: poller marks sfu-1 dead → same-channel re-request
  returns sfu-2; resurrect → affinity restored.
* null-then-reallocate: dead-node placement triggers `endpoint: nil` push
  to affected sessions only (unaffected channel's sessions get nothing),
  followed by a real-endpoint update.
* Tier 1 accept-if-absent: actor with existing entry ignores push; empty
  actor applies push (channel/mute from push, `session_id` from subscriber).
* Tier 1 lease gate: non-holder drops push (`lease_drop` increments); holder
  applies.
* Tier 1 permission re-check: push for a channel the user can no longer view
  is rejected (no `voice_states` entry, no server update).
* Tier 1 error-path: handler caches nothing when `update_voice_state`
  returns `:not_a_voice_channel` / `:missing_permissions`.

`gateway/test/gateway/session_test.exs` (extends "Session lifecycle"):

* ack-only caching: `{:voice_intent, ...}` stored; leave (`channel_id: nil`)
  clears that gid only, others untouched.
* resubscribe piggybacks cache (assert via actor state after simulated
  actor `:DOWN` + resubscribe).

`gateway/test/gateway/ws/handler_test.exs` (near "Opcode 4 over WebSocket
handler"):

* Op 4 success notifies the session exactly once; Op 4 error notifies never.

`gateway/test/gateway/guild/actor_test.exs` + `clustering_test.exs`:

* restarted actor + survivor resubscribe → roster whole without any Op 4
  (the D1-upgrade assertion: whole at resubscribe +0.7s).

### Client (`vitest`)

`client/src/context/VoiceContext.test.tsx` (extends the Phase 5c suite):

* `SESSION_RESET` preserves `activeVoiceRef`/storage while tearing down SFU
  (rewrite of "handles session reset (Opcode 9)…" — currently asserts the
  wipe; the wipe is the bug Tier 2 fixes).
* READY with snapshot hit → adopt, no Op 4 sent.
* READY with snapshot miss + preserved intent → Op 4 re-sent with stored
  channel + mute/deaf.
* READY with snapshot miss + no intent (explicit leave earlier) → silent.
* null endpoint → `SfuClient` torn down, status `connecting` (parked), no
  reconnect attempt until a real endpoint arrives; timeout → `failed`.
* `giveUp()` → Op 4 re-sent for current channel; counter caps retries;
  `connected` resets the counter.

### Chaos (`scripts/chaos/phase7_sfu.sh`, new — mirrors `phase6_video.sh`)

* Drill 5 graduates: mid-call `docker kill -s SIGKILL kith-sfu-1` →
  co-location assertion (**every member of a channel reports the SAME
  endpoint**, then media flows) + first keyframe ≤2s. "Everyone
  reconnected" alone is insufficient — it passes while split.
* Deaf-client control: one client with connectivity poisoned toward sfu-2
  only (iptables DROP on its UDP range) complains; poller probe passes; **no
  failover** — channel stays put. Proves the rumor path doesn't stampede.
* Roster assertion (double-layer proof): kill the actor-holding gateway node
  mid-call → survivor roster whole at resubscribe without browser action;
  dead-node clients whole after READY round-trip.
* Predictions written before run 1 in the script header; actuals +
  prediction-vs-reality in `postmortems/chaos-log.md`.

## 8. Acceptance (issue #87 + this plan)

* [x] Same-channel affinity verified; kill drill re-routes to peer SFU ≤2s
      with co-location asserted (not just reconnect counts).
      Final green run: kill → co-located on peer, first keyframes 1.21s.
* [x] Deaf-client control passes (no failover on healthy-SFU complaints).
      Steady-state control: stable re-requests, stale nulls classified +
      ignored, zero actionable nulls.
* [x] Survivor roster whole at resubscribe; dead-node roster whole at READY.
      (Tier 1 + Tier 2, unit-covered; live roster drill belongs to #89.)
* [x] `SESSION_RESET` no longer wipes voice intent (client test rewritten).
* [x] Limits (§6) documented in `sfu-guide.md`.
* [ ] Full prediction-vs-reality log → issue #89 (`postmortems/chaos-log.md`).
* [ ] Close #87.

## 9. Staged execution (one green step at a time)

Each step ships independently testable and leaves the suite green. Do not
start a step until the previous one's gate passes.

### Step 1 — Tier 2 client intent (client-only, no gateway changes)

Preserve `activeVoiceRef` + `sessionStorage kith_active_voice` on
`SESSION_RESET` (`VoiceContext.tsx:361-365`); tear down `SfuClient` but keep
intent; volunteer via Op 4 on the next READY when the snapshot misses us.

* Tests: rewrite "handles session reset (Opcode 9)…" to assert preserve;
  add snapshot-hit (adopt, no Op 4), snapshot-miss + intent (re-send),
  miss + no intent (silent).
* Gate: `vitest VoiceContext` green. Manually: kill a gateway node mid-call,
  confirm the client re-sends Op 4 on READY without user action.
* Unlocks: nothing yet — but every later step's drill depends on this
  fallback existing.

### Step 2 — sfu-2 + hash placement (infra + one function)

Compose sfu-2 with disjoint UDP range/WS port; fix the 50000-50020 vs
40000-40100 mismatch; `dispatch_voice_server_update` selects via
`:erlang.phash2(channel_id)` over a *statically configured* two-entry list
(single-endpoint default = today's behavior).

* Tests: affinity (same channel → same endpoint, stable across calls;
  channels spread over both); single-endpoint config behaves exactly as
  today (existing voice tests untouched and green).
* Gate: `mix test` voice suite green; `docker compose up` shows both SFUs
  healthy; manual join lands on the hashed SFU per channel.
* Unlocks: pool exists; failover logic has something to choose between.

### Step 3 — Health poller + dead-node exclusion (gateway-only)

Background poller (`GET /healthz` per SFU, 5–10s, one in-flight check per
SFU) maintains the live list Step 2 hashes over. Requests never block on a
probe. `giveUp()` → Op 4 re-request now naturally lands on the survivor
(capped retries, reset on `connected`).

* Tests: mark-dead → same-channel re-request returns sfu-2; resurrect →
  affinity restored; 50 concurrent complaints → one probe (assert via
  poller/request counter, not 50 HTTP hits).
* Gate: `mix test` green; manual `docker stop kith-sfu-1` → re-Op 4 lands
  on sfu-2 within one poll interval.
* Unlocks: failover works end-to-end (minus the speed/discpline of §Step 4).

### Step 4 — Null-then-reallocate push + client park/wait

On poller-declared death, push `endpoint: null` to affected sessions first,
then the fresh allocation. Client: tear down on null, park in `connecting`,
rebuild on the real endpoint; timeout → `failed`. Affected-only scoping
(other channels' sessions get nothing).

* Tests: null push scoped to dead-node channels; null → park (no reconnect
  attempt); real endpoint → rebuild; timeout → `failed`; unaffected session
  receives nothing.
* Gate: `vitest` + `mix test` green; manual kill → clients visibly park
  then migrate (no flapping back onto the corpse).
* Unlocks: the ≤2s drill path is complete; remaining work is speed (Tier 1)
  and proof (harness).

### Step 5 — Tier 1 session mirror + guarded push (gateway-only)

Handler notifies session after `update_voice_state` → `{:ok}` (never on
error); session keeps per-gid ack-only cache, cleared at leave send-time;
resubscribe piggybacks cache; actor applies under the 4 rules (accept-if-
absent, lease-gated, permission re-checked, session stamped from the call).

* Tests: ack-only caching (error → no cache); leave clears one gid;
  resubscribe piggyback; accept-if-absent; lease-drop on non-holder;
  permission re-check rejects; restarted actor + survivor resubscribe →
  roster whole with zero Op 4s.
* Gate: `mix test` green incl. the D1-upgrade assertion (whole at
  resubscribe +0.7s).
* Unlocks: roster recovery no longer waits on browsers for survivors.

### Step 6 — Chaos harness + sign-off

New `scripts/chaos/phase7_sfu.sh` (mirrors `phase6_video.sh`): Drill 5
graduates (SIGKILL sfu-1 → co-location asserted + first keyframe ≤2s),
deaf-client control (no failover on healthy-SFU complaints), roster drill
(survivor whole at resubscribe, dead-node whole at READY). Predictions in
the script header before run 1; prediction-vs-reality goes to
`postmortems/chaos-log.md` under issue #89 (chaos catalog owns the log);
limits (§6) into `sfu-guide.md`; close #87.

* Gate: all drills green, §8 boxes ticked.
