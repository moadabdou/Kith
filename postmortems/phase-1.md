# Phase 1 Postmortem: Gateway & Realtime Core

- **Phase:** Phase 1 — Gateway & Realtime Core (`plan/11-roadmap.md`)
- **Execution Period:** Week 3–5
- **Closing Milestone Issue:** #28

---

## 1. What Surprised Me

- **The Memory-Only Replay Buffer Pain:**
  Keeping each session's sequence ring buffer in the heap memory of its isolated `Gateway.Session` GenServer delivers microsecond replay times (~1–2µs per message) during normal reconnections. However, this architecture tightly couples session survivability to host container uptime. During our `SIGKILL` chaos drill ([Issue #27](https://github.com/moadabdou/Kith/issues/27)), abruptly killing the gateway container vaporized all active session actors. Upon restart, clients attempting Opcode 6 `RESUME` were rejected with Opcode 9 (`INVALID_SESSION: false`). While our client gracefully falls back to Opcode 2 `IDENTIFY` and reconciles history via REST, surviving gateway restarts without message resync would require an externalized or shared state tier (e.g., Redis or distributed ETS).

- **WebSocket Close Code Semantics (The 4009 Trap):**
  Distinguishing between *transport connection death* and *session actor death* is subtle. We initially categorized close code `4009` (*Session timed out* / missed heartbeats) as fatal alongside `4004` (*Authentication failed*), terminating the underlying `Gateway.Session` GenServer on TCP close. This broke 30-second disconnect recovery because server-side zombie detection killed the session before the client could reconnect. In reality, `4009` merely closes the stale TCP socket; the session actor must survive for the full `disconnect_ttl_ms` (60 seconds) to service subsequent `RESUME` requests. Removing `4009` from the fatal list immediately stabilized transient reconnects.

