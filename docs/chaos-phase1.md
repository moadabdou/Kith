# Chaos Engineering Experiment Report: Phase 1 Gateway Fault Tolerance

- **Experiment ID:** CHAOS-PHASE-1-GW
- **Issue Reference:** Closes #27
- **Target System:** Kith Real-time Gateway (`Elixir/OTP`, `WebSock`, `Registry`, `GenServer`)
- **Execution Date:** 2026-09-08
- **Tooling:** [`scripts/chaos/phase1_gateway_chaos.js`](../scripts/chaos/phase1_gateway_chaos.js)

---

## 1. Executive Summary

Phase 1 Gateway Chaos testing verified the resilience, buffer replaying, session lifecycle, and tier isolation of Kith's WebSocket gateway under transient and catastrophic network and host failures.

All three automated drills passed without regression:
1. **Transient Disconnects (5s and 30s):** Buffer replay via Opcode 6 (`RESUME`) delivered 100% of messages queued during disconnections. All three mathematical invariants (Completeness, Idempotency, Monotonicity) were strictly satisfied.
2. **Hard Process Termination (`SIGKILL`):** Immediate termination of the gateway container wiped in-memory session actors. REST API and PostgreSQL tiers remained fully operational. Upon gateway recovery, the client received Opcode 9 (`INVALID_SESSION: false`), safely fell back to Opcode 2 (`IDENTIFY`), and recovered all messages via REST synchronization with zero total message loss.
3. **Session TTL Reaping (65s > 60s TTL):** Disconnected session actor was cleanly evicted from the OTP registry by the `GenServer` reaper after the 60-second TTL elapsed. A subsequent `RESUME` was rejected with Opcode 9, preventing resource leaks.

---

## 2. Invariants Under Test

In distributed streaming systems, reliability guarantees must be mathematically verifiable:

1. **Completeness (Zero Message Loss):**
   $$\mathcal{M}_{\text{published}} \subseteq \mathcal{M}_{\text{received}}$$
   Every message published to the channel while a subscriber is online, disconnecting, or reconnecting must eventually be present in the subscriber's state.

2. **Idempotency (Zero Duplication):**
   $$\forall m_i, m_j \in \mathcal{M}_{\text{received}},\; i \neq j \implies m_i.\text{id} \neq m_j.\text{id}$$
   Replays from the gateway in-memory ring buffer must never inject duplicate events into the client stream.

3. **Strict Monotonicity:**
   $$\forall (e_a, e_b) \text{ received in sequence},\; \text{seq}(e_b) = \text{seq}(e_a) + 1$$
   Sequence numbers must progress sequentially without backwards jumps or unacknowledged gaps.

---

## 3. Drill 1: Transient Disconnects (5s and 30s)

### Hypothesis
A client experiencing short-duration TCP disconnection (5s or 30s) will reconnect, issue Opcode 6 `RESUME`, and receive buffered dispatch events from `Gateway.Session`'s ring buffer without missing any messages or receiving duplicates.

### Sequence
1. Client connects, receives `HELLO` (Heartbeat Interval: 41250ms), sends `IDENTIFY`, receives `READY` (`session_id: f245309b7e23aff872398db997e419ad`).
2. Baseline message 1 published via REST API $\to$ received live with `seq: 1`.
3. Client forcefully closes TCP connection (`ws.terminate()`).
4. REST API publishes messages 2, 3, 4 while client is offline.
5. Client reconnects at $t = 5\text{s}$, sends `RESUME` (`session_id`, `seq: 1`).
6. Gateway replays buffered messages 2, 3, 4 $\to$ client advances `lastSeq: 4`.
7. Client forcefully closes TCP connection again.
8. REST API publishes messages 5, 6, 7 while client is offline.
9. Client waits 30 seconds (exercising server zombie detection and holding across the 20s heartbeat window).
10. Client reconnects at $t = 30\text{s}$, sends `RESUME` (`session_id`, `seq: 4`).
11. Gateway replays buffered messages 5, 6, 7 and resumes live streaming. Message 8 published and received live.

### Results & Invariant Audit

| Metric | Target | Actual Result | Status |
| :--- | :--- | :--- | :--- |
| Published Messages | 8 | 8 | Matched |
| Received Messages | 8 | 8 | Matched |
| Invariant 1: Completeness | 0 lost | 0 lost ($8/8$ received) | **PASSED** |
| Invariant 2: Idempotency | 0 duplicates | 0 duplicates | **PASSED** |
| Invariant 3: Monotonicity | $1 \to 8$ consecutive | $1 \to 2 \to 3 \to 4 \to 5 \to 6 \to 7 \to 8$ | **PASSED** |

---

## 4. Drill 2: Hard Container Kill (`SIGKILL`) & Tier Isolation

