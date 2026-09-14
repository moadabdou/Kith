# Search Architecture Evolution: Rung 1 — PostgreSQL pg_trgm Baseline & Index Cliff Benchmark

**Phase 3 Milestone: Search Subsystem Evolution (`plan/04-search.md` §1–§2)**  
*Date: September 2026*  
*Target Components: `api/migrations/000003_add_pg_trgm.up.sql`, `api/internal/search`, `scripts/bench/pg_trgm_cliff.sh`*  
*Status: VERIFIED — Empirical Baseline & Index Cliff Profiled across 1,000,000 rows*

---

## 1. Executive Summary & Problem Context

In a distributed real-time messaging architecture like Discord, the primary message store (ScyllaDB / Cassandra) is optimized for high-throughput append-only writes, partition-key lookups (`channel_id`), and reverse-chronological clustering slices (`message_id DESC`). 

However, user queries such as:
> *"Find messages in guild X mentioning 'kubernetes' from user Y before date Z"*

require full-text inverted indexes across millions to billions of rows with multi-dimensional filtering. Relational databases often provide stopgap solutions such as PostgreSQL's `pg_trgm` (trigram) extension with Generalized Inverted Indexes (GIN).

This document captures **Rung 1** of Kith's search subsystem evolution:
1. Implementing a PostgreSQL `pg_trgm` baseline query endpoint (`GET /api/guilds/:id/messages/search`) guarded by strict 500ms context timeouts and 1 req/s per-user rate limiting.
2. Executing empirical benchmarks (`scripts/bench/pg_trgm_cliff.sh`) measuring the **pg_trgm index cliff** across 100,000, 500,000, and 1,000,000 messages.
3. Quantifying storage footprint, write amplification, execution plan shifts (`EXPLAIN (ANALYZE, BUFFERS)`), and detailing why production chat platforms inevitably outgrow relational full-text search.

---

## 2. Rung 1 Implementation

### 2.1 Database Migration (`000003_add_pg_trgm`)

PostgreSQL provides trigram matching via `pg_trgm`. A trigram is a 3-character substring extracted from text (e.g., `"discord"` breaks down into `{"  d", " di", "dis", "isc", "sco", "cor", "ord", "rd "}`).

The migration establishes the extension and GIN index on `messages.content`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
ON messages
USING gin (content gin_trgm_ops);
```

### 2.2 REST Query Path & Guardrails

The search endpoint is exposed at `GET /api/guilds/{id}/messages/search` with the following parameters:
- `q`: Search phrase (minimum 2 characters, parameterized as `content ILIKE '%' || $q || '%'`).
- `channel_id`: Optional channel filter within the guild.
- `author_id`: Optional author filter.
- `before`: Monotonic snowflake ID cursor for backward pagination.
- `limit`: Result limit (default 25, maximum 100).

```
                      HTTP GET /api/guilds/{id}/messages/search?q=term
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │ 1. Auth Middleware (HS256 JWT validation)     │
                    └───────────────────────┬───────────────────────┘
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │ 2. Search Rate Limiter: 1 req/sec per user    │  -> 429 Too Many Requests
                    └───────────────────────┬───────────────────────┘
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │ 3. Guild Membership Verification (SQL)        │  -> 403 Forbidden
                    └───────────────────────┬───────────────────────┘
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │ 4. Search Service with 500ms Context Timeout  │
                    │    SQL: Parameterized ILIKE + GIN trgm Index   │  -> 504 Gateway Timeout
                    └───────────────────────────────────────────────┘
```

#### Why Guardrails Are Mandatory for Rung 1:
1. **Per-User Rate Limiting (1 req/sec)**: Trigram GIN scans are computationally and memory intensive. Unchecked user typing (e.g., search-as-you-type autocomplete) can quickly saturate PostgreSQL CPU cores.
2. **Context Deadline (500ms budget)**: Unindexed wildcard queries or long posting lists can freeze query threads. If a query cannot complete within 500ms, the context cancels the PostgreSQL query, failing fast with a retryable error rather than tying up connection pool workers.

---

## 3. Empirical Benchmark Results

The benchmark harness (`scripts/bench/pg_trgm_cliff.sh` / `make bench-search-cliff`) seeded message datasets in increments up to **1,000,000 rows** in a test channel, measuring table heap footprint, GIN index footprint, write rates, and query plans.

### 3.1 Storage Footprint & Index Amplification

| Dataset Tier | Messages | Heap Table Size | Trigram GIN Index Size | GIN / Heap Ratio | Total Relation Size (All Indexes) | Total Index Overhead |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **100,000** | 13 MB | 19 MB | **1.41x** | 41 MB | **2.15x table size** |
| **Tier 2** | **500,000** | 66 MB | 57 MB | **0.88x** | 164 MB | **1.48x table size** |
| **Tier 3** | **1,000,000** | 131 MB | 103 MB | **0.79x** | 316 MB | **1.41x table size** |

#### Index Breakdown at 1,000,000 Messages:
```
           Object Name           | Type  |  Size   | % of Total
