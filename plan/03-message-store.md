# 03 — Message Store (ScyllaDB)

> The "massive data" pillar. Phase 3. You migrate messages out of Postgres into
> a schema designed for trillions of rows, and you learn why Discord walked
> Mongo → Cassandra → ScyllaDB.

## 1. The workload (design from access patterns, always)

Discord's message workload, which you inherit:

- **Writes**: append-only, ~millions/sec at their scale. Never updated (edit =
  15-min window, delete = tombstone). Write your own, read rarely.
- **Reads**: "latest 50 messages of a channel" (99% of reads), then paginate
  *backwards in time* by cursor. Occasionally jump-to-message (search).
- **No secondary index needs at query time** (search is a separate system — 04).
- Hot rows: recent channels. Cold rows: everything older, but must be readable
  forever (infinite scroll back years).

This is *exactly* the LSM/wide-column sweet spot: sequential writes, partition-
key lookups, time-ordered clustering rows. Postgres would die on compaction,
vacuum, and B-tree write amplification long before the data gets interesting —
you'll see a mini version of this when you migrate.

## 2. History lesson (read the posts, then re-derive)

1. **Mongo** (2015): Discord's first store. Fell over at ~100M messages —
   page cache pressure, locks. Blog: "How Discord Stored Billions of Messages".
2. **Cassandra** (2017): 12-node cluster handled billions. But: Java GC pauses,
   repair pain, tombstone issues. Blog: "How Discord Tripled Its Message
   Capacity" (the bucketing post — the schema below is theirs).
3. **ScyllaDB** (2023): C++ rewrite of Cassandra, shard-per-core. No JVM, tick
   scheduling. Talk: "Discord's Migration to ScyllaDB" (5x throughput per node).

You get to skip to the destination, but the migration *you* do (PG → Scylla)
teaches the same lesson at your scale: changing the primary store of a live
system without downtime.

## 3. The schema (Discord's bucketed design — study every column)

```sql
CREATE TABLE messages (
    channel_id    bigint,
    bucket        int,          -- epochDays(channel_id-created) >> 10  (see §4)
    message_id    bigint,       -- snowflake = time-ordered clustering key
    author_id     bigint,
    content       text,
    edits         list<frozen<text>>,  -- or a JSON blob of edit versions
    attachments   list<frozen<text>>,  -- JSON of CDN URLs
    mentions      list<bigint>,
    type          smallint,     -- DEFAULT/REPLY/etc
    reply_to      bigint,       -- nullable
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7};
```

Why each decision:
- **Partition key = (channel_id, bucket)**: a single channel's unbounded history
  would create unbounded partitions (Cassandra's classic killer). Bucketing
  bounds each partition to ~10 days of one channel.
- **Clustering key = message_id DESC**: "latest 50" is a single partition-slice
  read of the first 50 rows — the fastest possible query. Pagination walks the
  clustering order with `WHERE message_id < ?`.
- **TWCS compaction**: time-series data has a beautiful property — old data is
  immutable. TimeWindow windows compact once then never merge again. This is
  *the* compaction strategy for message stores; measure SSTable counts with and
  without it to see why (tombstone + space amplification).
- **Edits as a list, not an UPDATE pattern**: CQL updates are upserts; the list
  append is still an immutable event log semantically. (Discord actually stores
  message edits separately with their own content-snapshot; either is defensible
  — write down your reasoning.)

## 4. Bucket math (derive it yourself, then verify)

```
bucket = ((message_id >> 22) + DISCORD_EPOCH_OFFSET_IN_MS) / (1000 * 60 * 60 * 24 * 10)
       → i.e. days-since-epoch ÷ 10 (Discord: buckets of 10 days)
```
- From a snowflake you can compute its bucket without a DB hit — no bucket
  lookup table needed. Re-derive this from `02-rest-api.md` §4 bit layout.
- Boundary case: a message's *bucket is derived from the channel's creation
  time* in Discord's design (all messages for a channel's period in one
  bucket), not the message's own time. Decide which you mean and why —
  channel-creation buckets mean: as the channel ages, partition count grows
  linearly with channel age, bounded per bucket.

## 5. Query patterns (write these as your acceptance tests)

