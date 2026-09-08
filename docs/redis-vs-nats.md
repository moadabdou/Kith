# Event Bus Architecture: Redis Streams vs. NATS JetStream

## 1. Overview and Context

In Kith, the event bus decouples the Go REST API (where state transitions and PostgreSQL transactions commit) from the Elixir Gateway cluster (where WebSocket client sessions and Guild Actors reside).

To evaluate messaging infrastructure objectively rather than speculatively, Kith implements the bus behind a uniform interface seam:
- **API Publisher Seam:** `events.Publisher` interface in `api/internal/events/events.go`.
- **Gateway Consumer Seam:** Config-toggled GenServer (`Gateway.Bus.NatsConsumer` vs. `Gateway.Bus.Consumer`).
- **Configuration Toggle:** Swapped via `EVENTS_BUS=nats|redis` in API and `BUS_TYPE=nats|redis` in Gateway with zero application call-site modifications.

Both backends were deployed, tested, and empirically benchmarked under identical end-to-end workloads consisting of HTTP POST requests, PostgreSQL commits, bus publishing, consumer dispatch, Guild Actor routing, and final WebSocket frame delivery.

---

## 2. Empirical Benchmark Measurements

Tests measured end-to-end latency: from HTTP request initiation through PostgreSQL transaction commit, bus publication, consumer ingestion, Guild Actor dispatch, and final WebSocket client frame delivery.

| Metric | NATS JetStream (`BUS_TYPE=nats`) | Redis Streams (`BUS_TYPE=redis`) | Delta / Notes |
| :--- | :--- | :--- | :--- |
| **Delivery Success Rate** | 30 / 30 (100%) | 29 / 30 (96.7%)* | *1 delayed due to discovery polling interval |
| **Total Wall Clock Duration** | 338 ms | 1,350 ms | NATS was ~4x faster in overall completion |
| **End-to-End Latency (p50 / Median)** | 9.0 ms | 8.0 ms | Parity for established stream channels |
| **End-to-End Latency (p95)** | 11.0 ms | 13.0 ms | NATS maintains narrower tail latency |
| **End-to-End Latency (p99)** | 17.0 ms | 15.0 ms | Equivalent under low-concurrency single-thread load |
| **Min End-to-End Latency** | 6.0 ms | 6.0 ms | Bounded by DB commit + local socket loopback |
| **Max End-to-End Latency** | 17.0 ms | 15.0 ms | Low jitter on both systems |

### Key Observation on Wall Clock Discrepancy
While individual message transit latency for active streams is nearly identical (8-9ms, which is dominated by PostgreSQL fsync and HTTP/JSON processing), the **total wall clock completion** was dramatically different: **338ms for NATS vs. 1,350ms for Redis**.

This divergence stems directly from their ingestion architectures:
- **NATS JetStream:** Messages published to `kith.events.{guild_id}` are immediately matched by the stream wildcard `kith.events.>` and pushed over an active subscription directly into the Elixir GenServer mailbox.
- **Redis Streams:** The gateway consumer polls Redis using `SCAN` to discover newly active `kith:events:*` keys, creates consumer groups via `XGROUP CREATE`, and then issues `XREADGROUP`. This polling loop introduces inherent scheduling delay when new guilds or channels emit events.

---

## 3. Routing and Partitioning Topology

### Redis Streams: Multi-Key Partitioning
- **Key Schema:** `kith:events:{guild_id}`
- **Consumer Mechanism:** Gateway must run a periodic `SCAN` (or maintain a separate guild registry key) to detect active guild streams, followed by multi-stream `XREADGROUP`.
- **Scaling Limit:** Redis struggles as the number of keys in `XREADGROUP` grows beyond a few hundred per command. For 100,000 active guilds, a single consumer cannot block on 100,000 streams simultaneously without complex client-side sharding or hash-ring partitioning across Elixir worker pools.

### NATS JetStream: Subject Hierarchy
- **Subject Schema:** `kith.events.{guild_id}`
- **Stream Definition:** A single stream (`KITH_EVENTS`) with wildcard filter `kith.events.>`.
- **Consumer Mechanism:** Gateway registers a single durable push consumer (`kith-gateway`) with `deliver_subject: kith.gateway.inbox`.
- **Scaling Advantage:** NATS handles millions of distinct subjects under subject hierarchies without creating separate physical queues or streams. Routing is handled entirely inside the NATS server radix tree in C/Go memory.

