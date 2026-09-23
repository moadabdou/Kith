# Capacity Table (seeded by #85, extended by #88)

Measured knees, not vibes (plan/09 §2, §6). Each row: topology, load,
measured result, date. Gate targets in **bold**; misses are recorded
honestly with the suspected blocker.

## Row 1 — 2× API behind Caddy (Issue #85, 2026-09-23)

- Topology: `api` (node 1, indexer on) + `api-2` (node 2, indexer off),
  Caddy round-robin on `/api/*`, Redis-backed global rate limit,
  Scylla single node @ ONE, full stack co-located (8 cores / 7 GB box,
  load avg ~13 under test).
- Load: `scripts/bench/messages_write_load.js`, 1000 msg/s target,
  1000 users × 50 channels, via `http://127.0.0.1:80`.
- Result:
  - Error rate 0.00% (5/72744); rate-limit 429s ≈ 0 (shared budget holds).
  - Latency avg 27.9ms, med 15.8ms, p90 58.9ms, p95 96.7ms.
  - Sustained arrival capped ~855/s (dropped iterations; target 1000/s unmet).
  - **Gate p99 < 10ms @ 1000 msg/s: MISSED (environmental).**
- Bisection (same box, short runs):
  - Single replica direct: med 6.5ms, p95 73ms — also misses; not an LB artifact.
  - Sequential single-client writes via LB: med ~4–5ms — per-request path healthy.
  - Indexer off: med 15.8ms → 4.4ms, p95 97ms → 51ms (Meili was at 96% CPU).
  - Gateway stopped: avg 27.9ms → 7.7ms, med 15.8ms → 5.2ms, p95 97ms → 22ms.
  - Conclusion: tail comes from co-located consumers (gateway NATS fan-out
    path, search indexer + Meilisearch) + box oversubscription, not the
    API replicas. Re-run on bigger iron or with consumers isolated before
    trusting multi-node numbers (#88).
- xN correctness (same run window):
  - Same JWT → 200 on both replicas.
  - 8 alternating POSTs, one bucket: exactly 5×201 then 429s (global budget).
  - Snowflake nodes: api-1 → node 1, api-2 → node 2, zero collisions.
  - Caddy split verified ~50/50 per-instance counters (after force-recreate;
    note: `up -d` alone did not reload the edited Caddyfile).

## Rows to come (#88)

- Single-node knees per tier (gateway FD/memory, SFU pps) before trusting xN.
- 1M-user paper plan, each line checked against one measurement here.
