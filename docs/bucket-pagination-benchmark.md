# 100k-Message Multi-Bucket Benchmark & Cross-Bucket Pagination Verification

**Phase 3 Milestone Gate: Message Storage & Partition Bucketing**  
*Date: September 2026*  
*Target Component: `internal/messages/scylla_store.go`, `internal/messages/handler.go`, `scylladb/scylla:6.2`*

---

## 1. Executive Summary

As specified in `plan/03-message-store.md` §10 (Phase 3 Gates), message storage in Kith partitions high-volume channels into deterministic 10-day time buckets ($B = \lfloor (\text{snowflake} \gg 22) / 864{,}000{,}000 \rfloor$) to prevent partition unbounded growth and hot spots.

This benchmark rigorously verifies:
1. **Bulk Seeding**: 100,000 real messages written concurrently into ScyllaDB across 3 distinct partition buckets ($B_{23}$, $B_{24}$, $B_{25}$) using prepared CQL statements.
2. **REST API Pagination**: Complete backward traversal through the HTTP API (`GET /api/guilds/{id}/channels/{cid}/messages?limit=100&before=<cursor>`) using opaque base64 cursor tokens (`X-Next-Cursor`).
3. **Correctness Invariants**:
   - **Count**: Exactly 100,000 unique messages fetched.
   - **Zero Duplicates**: $0$ duplicate message IDs observed.
   - **Strict Monotonic Ordering**: $m_i > m_{i+1}$ throughout the entire 100k sequence.
   - **Seamless Bucket Transitions**: Dynamic multi-bucket boundary hopping across Bucket 25 $\to$ 24 $\to$ 23 with zero missed messages.
   - **Clean Termination**: Clean termination at the channel creation boundary without infinite polling or errors.
4. **Performance**: p99 HTTP latency of **5.58ms** per 100-message batch, reading at **~29,000 messages/sec** end-to-end.

---

## 2. Partition & Data Model

### 2.1 CQL Schema (`kith.messages`)
```cql
CREATE TABLE IF NOT EXISTS kith.messages (
    channel_id bigint,
    bucket int,
    message_id bigint,
    author_id bigint,
    content text,
    edits list<text>,
    type smallint,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
      'class': 'TimeWindowCompactionStrategy',
      'compaction_window_size': '10',
      'compaction_window_unit': 'DAYS'
  };
```

- **Partition Key**: `(channel_id, bucket)` ensures each 10-day window maps to an isolated Scylla partition, bound to a specific SSTable time window under TWCS.
- **Clustering Key**: `message_id DESC` allows backward historical queries to execute sequential disk/memtable reads without sorting.

### 2.2 Bucket Math
Each message ID is an app-generated 64-bit Snowflake:
$$\text{offset\_ms} = \text{snowflake\_id} \gg 22$$
$$\text{bucket} = \left\lfloor \frac{\text{offset\_ms}}{864{,}000{,}000} \right\rfloor$$
where $864{,}000{,}000\text{ ms} = 10\text{ days}$.

---

## 3. Benchmark Architecture & Methodology

### 3.1 Seeder (`scripts/seed_multi_bucket_messages.go`)
- Establishes a test guild (`99800000000000002`), test channel (`83349209088004097`), and test user in PostgreSQL.
- The channel creation timestamp is set to the inception boundary of Bucket 23.
- Generates 100,000 valid Snowflake IDs distributed across 3 buckets:
  - **Bucket 23**: 33,333 messages
  - **Bucket 24**: 33,333 messages
  - **Bucket 25**: 33,334 messages
- Concurrently writes to ScyllaDB (`127.0.0.1:9042`) using 32 worker goroutines with prepared CQL statements at `Consistency: ONE`.
- Writes benchmark metadata to `/tmp/kith_benchmark_meta.json`.

### 3.2 Verifier (`scripts/verify_pagination_buckets.go`)
- Authenticates against `POST /api/auth/login` to obtain a JWT.
- Issues `GET /api/guilds/{id}/channels/{cid}/messages?limit=100` (fetch latest).
- In a loop, extracts the `X-Next-Cursor` response header (base64 token encoding `{"m": message_id, "b": bucket}`) and queries `?before=<cursor>&limit=100`.
- Validates every message ID, snowflake timestamp, order, and bucket.
- Tracks per-request latency using high-resolution timers.

---

## 4. Empirical Benchmark Results

### 4.1 Seeding Phase (Write Throughput)
```text
=================================================================
       KITH: 100,000 MESSAGE MULTI-BUCKET SEEDER (PHASE 3)      
=================================================================
→ [1/4] Connecting to PostgreSQL & seeding test channel... DONE
→ [2/4] Connecting to ScyllaDB at 127.0.0.1:9042... DONE
→ [3/4] Generating 100,000 snowflake IDs spanning 3 buckets...
   • Bucket 23: 33333 messages
   • Bucket 24: 33333 messages
   • Bucket 25: 33334 messages
→ [4/4] Bulk inserting 100,000 messages using 32 concurrent workers...
   [  1.0s] Inserted  43599 / 100000 ( 43586 msg/sec)
   [  2.0s] Inserted  79569 / 100000 ( 39781 msg/sec)

✔ Successfully seeded 100000 messages in 2.52s (39667 msg/sec)
```

