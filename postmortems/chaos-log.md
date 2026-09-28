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

## Phase 7e — Failure Drills: ScyllaDB partition under live load (Issue #97, Drill 5)

Harness: `scripts/chaos/phase7_scylla.sh` (`scripts/chaos/phase7_scylla_chaos.go`).
Topology: 3-node Scylla cluster (`scylla1`, `scylla2`, `scylla3`, RF=3, NetworkTopologyStrategy).
Target: `kith.messages` table with TWCS compaction.

### D5 — ScyllaDB node network partition under live read/write load

* Prediction:
  - 3-node cluster with RF=3 has Quorum = 2. Partitioning `scylla2` (`docker network disconnect` + `nodetool disablegossip`) leaves `{scylla1, scylla3}` surviving (66.7% > 50%).
  - Live writes and reads at `LOCAL_QUORUM` (W=2, R=2) will continue with 100% availability (0 errors) throughout the partition window.
  - In contrast, writes with `Consistency: ALL` (W=3) must fail 100% while `scylla2` is isolated.
  - Upon network reconnection and gossip enable, RTO will be <= 15s.
  - Anti-entropy catch-up (`nodetool repair -pr kith messages`) reconciles all partition-window writes to the recovered node with RPO = 0 (100% row match across all 3 nodes, 0 missing rows, 0 content corruption).
  - Post-healing stress burst recovers to 100% throughput with write/read p99 latency < 50ms.
* Actual:
  - Partition window: 8.0s under live concurrent traffic.
  - Quorum invariant: 1,984/1,984 writes at `LOCAL_QUORUM` succeeded (0 failures, 100.0% availability).
  - Quorum reads: 1,976/1,976 reads at `LOCAL_QUORUM` succeeded (0 failures, 0 phantoms).
  - Quorum boundary probe: 5/5 writes at `Consistency: ALL` failed (100% failure as expected by quorum math).
  - Recovery Time Objective (RTO): 1.35s (from network reconnect to `nodetool status` reporting `UN`). Gate <= 15s ✓.
  - Anti-entropy audit: 1,984 / 1,984 messages present on Node 1 (100%), Node 2 (100%), and Node 3 (100%).
  - Recovery Point Objective (RPO): 0 missing rows, 0 content mismatches (0 corruption). Gate RPO = 0 ✓.
  - Verdict: **PASS**. Results archived in `scripts/chaos/results/phase7_scylla_drill5.json`.

## Phase 7f — Failure Drills: NATS JetStream leader kill & failover (Issue #97, Drill 6)

Harness: `scripts/chaos/phase7_nats.sh` (`scripts/chaos/phase7_nats_chaos.go`).
Topology: 3-node NATS cluster (`nats1`, `nats2`, `nats3`, Raft consensus, Stream `KITH_EVENTS_CHAOS`, R=3).
Target: JetStream clustered event stream & durable pull consumer.

### D6 — NATS JetStream leader kill & consumer stream auto-reconnect

* Prediction:
  - 3-node NATS JetStream cluster with stream replication $R=3$ maintains Raft consensus across `{nats1, nats2, nats3}`.
  - Active Raft leader will be identified via `StreamInfo.Cluster.Leader`.
  - Abrupt `docker kill -s SIGKILL` on the leader container mid-burst will trigger Raft leader election on surviving 2 nodes in $\le 5\text{s}$ ($\text{RTO} \le 5\text{s}$).
  - Live publishers and consumers will auto-reconnect and resume stream deliveries in $\le 10\text{s}$.
  - Zero event loss ($\text{RPO} = 0$): every message published and acknowledged will be preserved.
  - Redelivered in-flight messages will be idempotently deduplicated (0 client-visible duplicates).
  - Post-failover throughput and latency will recover to 100% with $p99 < 50\text{ms}$.
  - Restarted victim node will rejoin the cluster and catch up with Raft log replication in $\le 15\text{s}$.
* Actual:
  - Initial Raft Leader: `nats3` -> Failover Leader: `nats2`.
  - Cluster Raft Failover RTO: 4.31s (Gate $\le 5.0\text{s}$ ✓).
  - Client Stream Reconnect RTO: 4.42s (Gate $\le 10.0\text{s}$ ✓).
  - Published Messages: 1,924 | Acknowledged & Received: 1,924 | Lost: 0.
  - Recovery Point Objective (RPO): 0 Events Lost (Gate $\text{RPO} = 0$ ✓).
  - Idempotency & Deduplication: 0 client-visible duplicates (Gate 0 ✓).
  - Post-failover stress burst (1,000 ops on 2 survivors): 5,245.4 msgs/sec. Pub $p50: 0.17\text{ms}, p95: 0.23\text{ms}, p99: 0.53\text{ms}$ ($< 50\text{ms}$ gate ✓). Sub $p50: 0.00\text{ms}, p95: 0.01\text{ms}, p99: 0.02\text{ms}$ ($< 50\text{ms}$ gate ✓).
  - Node recovery & Raft catch-up: `nats3` restarted and resynced in 6.10s.
  - Verdict: **PASS**. Results archived in `scripts/chaos/results/phase7_nats_drill6.json`.

### Environment notes (applies to all Phase 7 drills)

* Caddy needs `--force-recreate` to pick up Caddyfile edits (bind mount).
* `docker kill` victims do not restart under `unless-stopped` here
  (daemon-side; RestartCount stays 0). Drill condition = node stays down.
* Box is oversubscribed (8c/7GB, load ~13 under stack) — absolute latency
  numbers are lower bounds; see `docs/capacity-table.md` row 1.