### Hypothesis
Terminating the gateway container with `SIGKILL` mid-stream will demonstrate:
1. **Tier Isolation:** The REST API and Database remain 100% available and accept writes while the gateway is dead.
2. **Clean Degraded Fallback:** Upon gateway restart, the client's `RESUME` attempt will fail with Opcode 9 (`INVALID_SESSION: false`) because OTP process memory was lost.
3. **Eventual Consistency:** The client falls back to Opcode 2 `IDENTIFY`, re-authenticates, and reconciles message history via REST API backfilling with zero lost messages.

### Sequence
1. Client connects and establishes session (`session_id: bd481db2713ddae43433238b3f90f9e4`).
2. Gateway container is killed abruptly:
   ```bash
   docker kill -s SIGKILL kith-gateway-1
   ```
3. While gateway is dead, 3 messages are published via REST API (`POST /api/v1/channels/:id/messages`).
   - REST API responds HTTP 201 Created. PostgreSQL transaction commits. NATS message fanout buffers.
4. Gateway container is restored:
   ```bash
   docker compose start gateway
   ```
5. Gateway healthcheck passes on port 4000.
6. Client reconnects and attempts Opcode 6 `RESUME` with previous `session_id`.
7. Gateway responds with Opcode 9:
   ```json
   { "op": 9, "d": false }
   ```
8. Client switches to fresh authentication, sends Opcode 2 `IDENTIFY`, and receives new `READY`.
9. Client reconciles history from REST API (`GET /api/v1/channels/:id/messages?limit=50`).
10. All 11 messages verified in sequence.

### Results

| Aspect | Prediction | Actual Result | Status |
| :--- | :--- | :--- | :--- |
| REST API during Gateway Down | 100% Availability | HTTP 201 for all writes | **PASSED** |
| Gateway Restart Response | Opcode 9 `d: false` | Opcode 9 `d: false` | **PASSED** |
| Client Recovery Flow | IDENTIFY + REST Backfill | IDENTIFY + REST Backfill | **PASSED** |
| Message Consistency | Eventual consistency ($11/11$) | 11/11 messages verified | **PASSED** |

---

## 5. Drill 3: Session TTL Expiry (65s > 60s TTL)

### Hypothesis
If a client disconnects and does not reconnect within the configured `disconnect_ttl_ms` (60,000ms), the `Gateway.Session` GenServer reaper timer will fire, terminate the session process, and unregister it from the Registry. Any subsequent `RESUME` attempt must be rejected with Opcode 9 (`INVALID_SESSION`).

### Sequence
1. Client connects and establishes session (`session_id: 79ee835c76ab293243ce2f6001e373fc`).
2. Client disconnects cleanly.
3. Test harness monitors countdown for 65 seconds ($65\text{s} > 60\text{s}$ TTL).
4. At $t = 65\text{s}$, client reconnects and transmits Opcode 6 `RESUME` targeting the old `session_id`.
5. Gateway responds immediately with:
   ```json
   { "op": 9, "d": false }
   ```

### Results

| Aspect | Prediction | Actual Result | Status |
| :--- | :--- | :--- | :--- |
| Expiration Boundary | Reaped at $t = 60\text{s}$ | Process evicted before $t = 65\text{s}$ | **PASSED** |
| Post-Expiry Handshake | Opcode 9 `INVALID_SESSION` | Opcode 9 received | **PASSED** |
| Memory Leak Prevention | Stale sessions pruned | Zero zombie actors remaining | **PASSED** |

---

## 6. Telemetry & Metrics Audit

Prometheus metrics scraped directly from the Gateway (`http://localhost:4000/metrics`):

```promql
# Sessions currently tracked
gateway_sessions_active 1

# WebSocket Disconnects by close code
gateway_ws_close_codes_total{code="1000"} 3

# Histogram of replay buffer deliveries
gateway_resume_replay_size_bucket{le="10"} 0
```

> **Observation:** In-memory Prometheus counters reset upon container restart during Drill 2, accurately reflecting node-local state without cross-container metric contamination.

---

## 7. Resolution of Discovered Edge Cases

During preparation for this drill, a critical edge case was identified and resolved:
- **Bug:** `gateway/lib/gateway/ws/handler.ex` listed close code `4009` under unrecoverable terminal codes `[4004, 4008, 4009]`.
- **Impact:** Server-side zombie detection (20s without heartbeat) closed the socket with 4009, which killed the `Gateway.Session` actor immediately, making 30s disconnects unresumable.
- **Fix:** Removed `4009` from the kill list in commit `109c264`. `4009` closes the socket while leaving the session actor alive to serve the 60s `RESUME` window.

---

## 8. Conclusion

The Phase 1 Gateway implementation satisfies all core distributed systems requirements for real-time messaging:
- Strict order preservation and idempotency across intermittent network splits.
- Graceful degradation and recovery under sudden host failure.
- Bounded memory guarantees through deterministic actor lifecycle management.