### 4.2 Pagination & Verification Phase (Read Path)
```text
=================================================================
   KITH: 100K MULTI-BUCKET CROSS-PAGINATION VERIFIER (PHASE 3)  
=================================================================
• Target API:        http://127.0.0.1:8080
• Guild ID:          99800000000000002
• Channel ID:        83349209088004097
• Expected Messages: 100000
• Expected Buckets:  [Bucket 23: 33333 msgs] [Bucket 24: 33333 msgs] [Bucket 25: 33334 msgs] 

→ [1/3] Authenticating as bench user... DONE (Token received, User: bench_pagination)
→ [2/3] Traversing entire message history via GET /api/guilds/99800000000000002/channels/83349209088004097/messages?limit=100...
   [  0.4s] Paginating: page  100 |  10000 msgs retrieved |  26403 msg/s | current bucket: 25
   [  0.8s] Paginating: page  200 |  20000 msgs retrieved |  26203 msg/s | current bucket: 25
   [  1.1s] Paginating: page  300 |  30000 msgs retrieved |  27938 msg/s | current bucket: 25
   ⚡ Page  334 (Msg # 33335): Crossed boundary Bucket 25 ➔ Bucket 24
   [  1.4s] Paginating: page  400 |  40000 msgs retrieved |  28842 msg/s | current bucket: 24
   [  1.7s] Paginating: page  500 |  50000 msgs retrieved |  29128 msg/s | current bucket: 24
   [  2.0s] Paginating: page  600 |  60000 msgs retrieved |  29559 msg/s | current bucket: 24
   ⚡ Page  667 (Msg # 66668): Crossed boundary Bucket 24 ➔ Bucket 23
   [  2.5s] Paginating: page  700 |  70000 msgs retrieved |  28075 msg/s | current bucket: 23
   [  2.8s] Paginating: page  800 |  80000 msgs retrieved |  28388 msg/s | current bucket: 23
   [  3.1s] Paginating: page  900 |  90000 msgs retrieved |  28916 msg/s | current bucket: 23
   [  3.4s] Paginating: page 1000 | 100000 msgs retrieved |  29001 msg/s | current bucket: 23
   🏁 Page 1001: Received 0 messages — reached channel creation boundary cleanly.
```

### 4.3 Summary Metrics & Assertions Table

| Metric | Target / Expectation | Measured Result | Status |
|---|---|---|:---:|
| **Total Messages Fetched** | $100{,}000$ | **$100{,}000$** | **PASS** |
| **Duplicate Messages** | $0$ | **$0$** | **PASS** |
| **Monotonic Ordering Violations** | $0$ | **$0$** | **PASS** |
| **Bucket 25 Messages** | $33{,}334$ | **$33{,}334$** | **PASS** |
| **Bucket 24 Messages** | $33{,}333$ | **$33{,}333$** | **PASS** |
| **Bucket 23 Messages** | $33{,}333$ | **$33{,}333$** | **PASS** |
| **Boundary Crossings** | $\ge 2$ | **$2$** (Page 334 & Page 667) | **PASS** |
| **Termination Boundary** | Clean exit (0 msgs) | **Page 1001 (0 msgs)** | **PASS** |
| **Total Execution Time** | $< 10\text{s}$ | **$3.45\text{s}$** | **PASS** |
| **Throughput (Requests/sec)** | $> 100\text{ req/s}$ | **$289.9\text{ req/s}$** | **PASS** |
| **Throughput (Messages/sec)** | $> 10{,}000\text{ msg/s}$ | **$28{,}987.2\text{ msg/s}$** | **PASS** |

### 4.4 HTTP REST Latency Breakdown

| Percentile | Latency (ms) |
|---|---|
| **Min** | 1.19 ms |
| **Avg** | 2.99 ms |
| **p50** | 2.85 ms |
| **p90** | 4.14 ms |
| **p95** | 4.65 ms |
| **p99** | 5.58 ms |
| **Max** | 9.11 ms |

---

## 5. ScyllaDB Engine Metrics (`nodetool tablestats`)

Running `nodetool tablestats kith.messages` immediately following the benchmark shows:
```text
Keyspace : kith
    Read Count: 1111
    Read Latency: 0.233 ms
    Write Count: 200061
    Write Latency: 0.003 ms
        Table: messages
        SSTable count: 1
        Space used (live): 2,952,244 bytes (~2.95 MB)
        SSTable Compression Ratio: 0.40
        Compacted partition maximum bytes: 2,816,159 bytes
        Compacted partition mean bytes: 768,215 bytes
        Dropped Mutations: 0
        Bloom filter false positives: 0
```

### Key Insights:
1. **Storage Efficiency**: With LZ4 compression and TWCS, 100,000 messages occupy only **2.95 MB** on disk (compression ratio **0.40**).
2. **Local Storage Latency**: Local Scylla read latency averages **0.233ms**, and write latency averages **0.003ms**.
3. **Partition Size Ceiling**: Partition sizes average **~768 KB**, peaking at **2.8 MB**, safely below the 100MB Scylla partition warning threshold.

---

## 6. How to Reproduce

1. **Start dependencies with Scylla message store**:
   ```bash
   MESSAGE_STORE=scylla docker compose up -d
   ```

2. **Seed 100,000 messages across 3 buckets**:
   ```bash
   cd scripts
   go run ./seed_multi_bucket_messages.go
   ```

3. **Run cross-bucket pagination verification**:
   ```bash
   cd scripts
   go run ./verify_pagination_buckets.go
   ```

---

## 7. Conclusion & Milestone Sign-off

The bucket-hopping pagination loop in `internal/messages/scylla_store.go` and cursor serialization in `internal/messages/cursor.go` satisfy all correctness and performance requirements of `plan/03-message-store.md` §10. The first Phase 3 milestone gate is verified and closed.