- **Naive Fan-Out Mailbox Starvation:**
  Our micro-benchmark ([Issue #23](https://github.com/moadabdou/Kith/issues/23)) revealed how quickly a single coordinator GenServer turns into an inescapable $O(N)$ bottleneck. Iterating through 10,000 connection PIDs sequentially in one process starved 7 of 8 CPU cores (scheduler utilization stalled at ~16.7%), while subsequent broadcasts piled up in the coordinator's mailbox. Partitioning subscribers into independent `Gateway.GuildActor` processes distributed the workload across all 8 BEAM schedulers (98–99.5% core saturation), yielding a 2.93x speedup and 4.75 Million deliveries/sec.

- **NATS Wildcard Radix Trees vs. Redis Multi-Stream Polling:**
  Our empirical comparison ([Issue #24](https://github.com/moadabdou/Kith/issues/24), [`docs/redis-vs-nats.md`](../docs/redis-vs-nats.md)) demonstrated that while individual message transit latencies are near-identical (~8–9ms, dominated by PostgreSQL `fsync`), total wall-clock drain was 4x faster on NATS JetStream (338ms vs. 1,350ms on Redis). Redis Streams requires consumer-side stream discovery (`SCAN`) and multi-key `XREADGROUP` management, whereas NATS push subscriptions match hierarchical subjects (`kith.events.>`) natively in server memory with zero client-side polling delay.

---

## 2. What Discord Did Differently

- **Bandit (2026) vs. Discord's Cowboy-Era War Stories:**
  Discord built their original gateway in 2015 on Cowboy (Erlang). Their engineering blogs detailed extensive battles with Cowboy 1.x connection state machines, protocol leakages, and manual supervision boilerplate to manage millions of concurrent sockets.
  In 2026, building on Elixir with **Bandit** and **WebSockAdapter** is a vastly superior developer experience. Bandit is a pure-Elixir HTTP/WebSocket server built atop Thousand Island socket pools. It adheres strictly to modern RFC specifications and models each incoming WebSocket connection as an isolated GenServer process, eliminating Cowboy's historical impedance mismatch with standard OTP supervision trees.

- **Cross-Node Distribution & Manifold:**
  Discord developed **Manifold** to solve inter-node distribution saturation. When a message is sent to a 5-million-member guild (e.g., Midjourney), broadcasting from the publishing node to thousands of remote gateway nodes would saturate the Erlang cluster network if sent as individual PID messages. Manifold solves this by sending exactly **one** copy of the payload to each remote Erlang node, where a local worker process unpacks and distributes it locally.
  *Is Manifold relevant at our scale?* Not in Phase 1. Kith currently runs as an independent gateway node receiving messages from NATS JetStream. Within a single BEAM node, message passing between local processes uses pointer references for large binaries (payloads $> 64$ bytes are refc binaries in shared heap), incurring zero serialization cost. Manifold only becomes necessary once Kith clusters multiple distributed BEAM nodes together across a private network mesh (Phase 4).

- **Session Resume Architecture:**
  Discord offloads session metadata to dedicated caching tiers and distributed session managers to allow seamless `RESUME` even when a client reconnects to a different physical gateway machine behind a load balancer. Kith's Phase 1 uses node-local process memory; a client reconnecting after a container crash or to an alternative node receives `INVALID_SESSION` and performs REST state reconciliation.

---

## 3. What I'd Do Next Time

1. **Model Connection State Machines with Explicit Close Code Tables:**
   Formulate a formal matrix of WebSocket close codes (`1000`, `4000`–`4009`), mapping each to its exact actor lifecycle effect (e.g., `terminate_socket_only` vs. `terminate_session_actor`) *prior* to writing handler callbacks.
2. **Standardize on NATS Subject Hierarchies from Day Zero:**
   Avoid building multi-key stream discovery in Redis for multi-tenant entity events. NATS JetStream subject filtering (`kith.events.{guild_id}`) provides cleaner operational boundaries and superior push performance.
3. **Embed Reconnection Jitter into Frontend SDKs Earlier:**
   Prevent thundering herds by enforcing randomized exponential backoff and connection status banners in UI client libraries during the initial WebSocket integration step, rather than retrofitting them later.

---

## 4. Phase 1 Chaos Evidence (Issue #27)

Automated end-to-end chaos drills executed via [`scripts/chaos/phase1_gateway_chaos.js`](../scripts/chaos/phase1_gateway_chaos.js) and documented in [`docs/chaos-phase1.md`](../docs/chaos-phase1.md):

- **Target:** `kith-gateway-1` under transient network disconnects, container `SIGKILL`, and session TTL reaper boundaries.
- **Drill 1 (Transient Drops: 5s and 30s):**
  - Opcode 6 `RESUME` replayed all queued messages seamlessly.
  - **Invariants Verified:** Completeness ($8/8$ messages received, 0 lost), Idempotency (0 duplicates), Monotonicity (sequences strictly $1 \to 8$).
- **Drill 2 (Hard `SIGKILL` & Tier Isolation):**
  - Gateway container terminated with `docker kill -s SIGKILL`.
  - Go REST API and PostgreSQL remained 100% available, accepting writes (HTTP 201 Created).
  - On restart, gateway returned Opcode 9 (`INVALID_SESSION: false`).
  - Client fell back to Opcode 2 `IDENTIFY` and reconciled history via REST API backfill, achieving eventual consistency with zero total message loss ($11/11$ messages accounted for).
- **Drill 3 (Session TTL Expiration: 65s > 60s):**
  - Disconnected client waited 65 seconds.
  - GenServer reaper cleanly evicted the session actor, returning Opcode 9 on late `RESUME` attempt and proving zero memory leaks.

---

## 5. Phase 1 Gate Checklist Sign-off

All milestone acceptance criteria from `phase1-milestone.md` are satisfied:

- [x] **Client replaced polling with WS; message send &rarr; render < 100ms locally** ([Issue #25](https://github.com/moadabdou/Kith/issues/25)): React client uses persistent WebSocket connection; message sends render immediately via `MESSAGE_CREATE` gateway dispatch in ~6–9ms.
- [x] **RESUME replays gaps correctly** ([Issue #26](https://github.com/moadabdou/Kith/issues/26), [Issue #27](https://github.com/moadabdou/Kith/issues/27)): Verified across 5s and 30s disconnects with zero message loss and zero duplicates; 65s disconnect (> 60s TTL) yields `INVALID_SESSION` rather than stream corruption.
- [x] **Heartbeats + zombie close (4009) verified** ([Issue #21](https://github.com/moadabdou/Kith/issues/21), [Issue #27](https://github.com/moadabdou/Kith/issues/27)): Opcode 1/11 heartbeat loop operating on 41.25s intervals; unacknowledged connections terminate with close code 4009 after 20s.
- [x] **Redis &rarr; NATS comparison written** ([Issue #24](https://github.com/moadabdou/Kith/issues/24), [`docs/redis-vs-nats.md`](../docs/redis-vs-nats.md)): In-depth evaluation of throughput, delivery semantics, subject routing, and operational complexity.
- [x] **Fan-out p99 metric exists (NATS &rarr; socket)** ([Issue #23](https://github.com/moadabdou/Kith/issues/23), [Issue #24](https://github.com/moadabdou/Kith/issues/24)): p99 measured at 17ms end-to-end (HTTP &rarr; Postgres &rarr; NATS &rarr; Gateway &rarr; WebSocket); Guild Actor fan-out benchmarked at 4.75M msgs/sec across 8 CPU cores.
