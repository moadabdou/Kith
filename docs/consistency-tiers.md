# The Three Tiers of Real-Time Consistency

- **Document:** Technical Architecture Paper
- **Reference:** Closes [#42](https://github.com/moadabdou/Kith/issues/42), `plan/05-presence-typing.md` §2 & §4
- **Author:** Kith Real-Time Gateway Team
- **System:** Kith Real-time Infrastructure (`Elixir/OTP`, `Go REST API`, `PostgreSQL`, `NATS JetStream`, `Bandit/WebSock`)

---

## 1. Executive Abstract

A universal pitfall when designing real-time distributed collaboration platforms (e.g., Discord, Slack, Kith) is **treating all system state under a single consistency umbrella**. Applying traditional ACID or durable transactional guarantees across every event stream catastrophically degrades throughput and scalability. Conversely, applying loose, best-effort ephemeral transport to core user communications causes message loss, state divergence, and corrupted history.

To resolve this impedance mismatch, Kith organizes all real-time events into a **Three-Tier Consistency Hierarchy**:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                CONSISTENCY SPECTRUM                             │
│                                                                                 │
│   CHEAPEST / LOWEST COST                                   STRICTEST / HIGHEST COST │
│                                                                                 │
│   [ Tier 1: Ephemeral ]    ───►    [ Tier 2: Sticky ]     ───►   [ Tier 3: Log ]    │
│   Typing Indicators                 Presence States               Messages & Acks   │
│   • Fire-and-Forget                 • Heartbeat-Bound             • Monotonic Log   │
│   • 0% Persistence                  • In-Memory ETS               • ACID Storage    │
│   • Self-Healing 8s TTL             • Bounded Staleness           • Replayable      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

By explicitly declaring the consistency contract, storage medium, delivery semantics, and staleness budget for each tier, the system optimizes resource allocation: zero database writes for typing and presence, while maintaining strict monotonic ordering and zero loss for user conversations.

---

## 2. Multi-Dimensional Comparison Matrix

| Dimension | Tier 1: Ephemeral (Typing) | Tier 2: Sticky In-Memory (Presence) | Tier 3: Durable Monotonic (Messages) |
| :--- | :--- | :--- | :--- |
| **Representative Feature** | Channel Typing Indicators (`TYPING_START`) | User Online/Idle/DND/Offline (`PRESENCE_UPDATE`) | Chat Messages (`MESSAGE_CREATE`), Acks |
| **Durability Backend** | **None** (Zero persistence, wire-only) | **Node-Local RAM** (`:ets` table `presence_sessions`) | **Durable Database** (PostgreSQL / ScyllaDB + WAL) |
| **Consistency Model** | Eventual / Self-healing via timeout | Eventual consistency bounded by heartbeat TTL | Strict serial order per channel, monotonic sequence |
| **State Lifetime** | Instantaneous ($t = 0$), client renders for $8.0\text{s}$ | Duration of active session + heartbeat zombie grace | Permanent / Immutable history |
| **Delivery Guarantee** | **At-most-once** (Loss tolerated) | **At-most-once** per event; **Latest state queryable** | **At-least-once** over bus; **Exactly-once** to client |
| **Ordering Requirement** | Unordered (Timestamps informative only) | Causally ordered per user (last timestamp wins) | Strictly monotonic ($s_{n+1} = s_n + 1$) per session |
| **Replay / Gap Recovery** | **None** (Lost frames are discarded) | Re-queried via `REQUEST_GUILD_MEMBERS` / initial sync | **Replayable Ring Buffer** via Opcode 6 `RESUME` |
| **Write Path Latency** | $< 0.1\text{ms}$ (In-memory token bucket + fan-out) | $< 0.5\text{ms}$ (Concurrent ETS write + NATS broadcast) | $5\text{--}15\text{ms}$ (Postgres `fsync` + NATS JetStream pub) |
| **Write Amplification** | $1 \times$ (Bus fan-out only) | $1 \times$ (In-memory aggregation, zero disk I/O) | High (DB WAL, B-Trees, indexes, NATS JetStream) |
| **Fan-Out Model** | Channel-scoped ($M$ active channel members) | Mutual Guild-scoped ($N \times M$ co-members) | Channel-scoped ($M$ channel subscribers) |
| **Staleness Budget** | Max $8.0\text{s}$ (Self-heals to idle) | Heartbeat window ($2 \times T_{\text{hb}} = 20\text{s}$ zombie grace) | **$0.0\text{s}$** (Tolerates zero unacknowledged loss) |
| **Failure Resolution** | Let timeout expire; send nothing | Expire on heartbeat timeout or clean TCP FIN | Replay buffer ($60\text{s}$ TTL) or REST API backfill |

---

## 3. Tier 1: Ephemeral & Fire-and-Forget (Typing)

### 3.1 Design Philosophy & The 8-Second Self-Healing Contract
Typing indicators represent human intention in real-time. Because human typing is bursty and continuous, an active user might generate dozens of keypress events per minute. Persisting or acknowledging typing events introduces catastrophic overhead for zero long-term informational value.

The core architectural innovation of Tier 1 is **self-healing via client-side TTL**:
1. When a user presses a key, the client dispatches Opcode 14 `TYPING_START` (debounced client-side to $\le 1$ event per $8\text{s}$).
2. The gateway validates the session, updates a local rate limiter, and broadcasts `TYPING_START` with a Unix millisecond timestamp to mutual channel subscribers.
3. Receiving clients display *"User is typing..."* and mount a local **$8.0\text{second}$ countdown timer**.
4. **No cancellation message exists.** If the user deletes their draft, sends a message, or crashes, no `TYPING_STOP` event is transmitted. Instead, the indicator either automatically disappears when `MESSAGE_CREATE` arrives, or naturally expires when the 8-second timer elapses.

```text
User A (Typing)            Gateway / NATS                      User B (Observer)
     │                           │                                    │
     │── Opcode 14 (Typing) ────►│                                    │
     │   (Starts 8s timer)       │── Dispatch TYPING_START ──────────►│
     │                           │   {channel_id, user_id, ts}        │ (Displays "User A typing",
     │                           │                                    │  starts local 8s countdown)
     │   [User A crashes / closes tab]                                │
     │                           │                                    │
     │   (No cancel frame sent)  │   (No bus traffic generated)       │
     │                           │                                    │
     │                           │                                    │ (8s timer expires:
     │                           │                                    │  indicator disappears)
     ▼                           ▼                                    ▼
```

### 3.2 Server-Side Defense: Token Bucket Throttle
Because clients cannot be trusted to self-throttle, malicious or bugged clients could blast thousands of typing events per second. In a 500-member guild, 10 users spamming typing would produce 5,000 events/sec of pure noise.

Kith enforces a server-side rate limiter (`Gateway.Typing.RateLimiter`) backed by ETS:
- **Bucket Key:** `{user_id, channel_id}`
- **Window:** 1 event per 8,000ms.
- **Policy:** **Silent drop**. Excess events return `:rate_limited` internally without socket termination or HTTP 429 errors.
- **Empirical Verification:** In chaos testing ([Issue #41](https://github.com/moadabdou/Kith/issues/41), `docs/chaos-phase2.md`), a 100-frame blast over 1.6s achieved a **99% suppression rate** (1 delivered, 99 dropped) with zero socket degradation.

---

## 4. Tier 2: Sticky In-Memory & Eventual Consistency (Presence)

### 4.1 The $N \times M$ Fan-Out Dilemma
Presence represents the current availability of a user (`:online`, `:idle`, `:dnd`, `:offline`). It is an "impossible consistency" feature:
- **Write Volume:** Millions of users toggling status, connecting, or disconnecting.
- **Fan-Out Multiplier:** If User $U$ shares 10 guilds averaging 1,000 members each, a single presence change requires $10,000$ individual WebSocket dispatches.
- **Zero Database Persistence:** Storing presence transitions in PostgreSQL or ScyllaDB would trigger hundreds of millions of writes per minute at scale, instantly saturating I/O subsystems for data that becomes obsolete seconds later.

Kith resolves this by holding presence exclusively in **node-local BEAM memory (`:ets`)** with zero disk I/O.

### 4.2 Multi-Session State Aggregation & Broadcast Suppression
A single user may connect from multiple devices concurrently (e.g., desktop client, mobile app, web browser). The system must compute the user's aggregate presence:
1. **Multi-Session Rule:** A user is considered `:online` if $\text{ActiveSessions}(U) \ge 1$. A user transitions to `:offline` **if and only if** their last remaining session terminates.
2. **Online $\to$ Online Suppression:** If a user with an existing active session opens a second connection, the gateway records the new session ID in `:ets`, but **suppresses the `PRESENCE_UPDATE` broadcast** to mutual guilds because the user's observable status has not changed.
3. **Declared Status Hierarchy:** If any active session declares `:dnd`, the aggregate status honors `:dnd`.

### 4.3 The Bounded Staleness Budget (Zombie Window)
In a distributed environment, clean disconnects (TCP `FIN`/`RST`) are not guaranteed. When a client process crashes abruptly (`kill -9`), loses cellular reception, or encounters an ungraceful interface down:
- The server TCP stack remains unaware until a keepalive probe or heartbeat deadline passes.
- **Staleness Budget:** Kith sets the staleness budget to **$2 \times \text{heartbeat\_interval}$**. For our default 10-second heartbeat, the zombie window is precisely $20.0\text{s}$.
- During this 20-second window, the user is nominally reported as `:online` even though their process is dead. At $t = 20\text{s}$, `Gateway.Session` detects missed heartbeats, terminates the TCP socket with code `4009` (`Session timed out`), and notifies `Presence.Store.session_disconnected`, flipping the user to `:offline`.

```text
Client Heartbeat           Gateway Session Monitor                 Presence Store
     │                                │                                   │
t=0s │── Opcode 1 (Heartbeat) ───────►│ (Reset missed_count = 0)          │
     │                                │                                   │
t=10s│── [Client SIGKILL / Dropped] ──│                                   │
     │                                │                                   │
t=10s│                                │── Heartbeat check: missed = 1 ────┤
     │                                │   (Keep status :online)           │
     │                                │                                   │
t=20s│                                │── Heartbeat check: missed = 2 ────┤
     │                                │   (Threshold exceeded!)           │
     │                                │── Socket close(4009)              │
     │                                │── session_disconnected(user_id) ─►│
     │                                │                                   │── Broadcast
     │                                │                                   │   PRESENCE_UPDATE
     │                                │                                   │   status: :offline
     ▼                                ▼                                   ▼
```

### 4.4 Symmetrical Session Lifecycle vs. Presence Lifecycle
A crucial architectural invariant established in Phase 2 is the separation of **Session Actor Lifetime** vs. **Presence Store Lifetime**:
- When close code `4009` fires, the TCP socket closes and the user flips to `:offline`.
- However, the `Gateway.Session` GenServer **must remain alive** for the 60-second `disconnect_ttl_ms` to preserve the unacknowledged message ring buffer.
- When the client reconnects within 60s via Opcode 6 `RESUME`, the session actor resumes delivery without message loss, and immediately invokes `Presence.Store.session_connected`, restoring the user's presence to `:online` across all mutual guilds.

---

## 5. Tier 3: Durable, Transactional & Monotonic (Messages)

### 5.1 The Monotonic Replayable Sequence Log
Unlike typing and presence, chat messages (`MESSAGE_CREATE`) are durable legal and conversational records. They demand absolute zero-loss guarantees and strict causal ordering.

Kith enforces Tier 3 consistency through a three-stage pipeline:
1. **Durable ACID Ingestion:** Messages enter via the Go REST API (`POST /channels/:id/messages`), execute within a PostgreSQL database transaction with a unique Snowflake ID, and commit to disk.
2. **NATS JetStream Bus:** The REST API publishes the message payload to NATS JetStream topic `kith.events.{guild_id}` with persistent stream guarantees.
3. **Gateway Monotonic Sequence Assignment:** The gateway node consumes from NATS and routes the message to subscriber sessions. For each individual session, the gateway stamps an incrementing integer sequence number:
   $$s_{k+1} = s_k + 1$$
4. **Memory Ring Buffer:** The `Gateway.Session` GenServer appends the frame to an in-memory ring buffer (default capacity: 1,000 frames).

### 5.2 Reconnection & Gap Recovery
If a client experiences transient Wi-Fi drops or socket resets:
- The client reconnects and sends Opcode 6 `RESUME {session_id, seq: s_{last}}`.
- The gateway actor compares $s_{last}$ against its ring buffer.
- If $s_{last}$ is within the buffer window, the gateway replays all missing frames ($s_{last} + 1 \dots s_{current}$) in order, ending with Opcode 7 `RESUMED`.
- **Fallthrough Contract:** If the session has expired ($> 60\text{s}$) or the ring buffer has overflowed, the gateway rejects the resume with Opcode 9 `INVALID_SESSION {resumable: false}`. The client then falls back to Opcode 2 `IDENTIFY` and reconciles channel history via REST API pagination (`GET /channels/:id/messages?after=last_seen_id`).

---

## 6. Architectural Synthesis: The Cost of Misallocated Guarantees

What happens if an architect blurs the boundaries between these tiers?

```
                     CONSEQUENCE OF WRONG CONSISTENCY CHOICES
                     
    Persisting Tier 1 (Typing)            Treating Tier 3 (Messages) Like Tier 1
    ──────────────────────────            ──────────────────────────────────────
    • 10k typing writes/sec               • Missing messages on transient drop
    • Disk I/O exhaustion                 • Out-of-order conversational replies
    • Multi-gigabyte dead DB bloat        • Broken read states & unread counters
    • System collapses under noise        • Total loss of user trust
```

1. **Persisting Tier 1 (Typing):** Sinks database connection pools and bloats disk write queues with useless data that becomes invalid 8 seconds later.
2. **Treating Tier 2 (Presence) as Durable ACID:** Introduces synchronous cross-node locking and write storms during reconnect events (thundering herds).
3. **Treating Tier 3 (Messages) as Best-Effort:** Results in dropped chats, out-of-order discussions, and non-reproducible conversational context.

### Conclusion
By classifying data into **Ephemeral (Tier 1)**, **Sticky In-Memory (Tier 2)**, and **Durable Monotonic (Tier 3)**, Kith achieves optimal operational efficiency:
- Typing events cost **zero disk I/O** and self-heal automatically in 8 seconds.
- Presence transitions remain **purely in-memory**, scale horizontally via BEAM ETS, and bound inconsistency to a strict 20-second zombie window.
- Messages retain **flawless ACID durability**, monotonic sequencing, and zero-loss replayability across transient network partitions.