---

## 4. Delivery Guarantees and Acknowledgment Semantics

Both implementations provide **at-least-once** delivery guarantees.

### Redis Streams Acknowledgment
- Consumer reads entries via `XREADGROUP`. Unacknowledged entries reside in the Pending Entries List (PEL).
- Consumer must issue an explicit `XACK kith:events:{guild_id} kith-gateway {entry_id}`.
- Lag monitoring requires periodic `XPENDING` calls across all known stream keys.

### NATS JetStream Acknowledgment
- Each pushed message carries an explicit JetStream reply subject in its envelope:
  `$JS.ACK.<stream>.<consumer>.<delivered_count>.<stream_seq>.<consumer_seq>.<timestamp>.<pending>`
- Gateway consumer acknowledges by publishing `+ACK` to this reply subject.
- **Built-in Redelivery Detection:** Token index 4 (`delivered_count`) immediately informs the consumer whether this message is a redelivery (`delivered_count > 1`) without needing out-of-band state lookups.
- **Built-in Lag Telemetry:** Token index 8 (`pending`) gives the exact remaining consumer backlog on every delivered frame, enabling zero-cost Prometheus lag metric updates.

---

## 5. Failure Modes and Crash Recovery

### Consumer Crash Mid-Batch
- **Redis:** On consumer reboot, the consumer queries `XREADGROUP` with ID `0` to drain its own PEL before consuming `>`. If a consumer ID changes (e.g. dynamic container hostname), unacknowledged messages remain stuck in PEL until another process calls `XAUTOCLAIM` with an idle-time threshold.
- **NATS JetStream:** If a consumer crashes or fails to acknowledge within `ack_wait` (default: 30 seconds), NATS automatically redelivers the unacknowledged messages to any available active worker subscribed to the consumer's delivery group.

### Poison Pill Handling
- Both implementations intercept JSON decode errors. Instead of dropping the connection or looping indefinitely, corrupt envelopes are acknowledged (`+ACK` or `+TERM`) and logged to prevent queue head-of-line blocking.

---

## 6. Operational Footprint and Simplicity

| Aspect | Redis 7 | NATS 2.10 (JetStream) |
| :--- | :--- | :--- |
| **Runtime Model** | Single-threaded event loop, in-memory with periodic RDB/AOF persistence | Multi-threaded Go binary, memory or append-only file storage per stream |
| **Memory Footprint** | ~30MB base, increases per stream key and PEL tracking | ~25MB base, fixed stream state overhead |
| **Protocol** | RESP text/binary protocol (request/response) | NATS text/binary framing (pipelined push/pubsub) |
| **Clustering** | Redis Cluster requires hash slots and cross-slot multi-key restrictions | NATS clustering with RAFT-based JetStream meta-groups is native and transparent |
| **Wildcard Routing** | Pub/Sub supports patterns (`PSUBSCRIBE`), but Streams do not natively allow wildcard `XREADGROUP` across multiple stream keys | Streams natively support subject wildcards (`kith.events.>`) |

---

## 7. Architectural Conclusion

Redis Streams proved to be a reliable and straightforward starting point for Phase 1 development. However, for a Discord-scale architecture with tens of thousands of active guilds:
1. **Dynamic Subject Routing:** NATS JetStream subject hierarchy (`kith.events.{guild_id}`) eliminates the Redis key-discovery and multi-stream polling bottleneck entirely.
2. **Push Delivery vs. Polling:** JetStream pushes matching messages directly over an existing multiplexed TCP connection, yielding lower jitter and higher throughput.
3. **Telemetry & Resilience:** Inline redelivery counters and lag metrics in JetStream reply tokens remove the need for periodic out-of-band monitoring polling.

**Decision:**
- **Default Bus:** NATS JetStream is configured as the default bus across all development and production environments (`EVENTS_BUS=nats`, `BUS_TYPE=nats`).
- **Seam Retention:** The Redis Streams implementation remains maintained and fully runnable for environments where running an external NATS broker is not desired.
