# Phase 0 Postmortem: Foundations

## 1. What surprised me
- **Snowflake clock mechanics**: Monotonicity is trickier than it looks. Protecting against NTP clock rollback (sleeping or erroring if time moves backward) and handling millisecond sequence rollover (busy-waiting for the next tick) are essential to prevent duplicate keys across distributed nodes.
- **Chaos stampede without backoff**: In our Phase 0 chaos experiment ([Issue #13](https://github.com/moadabdou/Kith/issues/13)), killing the API container mid-loop caused both polling clients to continuously hammer Caddy with HTTP 502s every 2 seconds. A naive fixed polling interval creates an unmitigated thundering herd during outages; exponential backoff and jitter are mandatory from day one of any polling or reconnection logic.
- **Fast Go API recovery**: The compiled Go API container came back up, initialized its Postgres connection pool, and served healthy traffic within **332 ms** of `docker start`. The clients healed on their very next scheduled polling tick without requiring a manual page reload.

## 2. What Discord did differently
- **Postgres as a temporary stop-gap**: In Phase 0, we store messages in Postgres (`messages` table). Discord initially used MongoDB, migrated to Cassandra (2015), and eventually rewritten in Rust on ScyllaDB (2023) because relational indexes collapse under trillions of immutable messages. Our Phase 0 Postgres schema is intentionally temporary; we will feel the migration pain in Phase 3.
- **Publish-after-commit vs Postgres `LISTEN/NOTIFY`**:
  - We considered Postgres `LISTEN/NOTIFY`, but rejected it: it imposes an 8KB payload ceiling, consumes dedicated database connections per listener, and couples pub/sub throughput to Postgres connection pools.
  - Instead, the Go API uses `events.Publish("MESSAGE_CREATE", payload)` *after* the database transaction commits. This prevents "phantom events" (clients seeing a message whose database transaction subsequently aborted).
  - We intentionally don't over-engineer this event seam in Phase 0 (no complex transactional outbox): messages are consumed via 2-second polling anyway, and the hot write path will move to ScyllaDB + Elixir in Phase 3.
- **Stateless 15-minute JWTs with rotating refresh tokens**: Discord uses short-lived tokens backed by Elixir gateway session state. Kith uses stateless 15-minute JWT access tokens coupled with single-use rotating refresh tokens stored in Postgres `sessions`.

## 3. What I'd do next time
- **Client backoff & jitter**: Never ship a client polling loop without exponential backoff (e.g. 2s &rarr; 4s &rarr; 8s &rarr; max 30s) and random jitter on error responses to avoid self-inflicted DDoS on degraded backends.
- **Embed metrics middleware first**: Adding Prometheus instrumentation (`api_http_requests_total`, `api_http_request_duration_seconds`) early proved invaluable; every new service should start with a metrics middleware on day zero.

## 4. Phase 0 Chaos Evidence (Issue #13)
- **Target**: `kith-api-1` killed mid-loop via `docker kill` with two active polling clients.
- **Outage Surface**: Caddy reverse proxy surfaced `HTTP 502 Bad Gateway` to polling clients; message creation was blocked with `HTTP 502`.
- **Recovery Latency**: `docker start kith-api-1` &rarr; healthy in **332 ms**. Both clients resumed `HTTP 200 OK` on the subsequent poll tick without user intervention.

---

## 5. Phase 0 Gate Checklist Sign-off

- [x] **`scripts/smoke.sh` passes** ([Issue #12](https://github.com/moadabdou/Kith/issues/12)): Full register &rarr; login &rarr; guild &rarr; channel &rarr; send &rarr; read-back sequence verified end-to-end.
- [x] **Prometheus & Grafana dashboard live** ([Issue #10](https://github.com/moadabdou/Kith/issues/10)): Prometheus scrapes `api:8080/metrics` and `gateway:4000/metrics`; Grafana dashboard visualizes request rates, p99 latencies, and BEAM VM memory/processes.
- [x] **Snowflake IDs sortable + bit-layout tests pass** ([Issue #3](https://github.com/moadabdou/Kith/issues/3)): Epoch 2026, 41-bit time, 10-bit node, 12-bit sequence, monotonic ordering, and rollover verified.
- [x] **Rate-limit headers on POST /messages** ([Issue #7](https://github.com/moadabdou/Kith/issues/7)): In-memory token bucket returning `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`, `X-RateLimit-Bucket`, and `429 Too Many Requests`.
- [x] **React Client** ([Issue #11](https://github.com/moadabdou/Kith/issues/11)): Discord dark-theme 3-column layout with 2-second message polling, invite creation, and server joining.
