# Chaos Log (Phase 7)

Prediction-first record: each entry states the prediction written BEFORE
the run, then the actual. The gap between them is the education.

## Phase 7c — Gateway clustering (Issue #86, 2026-09-24)

Harness: `scripts/chaos/phase7_gateway.sh` (+ `.js` driver).
Topology: `gateway` + `gateway-2` (Horde cluster), Caddy `/ws` round-robin,
Redis lease (10s TTL / 3s renew), NATS broadcast + actor dedup.

### D1 — kill actor-holding node

* Prediction: Horde restarts the bench-guild actor on the survivor quickly;
  survivor clients keep sockets and re-subscribe (small gap = during-window
  posts dropped); dead-node clients silent till re-IDENTIFY; zero dups.
* Actual: actor +0.2s, re-subscribe +0.7s, lease acquired +9s, first
  survivor frame +9.7s (log timestamps). Survivor 8/9 (one during-window
  post correctly lease-dropped), dead-node 3/3 pre-only, zero dups.
  Victim container did NOT restart (daemon stopped restart-manager at kill
  time; observed 5×) — numbers describe permanent node loss.
* SLOs: #1 (~9s ≤ 15s) ✓, #2 (~10s ≤ 30s) ✓, #4 (0 dups) ✓.

### D2 — SIGSTOP 30s (split-brain) + lease

* Prediction: frozen holder can't renew its 10s lease; survivor claims and
  serves mid-stop; early-window posts may gap; zero dups; acquisitions +1.
* Actual: service continued on survivor mid-stop (6/6 there),
  lease acquisitions 0→2 on survivor, TOTAL_DUPS=0 across all clients.
  SIGCONT healed silently.
* SLO #5 ✓. The lease design works as specified.

### D3 — api-1/api-2 interleave + shuffled RESUME

* Prediction: 20 concurrent posts alternating replicas all delivered
  exactly once; shuffled resume (behind by 2) replays monotonic, dup-free.
* Actual: resume client `closed_at_seq 21, replayed 4/4 monotonic, 0 dups,
  invalid_session false`. (Same-node TTL semantics; cross-node RESUME is
  op 9 by design — sessions are node-local.)
* Surfaced the cold-cache silent-client bug en route (fixed: warm-on-miss;
  see `docs/gateway-clustering.md` §Bugs).

### D4 — fresh cohort resync timing

* Prediction: cohort IDENTIFies fast post-kill, creates the actor itself by
  subscribing, receives everything; kill→whole well under 60s.
* Actual: actor created by cohort at +2s, all 4 sessions within 80ms after,
  3/3 received each, zero dups. Kill→whole 27s (mostly drill overhead:
  IDENTIFY round-trips + 25s listen window; system contribution ~2s).
* SLO #3 (27s ≤ 60s) ✓.

### Environment notes (applies to all Phase 7 drills)

* Caddy needs `--force-recreate` to pick up Caddyfile edits (bind mount).
* `docker kill` victims do not restart under `unless-stopped` here
  (daemon-side; RestartCount stays 0). Drill condition = node stays down.
* Box is oversubscribed (8c/7GB, load ~13 under stack) — absolute latency
  numbers are lower bounds; see `docs/capacity-table.md` row 1.
