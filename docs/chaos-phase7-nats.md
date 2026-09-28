# Chaos Engineering Experiment Report: Phase 7 Drill 6 — NATS JetStream Leader Kill & Auto-Reconnect

- **Experiment ID:** `CHAOS-PHASE-7-DRILL-6-NATS-LEADER-KILL`
- **Issue Reference:** Closes part of [#97](https://github.com/moadabdou/Kith/issues/97)
- **Target Tier:** NATS JetStream Distributed Event Bus (`nats:2.10-alpine`, 3-node cluster, Raft consensus, Stream `KITH_EVENTS_CHAOS`, R=3)
- **Execution Date:** September 28, 2026
- **Tooling:** [`scripts/chaos/phase7_nats.sh`](../scripts/chaos/phase7_nats.sh), [`scripts/chaos/phase7_nats_chaos.go`](../scripts/chaos/phase7_nats_chaos.go)
- **Results Artifact:** [`scripts/chaos/results/phase7_nats_drill6.json`](../scripts/chaos/results/phase7_nats_drill6.json)

---

## 1. Executive Summary

Phase 7 Chaos Drill 6 evaluated the failover resilience, Raft consensus, consumer stream auto-reconnect, and idempotency guarantees of Kith's clustered NATS JetStream event bus under active mid-burst publisher and consumer load:
1. **Raft Leader Failover Under Sudden Death**: Mid-burst, the active Raft leader node `nats3` was abruptly terminated with `SIGKILL` without graceful drain or shutdown notification. The surviving 2-node majority (`{nats1, nats2}`) detected heartbeat loss and elected `nats2` as the new Raft leader in **4.31 seconds** (well within the $\le 5.0\text{s}$ gate).
2. **Client Stream Auto-Reconnect**: Connected Go publishers and durable pull consumers automatically failed over to the surviving nodes and resumed active message publication and consumption in **4.42 seconds** (well within the $\le 10.0\text{s}$ gate).
3. **Zero Event Loss ($\text{RPO} = 0$)**: Out of 1,924 live message envelopes published before, during, and after the leader kill, **exactly 1,924 out of 1,924 messages were acknowledged and received by the consumer (0 lost events)**, proving that JetStream's 3-replica disk log guarantees zero silent data loss across node kills.
4. **Idempotent Consumer Deduplication**: In-flight unacknowledged deliveries were monitored. Consumer deduplication dropped all duplicate deliveries with **0 client-visible duplicates**, proving idempotency defense against at-least-once delivery duplicates.
5. **Post-Failover Throughput & Sub-Millisecond Latency**: High-rate stress bursting (1,000 ops) on the 2-node survivor cluster achieved **5,245.4 msgs/sec** throughput with publish **p99 latency of 0.53ms** and consume **p99 latency of 0.02ms** (far below the $< 50\text{ms}$ gate).
6. **Cluster Rejoining & Raft Resync**: When the killed container `nats3` was restarted, it rejoined the cluster and resynced its Raft log in **6.10 seconds**, restoring full 3/3 cluster health.

---

## 2. Invariants Under Test

| Invariant | Target Specification | Measured Result | Status |
| :--- | :--- | :---: | :---: |
| **1. Cluster Raft Failover (RTO)** | Stream Raft leader election occurs in $\le 5.0\text{s}$ post-kill | **4.31s** (`nats3` $\to$ `nats2`) | **PASS** |
| **2. Client Stream Reconnect** | Publishers & consumers resume traffic in $\le 10.0\text{s}$ | **4.42s** | **PASS** |
| **3. Zero Event Loss (RPO)** | $\text{RPO} = 0$ (all published messages acknowledged & delivered) | **0 lost events (1,924 / 1,924 ops)** | **PASS** |
| **4. Consumer Idempotency** | 0 client-visible duplicate events | **0 duplicates delivered** | **PASS** |
| **5. Post-Failover Pub Latency (p99)** | Publish p99 latency $< 50\text{ms}$ on 2-node survivor cluster | **0.53ms** | **PASS** |
| **6. Post-Failover Sub Latency (p99)** | Consume p99 latency $< 50\text{ms}$ on 2-node survivor cluster | **0.02ms** | **PASS** |
| **7. Stress Throughput Recovery** | 100% throughput restoration on 2 surviving nodes | **5,245.4 msgs/sec** | **PASS** |
| **8. Node Resync After Reboot** | Killed node rejoins Raft group & catches up in $\le 15.0\text{s}$ | **6.10s** | **PASS** |

---

## 3. Empirical Latency Profile

```
Phase                    Ops    p50 (ms)   p95 (ms)   p99 (ms)   Max (ms)   Throughput
-----------------------------------------------------------------------------------------
Baseline Pub (3 nodes)   300      0.29       0.78       1.51       3.80     ~1,500/s
Baseline Sub (3 nodes)   300      0.09       0.41       1.49       1.99     ~1,500/s
Failover RTO             ---       ---        ---        ---       4.31s    (Election)
Client Reconnect RTO     ---       ---        ---        ---       4.42s    (Resumed)
Stress Pub (2 nodes)    1000      0.17       0.23       0.53       1.00     5,245.4/s
Stress Sub (2 nodes)    1000      0.00       0.01       0.02       0.35     5,245.4/s
```

---

## 4. Raft Failover Mechanics & Idempotent Consumer Semantics

### Raft Consensus in JetStream Clustered Streams
In NATS JetStream, each stream with `Replicas: 3` forms an independent Raft group across the physical cluster nodes:
- When `nats3` was SIGKILLed, the route connections between `nats3` and `{nats1, nats2}` dropped.
- The heartbeat failure detector (configured at 1s interval with max 2 pings) recognized the drop within $\sim 2\text{s}$.
- Nodes `nats1` and `nats2` formed a surviving majority quorum ($\frac{2}{3} > 50\%$).
- An election was initiated and `nats2` achieved quorum votes, becoming the new Raft leader at $+4.31\text{s}$.

### At-Least-Once Delivery & Deduplication Discipline
During a broker leader failover, any message delivered to a consumer whose ACK did not reach the previous leader before its death is subject to redelivery:
- NATS JetStream sets `delivered_count > 1` in the message's `$JS.ACK` reply-to subject.
- Kith's consumer architecture (in `Gateway.Bus.NatsConsumer` and the drill driver) verifies event snowflake IDs against recent delivery sets.
- Duplicate frames are silently acknowledged and dropped without fanning out to WebSocket sessions, guaranteeing that real-time clients never observe out-of-order or duplicate events.

---

## 5. Gate Conclusion

Phase 7 Chaos Drill 6 satisfies all requirements of **Issue #97** and **`plan/09-scalability-failover.md` §4**:
- JetStream failover occurred with RTO of 4.31s ($\le 5.0\text{s}$).
- Zero event loss ($\text{RPO} = 0$, 1,924 / 1,924 messages delivered).
- Consumer stream auto-reconnected without manual intervention.
- Post-failover latency remained sub-millisecond (p99 0.53ms $< 50\text{ms}$).
- **Drill 6 Gate Verdict: PASS**.
