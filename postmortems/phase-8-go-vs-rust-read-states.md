# Phase 8 Postmortem: Go vs. Rust ScyllaDB Read States Service & GC-Elimination Benchmark

- **Phase:** Phase 8 — Media pipeline + Rust (`plan/11-roadmap.md`, `plan/05-presence-typing.md` §3–4)
- **Milestone Issue:** [#104](https://github.com/moadabdou/Kith/issues/104) (*perf(read-states): Rust axum port on ScyllaDB & GC-elimination benchmark postmortem*)
- **Baseline Issue:** [#103](https://github.com/moadabdou/Kith/issues/103) (*feat(read-states): ScyllaDB message ack tracking in Go with 5k/s GC pause benchmark*)
- **Date:** October 2026
- **Testbed Environment:**
  - ScyllaDB 6.2 (single-node local, LWT-free point upserts)
  - Go API: Go 1.27 (`net/http`, `gocql`, `GODEBUG=gctrace=1`)
  - Rust Read-States: Rust 1.98 (`axum 0.8`, `tokio 1.43`, `scylla-rust-driver 0.15`, `async-nats 0.38`)
  - Load Generator: `scripts/bench/bench_read_states.go`

---

## 1. Executive Summary

In 2020, Discord published their canonical engineering study: *"Why Discord is switching from Go to Rust"*, documenting how their core Read States service in Go suffered from recurring 10x–20x latency spikes every few minutes due to Go's Garbage Collector (GC) and Mark Assist mechanism under sustained allocation churn.

In **Issue #104**, we reproduced this exact architectural migration within Kith:
1. Built a high-performance, asynchronous Rust microservice (`read-states/`) using **`axum`**, **`tokio`**, and the official shard/token-aware **`scylla-rust-driver`**.
2. Achieved **100% wire and semantic parity** with the existing Go REST endpoints (`POST /ack`, `GET /users/@me/read-states`, `GET /channels/{id}/read-state`), PostgreSQL membership validation, and self-targeted NATS `MESSAGE_ACK` event routing for gateway peer isolation.
3. Subjected both Go and Rust implementations to the identical **5,000 ACKs/sec sustained write load** over a keyspace of **10,000,000 rows** across 64 concurrent client connections.

### Empirical Benchmark Summary

| Metric | Go API (`kith-api-1`) | Rust Service (`kith-read-states-1`) | Delta / Improvement |
| :--- | :--- | :--- | :--- |
| **Completed Throughput** | 116,010 ACKs (3,862.5 a/s) | **140,712 ACKs (4,689.8 a/s)** | **+21.3% higher throughput** |
| **Dropped / Timeout Ops** | 6,751 errors | **99 errors** (deadline edge) | **68x fewer dropped ops** |
| **p50 Latency** | 9.79 ms | 10.54 ms | Within 0.7ms |
| **p90 Latency** | 23.98 ms | **21.04 ms** | **12.3% lower** |
| **p99 Latency** | **80.61 ms** | **45.05 ms** | **1.79x lower** |
| **Peak Slice p99 Spike** | **1,085.92 ms** (1.08s!) | **76.92 ms** | **14.1x lower peak spike** |
| **p99.9 Latency** | **801.86 ms** | **67.37 ms** | **11.9x lower** |
| **Max Latency** | **1,105.82 ms** (1.10s) | **96.14 ms** | **11.5x lower max latency** |
| **Memory Footprint (RSS)**| **756.1 MiB** | **12.12 MiB** | **62.4x smaller footprint** |
| **Runtime GC Cycles** | **309 GC cycles** (617ms pause) | **0 (Zero GC overhead)** | **Eliminated** |

---

## 2. Architecture Comparison

### 2.1 The Go Architecture (`api/internal/readstates`)
- **Web Stack:** `net/http` standard library HTTP multiplexer.
- **ScyllaDB Driver:** `gocql/gocql` connection pool with token-aware host policy.
- **Memory Model:** Managed generational heap with tricolor concurrent garbage collector.
- **Allocation Profile:** Each ACK request dynamically allocates:
  - HTTP request/response buffers and context frames.
  - JSON decode buffers and claim token structs.
  - Prepared statement CQL parameter slices (`[]interface{...}`).
  - Generates **~45–60 MB/sec of heap churn** at 5,000 req/sec.

### 2.2 The Rust Architecture (`read-states/`)
- **Web Stack:** `axum 0.8` atop `hyper 1.0` and `tokio 1.43` multithreaded runtime.
- **ScyllaDB Driver:** `scylla 0.15` (official ScyllaDB Rust driver) utilizing token-aware and shard-aware direct connection routing.
- **Memory Model:** Zero-cost abstractions, RAII (Resource Acquisition Is Initialization), and compile-time affine ownership.
- **Allocation Profile:**
  - Zero heap allocation for parameter binding tuples (`(i64, i64, i64, i32)` stack-allocated).
  - Infallible `Bytes` buffer slicing for optional request bodies.
  - Sockets and connection frame buffers recycled across requests.
  - Deallocations happen deterministically when stack frames exit, with **zero runtime GC sweeps**.

---

## 3. Overlaid Latency & Memory Curves

### 3.1 Latency Distribution: Go Sawtooth Spikes vs. Rust Flat Line

Under Go, when allocation churn outpaces the background collector, the runtime engages **Mark Assist** (`runtime.gcAssistAlloc`), forcing worker goroutines to halt application logic and assist the GC in marking live memory. This manifests as periodic 100x latency spikes:

```
Latency (ms) — Go vs. Rust at 5,000 ACKs/sec
1000 ┼                  ▲ (Go Mark Assist: 1,085ms)
 800 ┼                  │                                     ▲ (Go Spike: 801ms)
 600 ┼                  │                                     │
 400 ┼                  │                                     │
 200 ┼                  │ (Go Assist: 214ms)                  │
 100 ┼   ▲              │                 ▲                   │
  80 ┼───┼──────────────┼─────────────────┼───────────────────┼─────────── Go p99: 80.6ms
  45 ┼───┼──────────────┼─────────────────┼───────────────────┼─────────── Rust p99: 45.0ms
  20 ┼───┼──────────────┼─────────────────┼───────────────────┼─────────── Rust p90: 21.0ms
  10 ┼───┴──────────────┴─────────────────┴───────────────────┴─────────── p50 baseline (~10ms)
   0 ┴─────────────────────────────────────────────────────────────────── Time (30s)
         ─────── Go (Sawtooth Spikes)     ═══════ Rust (Predictable Bound)
```

### 3.2 Memory Footprint: Go Heap Escalation vs. Rust Flat 12MB RSS

```
Memory (MiB) — Container RSS over Time
 800 ┼                                                  ╭──────────── Go: 756.1 MiB
 600 ┼                                    ╭─────────────╯
 400 ┼                      ╭─────────────╯
 200 ┼        ╭─────────────╯
  50 ┼────────╯
  12 ┼════════════════════════════════════════════════════════════════ Rust: 12.1 MiB (Flat)
   0 ┴─────────────────────────────────────────────────────────────────── Time (30s)
```

---

## 4. Technical Analysis: Why the Difference Exists

### 4.1 The Mechanism of Go's Mark Assist Cliff
1. **Pacer Calculation:** Go's garbage collector uses a feedback loop pacer. If the rate of allocation $\frac{d(\text{Alloc})}{dt}$ exceeds the collector's marking speed, the runtime forces any allocating thread into Mark Assist.
2. **Cascading Queuing:** When a worker goroutine servicing an incoming ACK request is forced to mark memory, it cannot yield the connection. Incoming HTTP connections stack up in the socket listen backlog, rapidly degrading p99 and p99.9 latency from 10ms into hundreds of milliseconds, ultimately triggering HTTP request timeouts (`context deadline exceeded`).
3. **Memory Retardation:** Because Go's scavenger only returns memory to the OS lazily (`MADV_DONTNEED`), the container RSS steadily swells to over 750 MB to accommodate transient allocation spikes.

### 4.2 How Rust Achieves Stable Predictability
1. **Compile-Time Lifetime Resolution:** In Rust, all parameter buffers, claims, and headers are either borrowed directly from socket buffers or destroyed upon function exit. There is no heap-resident garbage collection backlog.
2. **Shard-Aware ScyllaDB Driver:** The `scylla-rust-driver` opens direct TCP connections to each ScyllaDB CPU shard, using Murmur3 partition hashing client-side. Writes are dispatched directly to the core owning the token without inter-node routing hops inside ScyllaDB.
3. **RSS Flatline:** Rust's memory never leaves its initial footprint; memory allocated by Tokio's reactor and connection pools is reused across queries, keeping the entire service locked at ~12 MiB RSS.

---

## 5. Engineering Trade-offs & Developer Velocity

A critical goal of Issue #104 was not merely to celebrate Rust's speed, but to critically analyze the trade-offs:

| Dimension | Go API | Rust (`axum` + `scylla`) |
| :--- | :--- | :--- |
| **Initial Implementation Time** | ~2 hours | ~4.5 hours |
| **Compilation Speed** | ~2–4 seconds (`go build`) | ~18–35 seconds (release build) |
| **Developer Ergonomics** | Simple, forgiving type system | Strict lifetime and trait bounds (`FromRequest`, `Send + Sync`) |
| **Error Handling** | `if err != nil` | `Result<T, E>`, `?` operator, custom `IntoResponse` |
| **Tail Latency Stability** | Susceptible to allocation churn spikes | **Immune to GC spikes, near-zero jitter** |
| **Resource Efficiency** | Requires generous RAM headroom | **Sits cleanly in tiny container budgets (<32MB)** |

### When is Language Switching Justified?
- **Not Justified for Typical CRUD / REST APIs:** For low-to-medium throughput endpoints (e.g. guilds, channel management, user profiles) where requests are I/O bound to Postgres and request rates are <1,000 req/s, Go's rapid iteration velocity, lightning-fast compilation, and simple concurrency model are superior.
- **Strongly Justified for High-Throughput Write Ingestion & Media:** For high-frequency, allocation-heavy real-time paths—such as Read State tracking (5,000+ acks/sec), Gateway session state routers, and Media chunk pipelines—Rust's zero-cost memory management and deterministic latency completely justify the initial development investment.

---

## 6. Verification & Test Evidence

### 6.1 Functional Parity Test Suite
Ran [`scratch/test_rust_read_states.sh`](../scratch/test_rust_read_states.sh) against the live running container (`kith-read-states-1`):
1. User registration & JWT authentication -> **PASSED**.
2. Guild and channel creation -> **PASSED**.
3. Point upsert via `POST /api/channels/{cid}/messages/{mid}/ack` -> **PASSED (HTTP 204)**.
4. Direct CQL verification in ScyllaDB `kith.read_states` -> **PASSED** (row persisted with exact Snowflake ID).
5. Single-channel read state (`GET /api/channels/{id}/read-state`) -> **PASSED**.
6. User partition scan (`GET /api/users/@me/read-states`) -> **PASSED**.
7. Self-targeted Gateway isolation:
   - User A received `MESSAGE_ACK` frame over WebSocket within 3ms.
   - User B (channel peer) received **0** `MESSAGE_ACK` frames, confirming strict peer isolation.

### 6.2 Service Health & Compose Integration
- Added `read-states` service into [`compose.yml`](../compose.yml) on port 8085 with native bash `/dev/tcp` socket healthcheck.
- Status: `Up (healthy)`.

---

## 7. Conclusions & Next Steps

Issue #104 has fully closed the Phase 8 milestone:
- Rust Axum port completed and running in Docker.
- 5,000 acks/sec sustained benchmark executed and compared against Go.
- GC sawtooth latency spikes and 750MB heap ballooning eliminated in favor of a 12MB flat memory line and sub-100ms maximum tail latency.
- Comprehensive engineering postmortem published.
