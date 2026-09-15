# Phase 3 Postmortem: Messages at Scale & Full-Text Search

- **Phase:** Phase 3 — Messages at Scale + Search (`plan/11-roadmap.md`, `plan/03-message-store.md`, `plan/04-search.md`)
- **Execution Period:** Week 8–10
- **Closing Milestone Issue:** [#58](https://github.com/moadabdou/Kith/issues/58)

---

## 1. What Surprised Me

### 1.1 TWCS Compaction & Partition Key Hotspots (The 10-Day Bucket Imperative)
In traditional relational databases (PostgreSQL), chronological indexing uses a single B-tree index over `(channel_id, id DESC)`. In distributed wide-column engines (ScyllaDB / Apache Cassandra), rows are physically partitioned across a cluster using the hash of their partition key. 
Our initial assumption was that partitioning simply by `channel_id` would suffice for high-velocity chat channels. However, wide partitions in ScyllaDB become catastrophic at scale:
1. **Unbounded Partition Growth:** In high-throughput public channels (e.g. general discussion in a 100k-member guild), a single channel generates millions of rows. As partition size crosses 100MB, read latency degrades non-linearly due to index-file hopping and excessive memory footprint during partition reads.
2. **Compaction Inefficiencies:** Under **Time Window Compaction Strategy (TWCS)**, SSTables are grouped into fixed time windows (e.g., 1 day). If an active partition is written to continuously over months, data for that single partition spans hundreds of SSTables across different time windows. Merging them during queries bypasses TWCS optimizations.

By introducing a deterministic **10-day bucket partition key** `((channel_id, bucket), message_id)` derived directly from the Snowflake ID timestamp:
$$\text{bucket} = \left\lfloor \frac{\text{snowflake\_ms}}{10 \times 86,400,000} \right\rfloor$$
each partition is naturally capped. SSTables for older buckets freeze into cold disk storage without ever being rewritten by TWCS compactions. Querying across bucket boundaries required implementing transparent multi-partition backward and forward pagination in the application layer (`messages.Store.List` and `messages.Store.ListAfter`), proving that data modeling in distributed storage dictates application-level cursor mechanics.

---

### 1.2 Tombstone Discipline (The Illusion of Instant Delete)
In distributed databases with append-only log-structured merge-tree (LSM) architectures, executing `DELETE` does **not** free disk space or remove records immediately. Instead, it writes a **tombstone marker** containing a deletion timestamp.
During our empirical drills ([docs/scylla-consistency.md](../docs/scylla-consistency.md)):
1. **Tombstone Read Amplification:** When 10,000 messages were deleted in a channel and subsequent reads were issued, ScyllaDB had to scan past thousands of tombstone records to assemble the requested `LIMIT 50` slice. When tombstone density is high, the storage engine emits `WARN: Read 10000 tombstones in channel_id` and query latency spikes from <2ms to >45ms.
2. **Compaction Lag & `gc_grace_seconds`:** Running `nodetool compactionstats` immediately after bulk deletions showed zero reclaimed disk space. In distributed consensus, tombstones cannot be purged during minor compactions until `gc_grace_seconds` has elapsed (default 10 days; tuned to 3600s in development) to guarantee that lagging replicas are repaired before the deletion marker is collected. Otherwise, a resurrected replica will mistake a missing record for an insert and recreate the deleted message ("ghost resurrect").

---

### 1.3 Dual-Write Consistency Edge Cases (Split-Brain Prevention)
During the zero-downtime migration from PostgreSQL to ScyllaDB ([docs/dual-write-scylla-report.md](../docs/dual-write-scylla-report.md)), the write path operated across four distinct migration modes:
1. `postgres_only`
2. `dual_write_pg_primary` (Postgres truth, async Scylla shadow)
3. `dual_write_scylla_primary` (Scylla truth, async Postgres shadow)
4. `scylla_only`

The key architectural revelation was the **asymmetric failure dilemma**:
- If primary storage succeeds but secondary write fails (due to transient network timeouts or connection pool exhaustion), failing the user's HTTP request causes the client to retry a write that *already succeeded in primary storage*.
- To avoid phantom duplicates, secondary write errors must be logged, tracked in telemetry (`SecondaryWriteFailuresTotal`), and repaired asynchronously via background reconciliation scans or shadow-read diffing rather than failing the hot path.
- Furthermore, having search hydration read from PostgreSQL while writes flowed to ScyllaDB created immediate split-brain discrepancies (ghost search results). Complete decoupling required removing PostgreSQL entirely from message storage and search hydration, reserving PostgreSQL strictly for relational metadata (users, guilds, channels, roles).

---

### 1.4 JetStream Consumer Lag Recovery (The 60s Downstream Freeze)
Our Phase 3 Chaos drill ([docs/chaos-phase3.md](../docs/chaos-phase3.md)) subjected the search indexing pipeline to a 60-second total downstream freeze (`docker pause kith-meilisearch-1`) under continuous message creation, editing, and deletion (500 operations).
- **Decoupled Isolation:** The API write path suffered **0.00% error rate**; all 500 messages committed to ScyllaDB and responded to users in under 10ms.
- **Durable JetStream Buffer:** NATS JetStream buffered all events cleanly. When Meilisearch was unpaused, the indexer drained 500 pending mutations in **0.71 seconds** ($> 700\text{ ops/sec}$).
- **In-Flight Heartbeat Safety:** By invoking `m.InProgress()` during batch accumulation, the indexer prevented NATS from prematurely redelivering messages during prolonged indexing delays, eliminating thundering-herd duplicate indexing.

---

### 1.5 Global Chronological Search vs. Inverted Index BM25 Relevance
By default, full-text search engines (Meilisearch, Elasticsearch, Lucene) rank documents strictly by **lexical relevance** (BM25: term frequency, inverse document frequency, word proximity).
In a team chat context (Discord, Slack), users expect search results within a server to be ranked **strictly globally chronological (newest first)**, with pagination preserving that timeline across pages:
- Under standard ranking rules (`["words", "typo", "proximity", "attribute", "sort", "exactness"]`), relevance matches from years ago jumped to the top of Page 1, breaking chronological continuity.
- In-memory client or server sorting (`sort.Slice`) over a single page produced inconsistent "local-only" ordering where Page 2 had timestamps newer than Page 1.
- The solution was configuring Meilisearch's cluster ranking rules to **sort-first**:
  ```json
  "rankingRules": ["sort", "words", "typo", "proximity", "attribute", "exactness"]
  ```
  Combined with `sort: ["timestamp:desc"]`, this guaranteed that search results are ordered by absolute timestamp globally across all pages before relevance tie-breakers are evaluated.

---

## 2. What Discord Did Differently

### 2.1 Cassandra to ScyllaDB Migration (The Garbage Collection Divide)
Discord originally stored messages in a multi-node Apache Cassandra cluster running on the JVM. In their 2022 engineering retrospective (*"How Discord Stores Trillions of Messages"*):
- **Cassandra's JVM GC Cliff:** As message volume reached hundreds of billions of rows, unpredictable Stop-The-World JVM Garbage Collection pauses caused severe latency spikes (p99 reads escalating from 5ms to over 1,000ms+), requiring complex proactive replica restarts.
- **ScyllaDB's Seastar Architecture:** Discord migrated trillions of messages from Cassandra to ScyllaDB. Written in C++, ScyllaDB utilizes the **Seastar thread-per-core asynchronous execution framework**. Each CPU core manages its own memory, network queues, and NVMe disk access with zero lock contention and zero GC pauses. This stabilized Discord's p99 read latency from seconds down to single-digit milliseconds.
- *Kith's Alignment:* Kith bypassed Cassandra entirely, implementing native ScyllaDB 6.2 with `gocql` driver connection pooling and Time Window Compaction Strategy.

---

### 2.2 Rust Read-States & Message Microservice
At Discord's scale of 200M+ users:
- The message path was removed from the monolithic Python API and encapsulated in an independent **Rust microservice** (*"Message Service"*).
- Discord maintains an in-memory caching tier in Rust for **read states** (the point up to which a user has read a channel) and hot message caches. Because millions of users open the app simultaneously, caching the latest 50 messages of active channels in RAM avoids distributed database hits on the primary gateway open path.
- *Kith's Approach:* Kith handles message ingestion and search hydration in a compiled Go API with connection-pooled ScyllaDB sessions. Channel access checks are resolved in a single indexed relational round-trip (`requireCanView`), and author metadata is hydrated concurrently across ScyllaDB result sets using `PostgresAuthorHydrator`.

---

### 2.3 Elasticsearch vs. Meilisearch Cluster Management
- **Discord (Elasticsearch):** Discord manages massive multi-cluster Elasticsearch deployments. Messages are routed to dedicated index shards partitioned by `guild_id` clusters. Reindexing and shard allocation require extensive cluster operations, dedicated index lifecycle management (ILM), and custom analyzers for Discord markdown and emoji syntax.
- **Kith (Meilisearch v1.12):** Kith selected Meilisearch for Phase 3. Meilisearch delivers typotolerant, instant search in a lightweight single-binary C++ engine with minimal RAM footprint. Pairing Meilisearch with an asynchronous NATS JetStream batching indexer and read-repair hydration delivered sub-15ms search latencies locally while eliminating Elasticsearch's JVM heap overhead.

---

## 3. What I'd Do Next Time

1. **Adopt ScyllaDB-Only Exclusivity Earlier in the Cycle:**
   Maintaining dual-write logic between PostgreSQL and ScyllaDB required extensive telemetry, shadow diffing, and bidirectional cursor parity. While essential for zero-downtime production migrations, cutting over to `scylla_only` earlier in development would have prevented subtle split-brain inconsistencies between search hydration and database writes.

2. **Implement Bidirectional Pagination (`before` / `after`) from Day One:**
   Starting with backward-only pagination (`before`) meant that forward scrolling ("jump to search hit, then scroll down to present") required retrofitting `ListAfter` across all stores, adding reverse sorting `ORDER BY message_id ASC`, and updating client anchor mechanics. Designing bidirectional cursors upfront simplifies timeline hydration.

3. **Incorporate Frontend Concurrency Locks & Request Pacing Upfront:**
   Under rapid inertial scrolling and continuous search typing, unthrottled browser clients fire dozens of parallel requests, burning API rate limits (`HTTP 429`). Implementing synchronous single-flight locks (`useRef`), settling cooldowns (250ms), search debouncing (450ms), and `AbortController` cancellation prevents network thrashing and improves user experience.

---

## 4. Phase 3 Chaos & Benchmark Evidence

All empirical drills and benchmarks executed during Phase 3 validation:

### 4.1 ScyllaDB Message Write Load Benchmark
- **Specification:** Sustained 1,000 msg/s write throughput over 60 seconds (73,000 total writes) via k6 ([docs/scylla-load-profile.md](../docs/scylla-load-profile.md)).
- **Measured p99 Write Latency:** **5.63ms** (Pass criterion: $< 10.0\text{ms}$).
- **Measured p95 Write Latency:** **3.12ms**.
- **Error Rate:** **0.00% (0 errors across 73,000 writes)**.
- **Resource Footprint:** API CPU $\approx 35\%$, ScyllaDB CPU $\approx 22\%$.

### 4.2 Bucket Boundary Pagination Benchmark
- **Specification:** Verify backward pagination across 100,000 messages spanning 3+ 10-day bucket boundaries ([docs/bucket-pagination-benchmark.md](../docs/bucket-pagination-benchmark.md)).
- **Boundary Traversal:** Seamlessly traversed partition boundaries ($B_0 \to B_1 \to B_2$) without dropping records or triggering out-of-order Snowflake IDs.
- **Query Latency:** Average list latency $< 2.4\text{ms}$ per 50-message page.

### 4.3 Consistency & Tombstone Compaction Drill
- **Specification:** Evaluate `QUORUM` vs `ONE` consistency models and tombstone accumulation ([docs/scylla-consistency.md](../docs/scylla-consistency.md)).
- **Phantom Read Rate at ONE:** Up to 14.2% phantom read rate observed during active partition write bursts when querying lagging replicas at `CONSISTENCY ONE`.
- **Consistency at LOCAL_QUORUM:** 0% phantom reads; linearizable monotonic timeline.
- **Tombstone Profile:** 10,000 deleted messages logged tombstone markers; verified `gc_grace_seconds` safety window and read-repair pruning.

### 4.4 Meilisearch 60-Second Freeze Chaos Drill
- **Specification:** 60.0-second freeze of Meilisearch container under continuous 500-operation write/edit/delete blast ([docs/chaos-phase3.md](../docs/chaos-phase3.md)).
- **Write Availability:** **100.0% (500/500 operations succeeded)**.
- **Mean Time To Drain (MTTD):** **0.71 seconds** post-unpause (Threshold: $< 15.0\text{s}$).
- **Data Integrity:** **0 missing documents, 0 content drift, 0 lingering tombstones** verified via automated reconciliation scan.

---

## 5. Phase 3 Gate Checklist Sign-off

All milestone acceptance criteria from `plan/03-message-store.md` §10, `plan/04-search.md` §5, and `plan/11-roadmap.md` are satisfied and signed off:

### Message Storage Gates (`plan/03-message-store.md` §10)
- [x] **Latest-50 and paginate-back work across bucket boundaries:** Tested with 100k messages spanning 3+ 10-day bucket partitions; zero lost messages, strict monotonic ordering ([docs/bucket-pagination-benchmark.md](../docs/bucket-pagination-benchmark.md)).
- [x] **Edit window enforced (15 min), edits stored and served:** Enforced in `service.go` (`ErrEditWindowOver`), verified with unit/integration tests in `service_test.go`, edits stored in ScyllaDB `list<text>` and broadcast via `MESSAGE_UPDATE`.
- [x] **Tombstone discipline documented:** 10k messages deleted, `nodetool compactionstats` analyzed, tombstone read amplification and `gc_grace_seconds` documented in [docs/scylla-consistency.md](../docs/scylla-consistency.md) §4 & §5.
- [x] **QUORUM vs ONE phantom-read experiment written up:** Documented empirical consistency trade-offs in [docs/scylla-consistency.md](../docs/scylla-consistency.md) §1 & §2.
- [x] **Dual-write migration executed, shadow-diff = 0 mismatches, flag flipped:** Verified in [docs/dual-write-scylla-report.md](../docs/dual-write-scylla-report.md); `MESSAGES_STORE_MODE` flipped to `scylla_only` in `compose.yml`.
- [x] **p99 message write < 10ms under 1k msg/s (k6):** Measured p99 = **5.63ms** under sustained 1,000 msg/s write load on local hardware ([docs/scylla-load-profile.md](../docs/scylla-load-profile.md)).

### Search Gates (`plan/04-search.md` §5)
- [x] **Indexer survives kill/freeze drills with zero loss:** 60-second freeze drill verified with zero lost docs and 0.71s drain time via automated reconciliation ([docs/chaos-phase3.md](../docs/chaos-phase3.md)).
- [x] **Search p99 < 150ms:** Meilisearch queries execute in $< 15\text{ms}$ locally, backed by sort-first ranking rules and ScyllaDB read-repair hydration.
- [x] **Delete-from-index test green:** Verified in `indexer_test.go` (`TestIndexer_DeleteHandling`) and chaos drill; `MESSAGE_DELETE` purges documents from the index without tombstones resurrecting.
- [x] **Consumer lag dashboard monitored during freeze:** Prometheus metric `search_indexer_nats_consumer_lag` verified tracking in-flight events during downstream freeze.

---

*Phase 3 is officially complete. Kith is ready for Phase 4: Roles & Permissions.*
