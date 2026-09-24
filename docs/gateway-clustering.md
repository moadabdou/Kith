# Gateway Clustering (Phase 7c, Issue #86)

Two gateway BEAM nodes form one cluster (`gateway`, `gateway-2`).
Guild actors live on exactly one node at a time (Horde); sessions stay
local to their node and resync (re-IDENTIFY) after node death — the
Discord row of `plan/01 §6`, chosen over the Redis-buffer row.

## Architecture

```
                Caddy /ws ──┬── gateway:4000 ──┐
                            └── gateway-2:4000 ─┘
                                     │ libcluster DNSPoll (gateway-cluster alias)
                                     ▼
                          one BEAM cluster (shared cookie)
   ┌──────────────┬──────────────────┬──────────────────┐
   │ Horde.Registry (guild actors only)                 │
   │ Horde.DynamicSupervisor (GuildSupervisor only)     │
   │ Redis lease kith:guild-lease:<gid> (SET NX PX)     │
   │ ETS Guild.Cache per node (warm-on-miss from PG)    │
   └──────────────┴──────────────────┴──────────────────┘
```

* **Sessions are node-local** (`Gateway.Registry`, `ConnSupervisor`
  unchanged). A dead node's sessions are gone; clients re-IDENTIFY fresh.
  Same-node TCP blips still RESUME within the 60s TTL.
* **Guild actors are cluster-global** (`Horde.Registry` key `"<gid>"`,
  `Horde.DynamicSupervisor` placement). A dead holder's actor restarts on
  the survivor with empty state; survivor sessions re-subscribe (monitor +
  backoff, `session.ex`); dead-node clients re-IDENTIFY.
* **NATS stays broadcast, dispatch is local-only**: every node consumes
  every event (cache convergence), but only the actor's host dispatches
  (`Actor.dispatch_bus_event/4` drops the mirror copy before it crosses
  distribution). No queue-group migration. Dedup on `{stream_seq, type}`
  and the lease stay as safety nets for split-brain and handover windows —
  a sustained dedup rate now means something is actually wrong, not just
  normal mirror traffic.
* **The lease is the split-brain remedy**: dispatch gated on holding
  `SET key node NX PX 10000`, renewed every 3s. A SIGSTOPped holder can't
  renew → survivor claims within ~10s. Redis outage → fail-open
  (availability over silence, logged loudly).
* **Cache: independent copies, convergent via the bus.** Each node warms
  from PG on miss (`Cache.ensure_member_view/2`, subscribe + voice paths);
  afterwards both copies track the same NATS mutation stream. Stale reads
  are fine; events correct — `plan/01 §7` as built.

## What Discord does (the comparison `plan/01 §6` asks for)

Discord pins sessions to gateway nodes and lets clients resync on node
loss — system availability over perfect resume. This build lands in the
same place: Horde gives *placement* failover for actors, Redis gives
single-dispatcher safety + the lease bound, RESUME covers short gaps —
but nobody promises zero loss across a kill. The difference is we measured
ours: kill → dispatch resumes ~9s, survivor clients whole ~10s, fresh
cohort whole 27s (drill overhead included). Discord's numbers are bigger
and better; the methodology — resync with a measured bound — is the same.

## SLOs (measured, Phase 7c drills)

| # | SLO | Measured | Gate |
|---|---|---|---|
| 1 | Kill → dispatch resumes on survivor | ~9s | ≤15s |
| 2 | Kill → survivor clients whole | ~10s | ≤30s |
| 3 | Kill → fresh cohort whole | 27s | ≤60s |
| 4 | Duplicates per client per drill | 0, every run | 0, hard |
| 5 | SIGSTOP 30s: service continues, zero dups | 6/6 mid-stop, 0 dups | pass/fail |

SLO 1 *is* the lease TTL (10s) plus claim latency — the gate asserts the
TTL is honored. SLO 2 adds re-subscribe + first-frame delivery.

## Drill results (2026-09-24, `scripts/chaos/phase7_gateway.sh`)

* **D1 kill**: holder killed → actor restarted +0.2s, sessions
  re-subscribed +0.7s, lease acquired +9s, first survivor frame +9.7s.
  Survivor 8/9 (one during-window post correctly lease-dropped),
  dead-node 3/3 pre-only, zero dups.
* **D2 SIGSTOP 30s**: service continued on survivor mid-stop (6/6 there),
  lease acquisitions 0→2 on survivor, TOTAL_DUPS=0. Split-brain contained
  by the lease exactly as designed.
* **D3 interleave + resume**: concurrent api-1/api-2 posts delivered
  exactly once; shuffled resume (behind by 2) replayed 4/4 monotonic,
  dup-free. Same-node TTL semantics unchanged.
* **D4 fresh cohort**: 4/4 IDENTIFIED in ~1s post-kill, actor created by
  the cohort's own subscribes at +2s, 3/3 received each, zero dups.
  Kill→whole 27s (mostly drill overhead: IDENTIFY round-trips + 25s
  listen window).

Predictions were written before run 1 in the script header; actuals above
match on every mechanism (restart, lease handover, dedup, resync) with
timings inside the predicted bounds.

## Bugs found by the drills (not by reading code)

1. **Cold-cache silent clients.** Cross-node subscribes computed channel
   visibility against the actor node's possibly-empty ETS → deny-by-default
   → clients received nothing, no error anywhere. Fixed with warm-on-miss
   (`cache.ex:ensure_member_view/2`); the bus carries mutations only, so a
   fresh node could never fill baselines by listening. D3's resume client
   was the proof.
2. **`Process.alive?/1` raises on remote pids.** Crashed gw2's consumer on
   first cross-node dispatch. Fixed with node-aware guards in actor,
   session, presence store, and member streaming.
3. **Horde `name` goes in the third arg** of `DynamicSupervisor.start_link`
   (not the init opts) — otherwise restarts lose registration.
4. **Horde vs rest_for_one**: CRDT state + nested shutdowns wedge chaos
   restarts. Fixed with `ClusterFoundation` isolation, bounded CRDT
   shutdown (2s), and libcluster off without distribution.
5. **Drill-harness bugs**: channel-ID arithmetic (extra digit → 403s),
   rate-limit self-throttling (user/channel rotation), subshell variable
   copies (explicit args), Caddy needing `--force-recreate`, vacuous
   any-actor counter, same-second RFC3339Nano string compare (masked
   sub-second recoveries as 99s).

## Limits & honest non-goals

* **Gap events on node death are lost by design**, same as Discord.
  During-window posts (after kill, before lease handover) are dropped,
  not queued.
* **Voice states don't self-heal**: a restarted actor has empty voice
  state; clients must re-send op 4. Documented, not fixed.
* **Killed victims don't restart** (Docker `unless-stopped` did not fire
  after `docker kill`, observed 5× — daemon stopped the restart-manager
  at kill time). All numbers describe permanent node loss, the harsher
  condition. Rejoin (`stop`/`start`) is a separate exercise.
* **Presence stays node-local**; cross-node enrichment may miss.
* No queue-group migration; netsplit safety bounded by lease TTL only.
* `Mix test`: 167/167 green (incl. `clustering_test.exs`: dedup,
  lease round-trip, re-subscribe, cold-cache warm).
