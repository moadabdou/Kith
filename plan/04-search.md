# 04 — Search

> Phase 3 (second half). Search is a *separate system* from the message store —
> learning where to draw that line is the lesson.

## 1. Why not query Scylla for search?

Scylla gives you partition-key lookups and clustering slices. "Messages in
guild X containing 'hello world' by user Y" requires inverted indexes over
billions of rows — that's a different data structure (a search index), with
different consistency, different scaling, different failure modes. Discord runs
Elasticsearch (with pain — see their scaling posts). You'll walk the same road
at your scale.

## 2. The evolution (implement each rung, feel why the next one exists)

### Rung 1: pg_trgm (half a day)
```sql
-- Phase 0-2 stop-gap, on the PG messages table
CREATE EXTENSION pg_trgm;
CREATE INDEX msg_trgm ON messages USING gin (content gin_trgm_ops);
SELECT ... WHERE channel_id = ? AND content ILIKE '%term%';
```
Feels magical at 1M rows. Falls over at ~50M (index size, seq-scan fallbacks).
Measure the cliff with `EXPLAIN ANALYZE` — that measurement is the lesson.

### Rung 2: Meilisearch (the pragmatic choice — default path)
- Single binary, great defaults, typo tolerance out of the box. Realistically
  the right tool for a learning build.
- Index design: one index per... decide! Options:
  - per-guild index (Discord's shape — index isolation, but 100M indexes is
    its own ops problem at their scale)
  - single index with `guild_id` filter (simpler; fine for you)
  - You do: single index + filterable attributes. Then write 3 paragraphs on
    when per-guild indexes would win (multi-tenancy blast radius, shard sizing).
- Document shape:
  ```json
  {"id": "message_id", "guildId": ..., "channelId": ..., "authorId": ...,
   "content": "...", "timestamp": ..., "attachments": ["...", ...]}
  ```

### Rung 3 (stretch): OpenSearch
Only if you want the ops pain as curriculum: 3-node cluster, shard sizing,
`refresh_interval` tuning, watching JVM heap. Map it to Discord's ES posts
(they run huge ES clusters and it's one of their hardest systems).

## 3. The indexer pipeline (the real distributed-systems content)

The hard part is not the index — it's keeping it eventually consistent with
Scylla without losing writes:

```
Scylla write → (after commit) publish MESSAGE_INDEX event
   → Indexer service consumes
     → dedup by message_id (at-least-once means duplicates; make idempotent:
       upsert by document id — search docs are idempotent by design ✓)
     → batch to Meilisearch (100ms flush window; learn batching as throughput)
```

Failure drills (run them, don't just read them):
- Kill the indexer mid-batch → restart → verify zero lost docs (JetStream
  redelivery + idempotent upserts = your safety net)
- Freeze Meilisearch for 60s → consumer lag grows → unfreeze → drains. Watch
  the consumer lag metric the whole time. This graph is the whole lesson.
- Deletes: `MESSAGE_DELETE` must also delete the doc. Miss this and search
  shows deleted messages — classic eventual-consistency bug. Test it
  explicitly.

Reconciliation job (required): a nightly scan comparing a sample of Scylla
rows vs index docs; alert on mismatch. Every eventually-consistent system needs
a reconciliation story — write one even if it's 50 lines.

## 4. Query API

```
GET /guilds/:id/messages/search?q=term+term&author_id=&channel_id=
  &before=&after=&sort=timestamp:desc   (Discord-compatible-ish)
```
- AND semantics by default, quote phrases, `from:user` / `in:#channel` filters
  (parse to Meilisearch filter expressions)
- Pagination via cursor (search-hits token), same envelope as message pagination
- Rate limit hard (search is expensive): 1/s per user
- Timeout: 500ms budget, fail with a retryable error code, never let a slow
  index eat API workers (context deadlines everywhere in Go)

## 5. Phase 3 gate

- [ ] Indexer survives kill/freeze drills with zero loss (verified by reconciliation)
- [ ] Search p99 < 150ms on 10M docs
- [ ] Delete-from-index test green
- [ ] Consumer lag dashboard exists and was stared at during a freeze drill