---------------------------------+-------+---------+------------
 messages (Heap Table)           | Table | 131 MB  | 41.5%
 messages_content_trgm_idx (GIN) | Index | 103 MB  | 32.6%
 messages_channel_id_id_idx      | Index |  54 MB  | 17.1%
 messages_pkey (id)              | Index |  22 MB  |  7.0%
 messages_author_id_idx          | Index |   6 MB  |  1.9%
---------------------------------+-------+---------+------------
 Total Indexes Combined          | Index | 185 MB  | 58.5%
 Total Relation On-Disk          | Total | 316 MB  | 100.0%
```

**Key Finding**: The `messages_content_trgm_idx` GIN index alone accounts for **over 55% of all index storage** and rivals the size of the heap table itself. In production environments with hundreds of millions of messages, the search index rapidly exceeds available physical RAM.

---

### 3.2 Query Execution Analysis (`EXPLAIN (ANALYZE, BUFFERS)`)

#### Scenario A: Top-25 Search for Selective Term (`'kubernetes'`)
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT m.id, m.content
FROM messages m
JOIN channels c ON c.id = m.channel_id
WHERE c.guild_id = 99700000000000000 AND m.content ILIKE '%kubernetes%'
ORDER BY m.id DESC LIMIT 25;
```
**Plan**:
```text
Limit  (cost=0.42..933.96 rows=25 width=78) (actual time=0.068..0.396 rows=25 loops=1)
  Buffers: shared hit=12
  ->  Nested Loop  (cost=0.42..46864.12 rows=1255 width=78)
        ->  Index Scan Backward using messages_pkey on messages m
              Filter: (content ~~* '%kubernetes%'::text)
              Rows Removed by Filter: 216
              Buffers: shared hit=10
```
- **Execution Time**: `0.476 ms`
- **Planner Behavior**: Because the query requests `ORDER BY id DESC LIMIT 25` and the term appeared in recent rows, the planner bypassed the GIN index in favor of an `Index Scan Backward` on the primary key, filtering rows inline until 25 matches were found.

---

#### Scenario B: Non-Existent or Historical Rare Term (`'nonexistent_rare_token'`)
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT m.id, m.content
FROM messages m
JOIN channels c ON c.id = m.channel_id
WHERE c.guild_id = 99700000000000000 AND m.content ILIKE '%nonexistent_rare_token%'
ORDER BY m.id DESC LIMIT 25;
```
**Plan**:
```text
Limit  (cost=536.94..536.95 rows=1 width=78) (actual time=3.402..3.405 rows=0 loops=1)
  Buffers: shared hit=38 read=6
  ->  Sort  (cost=536.94..536.95 rows=1 width=78)
        Sort Key: m.id DESC
        ->  Nested Loop  (cost=529.93..536.93 rows=1 width=78)
              ->  Bitmap Heap Scan on messages m  (cost=529.93..533.95 rows=1 width=86)
                    Recheck Cond: (content ~~* '%nonexistent_rare_token%'::text)
                    ->  Bitmap Index Scan on messages_content_trgm_idx  (cost=0.00..529.93 rows=1 width=0)
                          Index Cond: (content ~~* '%nonexistent_rare_token%'::text)
```
- **Execution Time**: `3.662 ms`
- **Planner Behavior**: When the term is not in recent rows, the planner falls back to a `Bitmap Index Scan` on `messages_content_trgm_idx`, scans the GIN posting tree, checks heap pages, and sorts the results in memory.

---

#### Scenario C: Short 2-Character Search (`'hi'`) — The Trigram Index Cliff
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM messages m
JOIN channels c ON c.id = m.channel_id
WHERE c.guild_id = 99700000000000000 AND m.content ILIKE '%hi%';
```
**Plan**:
```text
Finalize Aggregate  (cost=23193.86..23193.87 rows=1 width=8) (actual time=353.276..358.276 rows=1 loops=1)
  Buffers: shared hit=15087 read=1770
  ->  Gather  (cost=23193.64..23193.85 rows=2 width=8)
        Workers Planned: 2
        Workers Launched: 2
        ->  Partial Aggregate
              ->  Parallel Seq Scan on messages m  (cost=0.00..21952.09 rows=85214 width=8)
                    Filter: (content ~~* '%hi%'::text)
                    Rows Removed by Filter: 266682
                    Buffers: shared hit=14955 read=1770
```
- **Execution Time**: **358.455 ms**
- **Buffers Read**: **16,857 buffer pages** (~135 MB read from cache/disk)
- **Planner Behavior**: **Index Abandonment**. Because trigrams require at least 3 characters to extract valid 3-grams, PostgreSQL **completely abandons the GIN index** and executes a brute-force `Parallel Seq Scan` across the entire 1,000,000-row table!

---

#### Scenario D: Aggregation / Total Count (`count(*)`) Over 1M Messages
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM messages m
JOIN channels c ON c.id = m.channel_id
WHERE c.guild_id = 99700000000000000 AND m.content ILIKE '%kubernetes%';
```
**Plan**:
```text
Aggregate  (cost=19041.32..19041.33 rows=1 width=8) (actual time=575.503..575.506 rows=1 loops=1)
  Buffers: shared hit=8569 read=8493 written=5351
  ->  Bitmap Heap Scan on messages m
        Recheck Cond: (content ~~* '%kubernetes%'::text)
        Heap Blocks: exact=16669
        ->  Bitmap Index Scan on messages_content_trgm_idx  (actual time=48.791..48.791 rows=100000 loops=1)