```sql
-- Latest page
SELECT * FROM messages
WHERE channel_id = ? AND bucket = ?
LIMIT 50;                          -- clustering DESC does the ordering

-- Paginate backwards (cursor = last seen message_id)
SELECT * FROM messages
WHERE channel_id = ? AND bucket = ?
  AND message_id < ? LIMIT 50;

-- Cross-bucket: client walked past a bucket boundary →
SELECT ... WHERE channel_id = ? AND bucket = ?-1 LIMIT 50;   -- API synthesizes this

-- Write
INSERT INTO messages (...) VALUES (...);    -- LWT NOT needed (no read-before-write)

-- Delete
DELETE FROM messages WHERE channel_id=? AND bucket=? AND message_id=?;  -- tombstone!
```

Pagination subtlety to learn the hard way: the API layer must know when a page
runs dry mid-bucket and hop to the previous bucket. Your cursor should be
opaque to clients (base64 of `{message_id, bucket}`).

## 6. Consistency: QUORUM, LWT, and saying no

- Replication: `NetworkTopologyStrategy, DC1: 3` (local 3-node cluster).
- Read/Write at `LOCAL_QUORUM`. Do the exercise: read at `ONE`, kill a node
  mid-write-burst, count the *phantom reads* (write succeeded at QUORUM but a
  stale replica answers a ONE read). That exercise is the whole consistency
  course in one afternoon.
- **Never use LWTs (lightweight transactions) on the hot path.** Paxos round
  trips per message = throughput collapse. The snowflake ID makes writes
  conflict-free (you choose the row key), which is *why* the write path is
  coordination-free. This is a load-bearing design decision — spot where else
  in the system this trick appears. (Answer: everywhere Discord avoids CAS.)
- eventual consistency caveat: a message written at QUORUM may not be
  immediately readable from a lagging replica if you read at ONE. At
  LOCAL_QUORUM reads this is invisible. Why does the gateway event make this
  mostly moot for chat UX? (The client renders the event, not the read-back.)

## 7. The migration itself (dual-write dance)

Migrating a live store without downtime — do it properly in Phase 3:

1. Add Scylla alongside PG. Write path: dual-write (PG then Scylla, PG is truth).
2. Backfill: `SELECT ... WHERE id < cursor ORDER BY id` loop, batched 1k rows,
   computing buckets as you go. Idempotent inserts (same PK) → safe re-runs.
3. Read path behind a feature flag: 1% users → Scylla, compare responses
   (shadow-read diff job), then 100%.
4. Stop PG writes, keep PG readable for a rollback window, then drop the table.
5. Postmortem: what breaks if step 1's two writes diverge? (Answer: you need a
   reconciliation scan; write the query.)

## 8. Local cluster setup (Docker)

```yaml
# docker-compose.scylla.yml (Phase 3; 1 node first, 3 nodes for §6 exercises)
scylla1: image scylladb/scylla --seeds=scylla1 --smp 2 --memory 2G
scylla2: ... --seeds=scylla1
scylla3: ... --seeds=scylla1
```
Tools you must get comfortable with: `cqlsh`, `nodetool` (cfstats, compactionstats,
tablehistograms), Scylla Manager (even locally, for repair), and reading
`SSTable` count graphs in Prometheus. Drivers: `gocql` (Go) — wrap it in
`internal/messages/store.go` so the migration flag flips one code path.

## 9. Capacity thinking (back-of-envelope, do it for YOUR numbers)

- A message ≈ 400 bytes on disk (content + overhead) → 1B messages ≈ 400GB pre-
  compression, ~100–150GB with LZ4 (Scylla default). Say the numbers for your
  target: 100M messages ≈ 15GB → trivially one node. So *your* scale problem
  is throughput and partition layout, not capacity — which is why the load
  tests in Phase 7 matter more than row counts.
- Do the Discord math too: their talks cite trillions of messages, p99 read
  latency ~single-digit ms. Sketch what node count that implies at ~2.5GB/s
  sustained write per node (Scylla's rough per-node ceiling). Order of magnitude
  only — the skill is the estimation habit.

## 10. Phase 3 gates

- [ ] Latest-50 and paginate-back work across bucket boundaries (test with a
      channel seeded 100k messages spanning 3+ buckets)
- [ ] Edit window enforced (15 min), edits stored and served
- [ ] Tombstone discipline: delete 10k messages, run `nodetool compactionstats`,
      explain what you see
- [ ] QUORUM vs ONE phantom-read experiment written up (half page)
- [ ] Dual-write migration executed, shadow-diff = 0 mismatches, flag flipped
- [ ] p99 message write < 10ms under 1k msg/s (k6) on your laptop

## 11. Reading

- "How Discord Tripled Its Message Capacity" (bucketing, MUST read before building)
- "Discord's Migration to ScyllaDB" (Scylla Summit talk)
- Scylla U: data modeling + compaction chapters
- `12-references.md` §Phase 3
