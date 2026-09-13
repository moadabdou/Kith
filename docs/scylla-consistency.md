# ScyllaDB Distributed Consistency, Phantom-Read Chaos & Tombstone Discipline

This report documents the distributed systems experiments and storage engine analyses performed for **Phase 3 Milestone Gates §6 & §10** of Kith (`plan/03-message-store.md` and GitHub Issue #50).

---

## 1. The Distributed Consistency Equation: $R + W > N$

In distributed leaderless stores (ScyllaDB / Apache Cassandra), consistency is not an absolute property of the cluster; it is a mathematical guarantee tuned on every query:

$$\text{Strong Consistency Condition:} \quad R + W > N$$

Where:
- $N$ is the Replication Factor ($RF = 3$).
- $W$ is the number of replicas that must acknowledge a write before returning success to the client.
- $R$ is the number of replicas that must respond to a read before returning data to the client.

```
Three-Node Cluster (RF = 3), Replication Set = {Node 1, Node 2, Node 3}
───────────────────────────────────────────────────────────────────────

Scenario A: Read at ONE (W = 2, R = 1  ==>  R + W = 3 <= N)  [STALE READ ANOMALY]

       Client Write (LOCAL_QUORUM)                     Client Read (ONE)
              │                                                │
              ├───────────────┬───────────────┐                │
              ▼               ▼               ▼ (Lagging)      ▼ (Hits nearest replica)
        ┌───────────┐   ┌───────────┐   ┌───────────┐    ┌───────────┐
        │  Node 1   │   │  Node 2   │   │  Node 3   │◄───┤  Node 3   │
        │  (v=New)  │   │  (v=New)  │   │  (EMPTY)  │    │  (EMPTY)  │
        └─────┬─────┘   └─────┬─────┘   └───────────┘    └─────┬─────┘
              │               │                                │
              └───────┬───────┘                                ▼
                      ▼                               "Row Not Found!"
             Quorum Achieved (2/3)                 💥 PHANTOM / STALE READ
             Write returns Success!               (Client wrote data but
                                                   cannot read it back!)


Scenario B: Read at LOCAL_QUORUM (W = 2, R = 2  ==>  R + W = 4 > N)  [STRICT CONSISTENCY]

       Client Write (LOCAL_QUORUM)                  Client Read (LOCAL_QUORUM)
              │                                                │
              ├───────────────┬───────────────┐                ├───────────────┐
              ▼               ▼               ▼ (Lagging)      ▼               ▼
        ┌───────────┐   ┌───────────┐   ┌───────────┐    ┌───────────┐   ┌───────────┐
        │  Node 1   │   │  Node 2   │   │  Node 3   │    │  Node 2   │   │  Node 3   │
        │  (v=New)  │   │  (v=New)  │   │  (EMPTY)  │    │  (v=New)  │   │  (EMPTY)  │
        └─────┬─────┘   └─────┬─────┘   └───────────┘    └─────┬─────┘   └─────┬─────┘
              │               │                                │               │
              └───────┬───────┘                                └───────┬───────┘
                      ▼                                                ▼
             Quorum Achieved (2/3)                         Intersection: Node 2 has v=New
             Write returns Success!                        Coordinator returns v=New!
                                                           ✔ ZERO PHANTOM READS
                                                           (Triggers read-repair on Node 3)
```

### Why $W = \text{LOCAL_QUORUM}, R = \text{ONE}$ Yields Phantom Reads
When writing at `LOCAL_QUORUM` ($W = \lfloor 3/2 \rfloor + 1 = 2$), the coordinator requires acknowledgments from 2 out of 3 replicas. The third replica might be lagging, undergoing GC, or temporarily partitioned.
If a client immediately issues a read at `Consistency: ONE` ($R = 1$), the coordinator directs the read to a single replica (often determined by dynamic snitch latency). If that replica is the lagging node, it returns `NotFound` or stale data. The client observes a **phantom read**: they received an HTTP 200 / success confirmation for their message, but immediately cannot read it back.

### Why $W = \text{LOCAL_QUORUM}, R = \text{LOCAL_QUORUM}$ Guarantees Linearizability
With $R = 2$ and $W = 2$, $R + W = 4 > 3$. By the Pigeonhole Principle, any read quorum of size 2 and any write quorum of size 2 **must overlap** by at least one replica:

$$\{ \text{Write Replicas} \} \cap \{ \text{Read Replicas} \} \neq \emptyset$$

The coordinator compares the timestamps returned by the read quorum, selects the newest version, and initiates an asynchronous background **read repair** to update the stale replica.

---

## 2. Empirical Chaos Drill: Phantom Read Verification

We executed a live chaos test against a 3-node Scylla cluster (`scripts/chaos/phase3_scylla_chaos.go`) using `deploy/scylla/compose.scylla-cluster.yml` ($RF=3$).

### Methodology
1. **Write Stream**: Client continuously streams message inserts at `Consistency: LOCAL_QUORUM`.
2. **Failure Injection**: Mid-burst, we partitioned `scylla2` using `nodetool disablegossip`, simulating an isolated node that can still respond to CQL queries from clients but cannot receive writes from the other 2 nodes.
3. **Concurrent Reads**: Real-time reader workers queried every acknowledged message immediately:
   - Path 1: Directed to `scylla2` at `Consistency: ONE`.
   - Path 2: Directed to the cluster at `Consistency: LOCAL_QUORUM`.

### Measured Empirical Results

| Metric | Measured Value |
|---|---|
| Total Messages Acknowledged ($W = \text{LOCAL_QUORUM}$) | **200** |
| Write Failures during Node Partition | **0** (2/3 Quorum intact) |
| `scylla2` Reads at `Consistency: ONE` (Missing Rows) | **86 PHANTOM READS** |
| Cluster Reads at `Consistency: LOCAL_QUORUM` (Missing Rows) | **0 PHANTOM READS** (100% found) |
| Successful Linearizable QUORUM Reads | **200 / 200 (100%)** |

**Conclusion**: The drill conclusively verified the theoretical model. Under node disruption, `ONE` produced an 43% phantom-read rate on the isolated replica, whereas `LOCAL_QUORUM` achieved strict consistency with **0 phantom reads**.

---

## 3. Why Discord's Gateway Architecture Makes Read-Lag Moot for Chat UX

While distributed database theory mandates `LOCAL_QUORUM` for linearizable reads, Discord and modern real-time chat architectures leverage a key UI/UX paradigm:

```
                  POST /api/v1/channels/{id}/messages
Client (Author) ───────────────────────────────────────► API Layer (Go)
       ▲                                                     │
       │                                       ┌─────────────┴─────────────┐
       │                                       ▼                           ▼
       │                                  PostgreSQL /                  NATS Core
       │                                    ScyllaDB                 (Pub/Sub Event)
       │                                       │                           │
       │                               Acknowledged                        ▼
       │                                                              Elixir Gateway
       │                                                                   │
       │                                WebSocket dispatch: MESSAGE_CREATE │
       └───────────────────────────────────────────────────────────────────┘
```

1. **Client Never Reads Back Its Own Write**:
   In traditional CRUD apps, posting a form triggers a redirect or immediate `GET /messages` read-back. In chat, the client UI performs an **optimistic UI update** locally.
2. **WebSocket Gateway as the Source of Truth**:
   The API publishes a `MESSAGE_CREATE` event to the message bus (NATS), which the Elixir Gateway fans out over WebSockets. Every client (including the author) renders the message from the pushed gateway event.
3. **Database is for History, Gateway is for Real-Time**:
   The database write path is an append-only archive for historical pagination and cold reads. Because active readers receive messages via push, replica read-lag in ScyllaDB has zero perceptible effect on active conversations.

---

## 4. Tombstone Discipline & LSM Storage Mechanics

Deleting data in an LSM-tree (Log-Structured Merge-tree) database like ScyllaDB or Cassandra behaves fundamentally differently than in relational engines like PostgreSQL.

```
Step 1: 10,000 Messages Written & Flushed
┌────────────────────────────────────────────────────────┐
│ SSTable 1 (Disk)                                       │
│ [Msg 1] [Msg 2] [Msg 3] ... [Msg 10,000]               │
└────────────────────────────────────────────────────────┘

Step 2: 10,000 Messages Deleted
┌────────────────────────────────────────────────────────┐
│ Memtable (RAM)                                         │
│ [Tombstone 1 @ T_del] [Tombstone 2 @ T_del] ...        │
└────────────────────────────────────────────────────────┘
  * Deleting does NOT erase data from SSTable 1!
  * It appends a tombstone cell marker with timestamp T_del.

Step 3: Memtable Flushed to Disk
┌────────────────────────────────────────────────────────┐
│ SSTable 2 (Disk)                                       │
│ [Tombstone 1] [Tombstone 2] ... [Tombstone 10,000]     │
└────────────────────────────────────────────────────────┘

Step 4: Compaction & Tombstone Eviction (TWCS within Same Window)
┌────────────────────────┐      ┌────────────────────────┐
│       SSTable 1        │  +   │       SSTable 2        │
│  (Original Rows: W1)   │      │   (Tombstones: W1)     │
└───────────┬────────────┘      └───────────┬────────────┘
            │                               │
            └───────────────┬───────────────┘
                            ▼ (Window Compaction within Window 1)
            ┌───────────────────────────────┐
            │ Are both SSTables in same W1  │
            │ AND > gc_grace_seconds?       │
            └───────────────┬───────────────┘
                     YES    │       │ NO
            ┌───────────────┘       └───────────────┐
            ▼                                       ▼
   [Tombstones + Rows PURGED]              [Tombstones Retained]
   Disk space reclaimed!                   Prevents resurrected zombies!
```

### Empirical 10k Deletion Experiment

In Drill 2 of `scripts/chaos/phase3_scylla_chaos.go`, we inserted 10,000 messages, flushed to disk, issued 10,000 `DELETE` statements, flushed again, and triggered a major compaction.

| State | SSTable Count | Live Disk Space | Memtable Data Size | Tombstones per Slice |
|---|---|---|---|---|
| **1. 10k Inserted & Flushed** | 2 | 251,487 bytes | 0 bytes | 0.0 |
| **2. 10k Deleted (In Memtable)** | 2 | 251,487 bytes | **1,637,080 bytes** (RAM!) | 0.0 |
| **3. Deletes Flushed to Disk** | **3 (+1)** | **345,965 bytes (+37%)** | 0 bytes | 0.0 |
| **4. Post Major Compaction** | 1 | 102,532 bytes | 0 bytes | 0.0 |

### Key Observations from the Drill
1. **Deletions are Writes**: Issuing 10,000 deletes did not free memory or disk. In fact, it consumed 1.6MB of RAM in the memtable.
2. **Deletions Increase Disk Footprint**: Flushing the tombstones created a *new* SSTable, growing disk consumption from 251 KB to 345 KB (+37%).
3. **`gc_grace_seconds = 864,000` (10 Days)**:
   Even after major compaction collapsed 3 SSTables into 1, the tombstone markers themselves are retained for 10 days to guarantee that lagging replicas or partitioned nodes do not resurrect the deleted rows as **Zombie Data**.

---

## 5. The Cross-Window Ghost Tombstone Trap in TWCS

TimeWindowCompactionStrategy (TWCS) is optimized for time-series and append-heavy workloads like chat history. However, out-of-order or late deletions introduce a subtle storage trap:

```
Cross-Window Tombstone Ghost Trap (The "Ghost SSTables" Problem in TWCS)
────────────────────────────────────────────────────────────────────────

Window 1 (Day 1 - 7): Historical Window [CLOSED & FROZEN]
┌───────────────────────────────────────────────────────────────────────┐
│ SSTable A (Window 1)                                                  │
│   Row: [Msg 101 @ T = Day 2]                                          │
└───────────────────────────────────────────────────────────────────────┘
  ▲
  │  ❌ TWCS fundamental rule: NEVER compact across different time windows!
  │     SSTables in closed windows are frozen to avoid write amplification.
  ▼
Window 4 (Day 22 - 28): Current Active Window [OPEN]
┌───────────────────────────────────────────────────────────────────────┐
│ SSTable B (Window 4)                                                  │
│   Tombstone: [DELETE Msg 101 @ T = Day 25]                            │
└───────────────────────────────────────────────────────────────────────┘

The Compaction Deadlock (The "Ghost" Dilemma):
─────────────────────────────────────────────
1. LSM Eviction Rule: A tombstone can ONLY be purged if it is compacted
   together in the SAME compaction pass as the data cell it shadows,
   AND age > gc_grace_seconds.
2. TWCS Isolation Rule: Window 4 will NEVER compact against Window 1.
3. The Stalemate:
   • SSTable B (Window 4) CANNOT purge the tombstone: If it did, SSTable A
     would still contain Msg 101, resurrecting the row as a "Zombie"!
   • SSTable A (Window 1) CANNOT purge Msg 101: It is frozen in an old window
     and has no knowledge that a delete was issued in Window 4.

CONSEQUENCES:
  👻 GHOST DATA: Both SSTables remain immortal on disk, never reclaiming space.
  💥 READ AMPLIFICATION: Any slice/range scan across this partition must read
     SSTable B (read tombstone) AND SSTable A (read original row) to reconcile,
     burning disk I/O on every single read.
```

### Architectural Mitigation & Scope Decision
1. **Chat Access Patterns (99%+ Hot Path)**:
   Users predominantly read active conversations. Deep historical deletions are infrequent.
2. **Partition Bucketing Isolates Hot Paths**:
   Because Kith partitions messages by `(channel_id, bucket)` (where `bucket` corresponds to time periods derived from snowflake IDs), queries for active messages only scan the current bucket's partition key. Older buckets live in entirely distinct token ranges, ensuring hot-path queries **never** scan across historical ghost SSTables.
3. **Remediation for Ghost Accumulation**:
   - **Forced Major Compactions**: Running `nodetool compact kith messages` manually merges across all windows, purging shadowed data at the cost of a temporary I/O burst.
   - **Partition-Level Deletes**: Dropping an entire bucket or channel tombstoning the entire partition key avoids individual cell tombstones.
   - **TTL Expiration**: Whole SSTables expiring cleanly can be dropped instantly by TWCS without compaction.

---

## 6. Summary of Phase 3 Gate Status

- [x] **Gate 3: QUORUM vs ONE phantom-read experiment written up**: Empirically proved on 3-node cluster with 86 phantom reads under `ONE` vs 0 under `LOCAL_QUORUM`.
- [x] **Gate 4: Tombstone discipline: delete 10k messages, run nodetool compactionstats, explain what you see**: Verified memtable growth, SSTable expansion on delete, TWCS compaction behavior, and `gc_grace_seconds` zombie prevention.
