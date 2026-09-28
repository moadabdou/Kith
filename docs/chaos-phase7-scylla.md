# Chaos Engineering Experiment Report: Phase 7 Drill 5 — ScyllaDB Node Network Partition Under Live Load

- **Experiment ID:** `CHAOS-PHASE-7-DRILL-5-SCYLLA-PARTITION`
- **Issue Reference:** Closes part of [#97](https://github.com/moadabdou/Kith/issues/97)
- **Target Tier:** ScyllaDB Distributed Message Store (`scylladb/scylla:6.2`, 3-node cluster, RF=3)
- **Execution Date:** September 28, 2026
- **Tooling:** [`scripts/chaos/phase7_scylla.sh`](../scripts/chaos/phase7_scylla.sh), [`scripts/chaos/phase7_scylla_chaos.go`](../scripts/chaos/phase7_scylla_chaos.go)
- **Results Artifact:** [`scripts/chaos/results/phase7_scylla_drill5.json`](../scripts/chaos/results/phase7_scylla_drill5.json)

---

## 1. Executive Summary

Phase 7 Chaos Drill 5 subjected Kith's distributed message storage layer to a full network partition under continuous concurrent live read/write traffic:
1. **Quorum Invariant Under 1/3 Node Failure**: Mid-burst, node `scylla2` (`172.21.0.3`) was isolated from the Docker bridge network (`kith-scylla-cluster_default`) and gossip disabled (`nodetool disablegossip`). Throughout the 8.0-second partition window, **1,984 out of 1,984 write requests at `LOCAL_QUORUM` succeeded with 0 failures (100.0% write availability)**, empirically proving that 2 out of 3 replicas ($\frac{2}{3} \ge \text{QUORUM}$) maintain linearizable write throughput without degradation.
2. **Strict Quorum Boundary Verification**: Concurrent control writes attempted at `Consistency: ALL` (requiring $\frac{3}{3}$ replicas) suffered **100% failure (5/5 failed)** during the partition window, proving strict enforcement of distributed quorum boundaries.
3. **Recovery Time Objective (RTO)**: Upon restoring the network connection and re-enabling gossip, the cluster phi-accrual failure detector recognized `scylla2` as `UN` (Up/Normal) in **1.35 seconds** (well within the $\le 15\text{s}$ gate).
4. **Recovery Point Objective (RPO) & Anti-Entropy Catch-Up**: Post-reconnect anti-entropy repair (`nodetool repair -pr kith messages`) combined with hinted handoff synchronized all mutations. A direct cryptographic row-by-row audit across all three nodes (`scylla1`, `scylla2`, `scylla3`) at `Consistency: ONE` confirmed **100.0% row parity (1,984/1,984 messages on all 3 nodes), 0 missing rows ($\text{RPO} = 0$), and 0 byte-level content corruptions**.
5. **Post-Healing Stress & Latency Recovery**: High-concurrency stress bursting (1,000 ops) post-healing verified throughput recovery to **2,067.1 writes/sec** with write **p99 latency of 4.36ms** and read **p99 latency of 5.26ms** (far below the $< 50\text{ms}$ SLO gate).

---

## 2. Invariants Under Test

| Invariant | Target Specification | Measured Result | Status |
| :--- | :--- | :---: | :---: |
| **1. Quorum Write Availability** | 0 write failures at `LOCAL_QUORUM` during partition ($\frac{2}{3}$ quorum) | **0 failures (1,984 / 1,984 ops)** | **PASS** |
| **2. Quorum Read Linearizability** | 0 read errors / 0 phantom reads at `LOCAL_QUORUM` | **0 errors (1,976 / 1,976 ops)** | **PASS** |
| **3. Strict Quorum Boundary** | 100% failure rate for writes at `Consistency: ALL` during partition | **100% failure (5 / 5 ops)** | **PASS** |
| **4. Recovery Time Objective (RTO)** | $\text{RTO} \le 15.0\text{s}$ from network reconnect to `UN` state | **1.35s** | **PASS** |
| **5. Recovery Point Objective (RPO)** | $\text{RPO} = 0$ (zero silent message loss after anti-entropy repair) | **0 missing rows (1,984 / 1,984 on all 3 nodes)** | **PASS** |
| **6. Zero State Corruption** | 0 content mismatches across all 3 nodes at `Consistency: ONE` | **0 corruptions (0 mismatches)** | **PASS** |
| **7. Post-Healing Write Latency (p99)** | Write p99 latency $< 50\text{ms}$ under stress load | **4.36ms** | **PASS** |
| **8. Post-Healing Read Latency (p99)** | Read p99 latency $< 50\text{ms}$ under stress load | **5.26ms** | **PASS** |

---

## 3. Empirical Latency Profile & Throughput

```
Phase                    Ops    p50 (ms)   p95 (ms)   p99 (ms)   Max (ms)   Availability
-----------------------------------------------------------------------------------------
Baseline Writes          300      1.58       2.12       3.55      18.26        100.0%
Baseline Reads           300      1.68       2.31       3.26       4.57        100.0%
Partition Writes (W=2)  1984      2.29       4.23       6.91      14.65        100.0%
Partition Reads  (R=2)  1976      2.38       4.32       7.22      15.98        100.0%
Partition Probe  (W=3)     5       N/A        N/A        N/A        N/A          0.0% (expected)
Post-Healing Stress     1000      1.74       3.26       4.36       5.51        100.0%
```

---

## 4. Quorum Math & LSM Storage Analysis

In ScyllaDB with Replication Factor $N = 3$, the quorum size is:
$$Q = \left\lfloor \frac{N}{2} \right\rfloor + 1 = \left\lfloor \frac{3}{2} \right\rfloor + 1 = 2$$

When one node (`scylla2`) is network-partitioned:
- **Write Path ($W = 2$)**: The coordinator dispatches write mutations to all endpoints in the replica set. Because `scylla1` and `scylla3` remain connected, they both acknowledge the mutation. $2 \ge Q$, so the coordinator immediately returns success to the client.
- **Hint Buffering**: For the unreachable replica `scylla2`, coordinators log hints in their commitlog/hint structures.
- **Read Path ($R = 2$)**: Reads at `LOCAL_QUORUM` contact 2 replicas. The intersection condition is satisfied:
  $$\{ \text{Write Replicas} \} \cap \{ \text{Read Replicas} \} \neq \emptyset$$
  Because $R + W = 4 > 3$, the read is guaranteed to observe the latest mutation timestamp, precluding stale or phantom reads.
- **Healing & Anti-Entropy**: Upon reconnecting `scylla2`, hinted handoffs are dispatched. Executing `nodetool repair -pr kith messages` constructs Merkle trees of token ranges, exchanging diffs between SSTables. This restored all 1,984 rows to `scylla2` with zero loss.

---

## 5. Gate Conclusion

Phase 7 Chaos Drill 5 satisfies all requirements of **Issue #97** and **`plan/09-scalability-failover.md` §4, §5**:
- Failover and recovery occurred within stated RTO (1.35s $\le$ 15s) and RPO (0 lost messages).
- Zero silent message loss or state corruption during and after node partition.
- Post-healing throughput and latency recovered with p99 of 4.36ms ($< 50\text{ms}$).
- **Drill 5 Gate Verdict: PASS**.
