# Phase 2 Postmortem: Presence & Typing

- **Phase:** Phase 2 — Presence & Typing (`plan/11-roadmap.md`, `plan/05-presence-typing.md`)
- **Execution Period:** Week 6–7
- **Closing Milestone Issue:** [#42](https://github.com/moadabdou/Kith/issues/42)

---

## 1. What Surprised Me

- **The Graceful vs. Ungraceful Disconnect Divide (Zombie Window vs. TCP FIN):**
  When a user cleanly quits an application or closes their browser tab, the operating system kernel immediately dispatches a TCP `FIN` or `RST` packet. The gateway receives this transport-level signal synchronously, tears down the socket, and marks the user `:offline` within milliseconds.
  However, in real-world networks (cellular dead zones, laptop lid closures, `SIGKILL`), no transport packet is ever sent. The connection enters a half-open state. Our initial intuition was that presence should feel "real-time," but attempting to detect dead connections faster than the heartbeat interval causes catastrophic false-positive disconnects under transient packet jitter. We had to embrace a formal **bounded staleness budget** ($2 \times \text{heartbeat\_interval} = 20.0\text{s}$). During our chaos drill ([Issue #41](https://github.com/moadabdou/Kith/issues/41)), the measured zombie window was precisely **19.99s** before the server closed the socket with code `4009` (`Session timed out`) and dispatched `:offline`.

- **ETS Concurrency & Multi-Session Race Conditions:**
  Holding presence in node-local BEAM memory (`:ets`) with `read_concurrency: true` delivered microsecond read access across concurrent gateway connections. However, managing multi-session state for a single user (e.g., a user connecting simultaneously from desktop and web, or rapidly reconnecting) introduced non-trivial race conditions:
  1. *Tracking Session Counts:* A user is `:online` as long as active sessions $\ge 1$. Flipping to `:offline` prematurely when session A disconnects while session B is active breaks user experience.
  2. *Broadcast Suppression:* When a user opens an additional concurrent session, recording the session in ETS is required, but broadcasting a `PRESENCE_UPDATE` (`online → online`) across hundreds of mutual guilds generates pure network amplification with zero state delta. Suppressing identical presence transitions eliminated redundant fan-out load.

- **Symmetrical Presence vs. Session Actor Lifecycle (The 4009 vs. RESUME Dichotomy):**
  In Phase 1, we learned that close code `4009` must terminate the stale TCP socket while keeping the underlying `Gateway.Session` GenServer alive for its 60-second disconnect TTL to service Opcode 6 `RESUME`.
  In Phase 2, this introduced a subtle symmetry requirement: when `4009` closes the socket, `Presence.Store.session_disconnected` correctly flips the user to `:offline` after the 20-second zombie window. However, when the client subsequently reconnects and succeeds on Opcode 6 `RESUME`, the gateway was initially restoring message delivery *without* flipping presence back to `:online`. Adding symmetrical `Presence.Store.session_connected` on session reattachment ensured mutual guild co-members immediately see the user return online while preserving their prior declared status (`:dnd`, `:idle`).

- **Streaming Guild Member Chunks vs. Memory Explosion:**
  In a 10,000-member guild, serializing all members into a single monolithic JSON payload for `GUILD_MEMBERS_CHUNK` risks severe BEAM process heap bloat (easily exceeding 150MB+ per concurrent request). By implementing a streaming chunk pipeline that batches members into 1,000-record chunks and releases intermediate binaries, total memory delta was capped at **31.29MB** across 10 chunks ([Issue #40](https://github.com/moadabdou/Kith/issues/40)), completing in 195ms without saturating gateway memory.

---

## 2. What Discord Did Differently

- **Lazy Guild Member List Protocol (`GUILD_MEMBER_LIST_UPDATE`):**
  For guilds with 10,000 to 1,000,000+ members, streaming complete member lists—even chunked—becomes unsustainable when multiplied by thousands of concurrent online subscribers. Discord solved this with their **Lazy Guilds** architecture:
  - The client only subscribes to a **windowed viewport** of the sidebar (e.g., indices `[[0, 99]]` for visible users, plus hoisted role headers).
  - As the user scrolls down the member list, the client dispatches range subscription updates (`SYNC [[100, 199]]`).
  - Discord's gateway dynamically inserts, moves, or removes member rows within the client's visible window via `GUILD_MEMBER_LIST_UPDATE`.
  - *Kith's Approach:* In Phase 2, Kith implements Discord's `REQUEST_GUILD_MEMBERS` streaming chunk protocol (streaming 1,000 members per frame with `chunk_index` and `chunk_count`). This is lightweight and performant up to 10k members, but full lazy windowing will be needed if guild sizes expand to 100k+.

- **Dedicated Distributed Presence Service vs. Node-Local ETS:**
  Discord originally stored presence inside Elixir gateway nodes. As they scaled past millions of concurrent connections, the $N \times M$ fan-out problem overwhelmed gateway memory. Discord extracted presence into a dedicated distributed cluster service (written in Elixir, and later augmented with Rust caches). This presence tier aggregates user sessions globally and dispatches updates across a private network mesh using virtual user channels (`:user_id` routing).
  Kith currently keeps presence in node-local ETS with NATS JetStream pub/sub distribution. This delivers sub-millisecond local queries and zero operational friction for single/clustered gateway deployments up to tens of thousands of concurrent connections, but would require a dedicated presence service at Discord's 100M+ scale.

- **Typing Rate Limiting & Ephemeral TTL:**
  Both Discord and Kith adhere to the self-healing ephemeral principle: typing events carry an 8–10 second client render TTL and emit **zero cancellation frames**. Discord enforces a 10-second client-side throttle. Kith chose an 8-second window aligned with client render timers, reinforced by a server-side token bucket that silently drops spam frames without terminating connections.

---

## 3. What I'd Do Next Time

1. **Adopt Viewport Range Subscriptions from Day One for Member Lists:**
   While streaming 10k members in 1,000-count chunks performs well within our 50MB memory gate, building the windowed range protocol (`[[0, 99]]`) earlier would eliminate client DOM rendering strain for massive guilds.
2. **Encapsulate Presence State Transitions in a Formal Functional Statechart:**
   Consolidate multi-session aggregation, idle timeout detection, and status precedence (`:dnd` > `:online` > `:idle`) into a pure, testable state machine module decoupled from ETS read/write calls.
3. **Decouple Presence Fan-out from Guild Channel Broadcasts:**
   Introduce a dedicated high-priority presence channel in NATS to prevent massive presence fan-out bursts during peak reconnect storms from contending with conversational message traffic.

---

## 4. Phase 2 Chaos & Bench Evidence

Automated chaos drills and benchmarks executed during Phase 2 validation:

- **10k Guild Member Chunking Benchmark** ([Issue #40](https://github.com/moadabdou/Kith/issues/40), [`docs/chunk-memory-profile.md`](../docs/chunk-memory-profile.md)):
  - **Workload:** 10,000 seeded guild members streamed across 10 chunks (1,000 members/chunk) to requesting clients.
  - **Memory Delta:** **31.29MB** (Pass criteria: $< 50\text{MB}$ gate).
  - **Execution Duration:** **195ms** total processing time.
  - **Invariants Verified:** Monotonic `chunk_index` ($0 \to 9$), correct `chunk_count = 10`, zero memory leaks.

- **Presence & Typing Chaos Engineering Drills** ([Issue #41](https://github.com/moadabdou/Kith/issues/41), [`docs/chaos-phase2.md`](../docs/chaos-phase2.md)):
  - **Drill 1 (Zombie Window Detection):** Client heartbeats halted without TCP FIN. Server detected missing heartbeats and closed the socket with code `4009` after **19.99s** (expected $2 \times 10\text{s} = 20.00\text{s}$), flipping status to `:offline`.
  - **Drill 2 (Zombie Recovery & Symmetrical RESUME):** Reconnecting with Opcode 6 `RESUME` after zombie disconnect replayed all queued messages and restored status to `:online` with zero packet loss.
  - **Drill 3 (Typing Flood Throttle Defense):** Blasted 100 typing frames over 1.6s. Rate limiter delivered **exactly 1** `TYPING_START` event, silently suppressed 99 spam frames (**99% suppression rate**), maintained socket stability, and self-healed after 8.0s.

---

## 5. Phase 2 Gate Checklist Sign-off

All milestone acceptance criteria from `plan/05-presence-typing.md` §4 and `plan/11-roadmap.md` are satisfied:

- [x] **Presence transitions correct incl. zombie timeout** ([Issue #38](https://github.com/moadabdou/Kith/issues/38), [Issue #41](https://github.com/moadabdou/Kith/issues/41)): ETS-backed presence store tracks `:online`, `:idle`, `:dnd`, and `:offline`; silent client drops cleanly flip to `:offline` after the bounded 20-second heartbeat zombie window (code 4009).
- [x] **10k-member seeded guild chunks without gateway memory blowup** ([Issue #40](https://github.com/moadabdou/Kith/issues/40)): Streamed 10,000 members in 10 chunks of 1,000 in 195ms with 31.29MB memory footprint, beating the 50MB ceiling.
- [x] **Typing events don't survive 8s, can't be spoofed-flooded** ([Issue #39](https://github.com/moadabdou/Kith/issues/39), [Issue #41](https://github.com/moadabdou/Kith/issues/41)): Ephemeral client render with 8.0s auto-expiry; server-side rate limiter enforces 1 event / 8s per user/channel, verified with 99% suppression rate under 100-frame flood.
- [x] **The three-tier consistency comparison written** ([Issue #42](https://github.com/moadabdou/Kith/issues/42), [`docs/consistency-tiers.md`](../docs/consistency-tiers.md)): Comprehensive technical document contrasting Tier 1 (Ephemeral/Typing), Tier 2 (Sticky/Presence), and Tier 3 (Monotonic/Messages).
- [x] **Member sidebar renders online members grouped by hoisted role** ([Issue #37](https://github.com/moadabdou/Kith/issues/37), [Issue #39](https://github.com/moadabdou/Kith/issues/39)): Client UI renders live presence indicators (green online, amber idle, red dnd) and groups members under hoisted role category headers.