```
- **Execution Time**: **575.767 ms** (Exceeds the 500ms context timeout!)
- **Heap Blocks Touched**: **16,669 blocks**
- **Planner Behavior**: The query must traverse 100,000 entries in the GIN index posting list and fetch 16,669 distinct heap blocks to recheck conditions and join against channels. At 575ms on a warm local cache, this query breaches our 500ms context timeout ceiling.

---

## 4. Why Relational FTS Hits an Architectural Wall

Our empirical measurements reveal four fundamental structural flaws that make `pg_trgm` unviable as a long-term search engine for Discord-scale messaging:

### 4.1 Write Amplification and WAL Volume
In a GIN index, an 80-character message generates 50–75 distinct 3-character trigrams. Each message insert requires updating up to 75 leaf items in the GIN B-tree.
- While raw single-worker insert rates achieved ~15k–19k rows/sec under bulk synthetic generation, sustained concurrent OLTP chat traffic produces immense Write-Ahead Log (WAL) bloat and contention on GIN fastupdate pending lists.
- Vacuuming and maintaining GIN indexes under 24/7 high-write chat workloads leads to catastrophic I/O spikes.

### 4.2 The "Short Token" Seq Scan Cliff
Users regularly search for short words, acronyms, and emojis (e.g., `"ok"`, `"hi"`, `"gg"`, `"pr"`, `"id"`).
- Trigram indexes require strings of length $\ge 3$. 
- Any query with $< 3$ characters causes PostgreSQL to discard the index entirely and execute a sequential table scan.
- On a table with 50M rows, a single user searching for `"ok"` triggers a 10-second table scan, pinning CPU and evicting hot pages from memory.

### 4.3 Buffer Pool Thrashing
In relational architectures, the database buffer pool must be shared between transactional OLTP queries (recent channel history, user profiles, session tokens) and search queries.
- A single GIN bitmap scan touches thousands of random heap pages across the disk.
- When search traffic ramps up, search queries flush recent chat messages and active guild memberships out of the buffer pool, directly degrading primary chat message read/write latencies.

### 4.4 Inability to Shard Across Message Volume
In PostgreSQL, partitioning the `messages` table by `channel_id` or `guild_id` fragments the GIN index into thousands of partition indexes. 
- Cross-channel search within a large guild requires scanning dozens of partition indexes in parallel.
- Cross-guild or global indexing becomes completely infeasible.

---

## 5. Transition to Rung 2: Dedicated Inverted Index (Meilisearch)

To resolve the architectural contradictions of Rung 1, Discord and modern messaging architectures cleanly decouple the search engine from the transactional message store:

```
[ Primary Write Path ]
POST /messages  ──►  ScyllaDB (TWCS, Clustering: message_id DESC)
                           │
                           ▼ (Post-commit event)
                     NATS JetStream: MESSAGE_INDEX
                           │
                           ▼
                    [ Search Worker Pipeline ]
                           │ (Batching window: 100ms)
                           │ (Idempotent upsert by message_id)
                           ▼
                 Meilisearch / Search Cluster
                           │ (RAM-mapped roaring bitmaps, BM25)
                           ▼
[ Query Path ]
GET /search     ──►  Meilisearch (p99 < 15ms, typo tolerance, full multi-tenancy)
```

### Architectural Contrast: Rung 1 vs Rung 2

| Dimension | Rung 1: PostgreSQL `pg_trgm` | Rung 2: Dedicated Search Engine (Meilisearch) |
| :--- | :--- | :--- |
| **Index Structure** | Inverted GIN on relational heap | Tailored Inverted Index + Roaring Bitmaps |
| **Write Impact** | Direct transaction path overhead & WAL bloat | Asynchronous, zero impact on write p99 |
| **Short Query (<3 chars)**| Sequential scan fallback (350ms+ failure) | Sub-millisecond prefix search natively supported |
| **Typo Tolerance** | Levenshtein distance (expensive at query time) | Native Damerau-Levenshtein at query speed |
| **Memory Contention** | Competes with transactional buffer pool | Dedicated process memory & memory-mapped files |
| **Scaling Horizon** | Hits cliff at ~10M–50M rows | Scales horizontally with shard distribution |

---

## 6. Conclusion

Rung 1 successfully provides an immediate, functional baseline search API with robust production safety mechanisms (1 req/s rate limiting, 500ms timeout budget). However, our empirical benchmark across 1,000,000 rows clearly demonstrates the **pg_trgm index cliff**:
1. Index footprint expands to **79%–141% of heap size**.
2. Aggregation and deep scans breach the **500ms timeout limit**.
3. Short tokens trigger **unindexed table scans**.

These empirical results validate why Phase 3 must advance to **Rung 2 (Meilisearch with an asynchronous NATS JetStream ingestion pipeline)**.
