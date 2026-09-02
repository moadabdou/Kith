# 01 — The Gateway (Elixir)

> The heart of the system. Everything "realtime Discord" — fan-out, ordering,
> resume, presence — lives here. Phases 1, 2, and 7 all land on this file.

## 1. Responsibilities (and non-responsibilities)

**Does:**
- Terminate WebSocket connections (TLS via LB), heartbeat/identify/resume
- Track which sessions subscribe to which guilds
- Fan out events from the bus to subscribed connections
- Assign per-session sequence numbers, maintain resume buffers
- Serve presence/typing state (Phase 2) — in-memory only

**Does NOT:**
- Persist anything except transiently (resume buffers)
- Validate business logic (REST already did — gateway events are *post-truth*)
- Talk to Postgres (except a read-only cache warm at boot; see §7)

## 2. Process architecture (the BEAM map)

One **process per entity**, supervisied — the actor model Discord scaled to 5M+:

```
App Supervisor
├── Registry (:syn or Horde — cluster-aware process registry)
├── Guild.Supervisor (DynamicSupervisor)
│     ├── Guild.Actor (GenServer)  ── one per guild
│     │     state: %{subscribers: %{session_id => pid},
│     │              replay_buffer: ring_buffer}
│     └── (spawned per guild, dies with 0 subscribers after TTL)
├── Connection.Supervisor (DynamicSupervisor)
│     ├── Conn (GenServer per WebSocket, owns the socket)
│     └── ... up to ~100k/node (BEAM handles this; measure it)
├── Bus.ConsumerSupervisor
│     └── NATS consumer pool → routes event → Guild.Actor via Registry
└── Presence.Store (ETS tables, per-node; Phase 2)
```

Why per-guild actors? Fan-out for guild G touches exactly one process — no locks,
no cross-talk. A 1000-guild burst parallelizes across 1000 BEAM schedulers.
A guild actor is pure CPU + sends; BEAM is built for exactly this.

**Do the exercise:** before writing this, benchmark a naive version — one global
process, `send` to 10k connection pids in a loop — and compare against the actor
version under load. You'll *see* why the actor shape wins. Keep the numbers.

## 3. The Discord gateway protocol (implement this wire format)

Implement Discord's actual protocol — it's a superbly battle-tested design and
lets you test with real Discord bot libraries later.

### Client → server
```jsonc
{"op": 1, "d": null}                        // HEARTBEAT
{"op": 2, "d": {"token": "...", "intents": ...}}  // IDENTIFY
{"op": 6, "d": {"token": "...", "session_id": "...", "seq": 1337}}  // RESUME
{"op": 8, "d": {...}}                        // REQUEST_GUILD_MEMBERS (Phase 2)
```

### Server → client
```jsonc
{"t": null, "s": null, "op": 10, "d": {"heartbeat_interval": 41250}}  // HELLO
{"t": null, "s": null, "op": 11, "d": null}              // HEARTBEAT ACK
{"t": null, "s": null, "op": 0, "d": {...}}              // DISPATCH (t = event type)
{"t": null, "s": null, "op": 7, "d": null}               // RECONNECT (server wants you gone)
{"t": null, "s": null, "op": 9, "d": false}              // INVALID_SESSION (false → re-IDENTIFY)
```

Constants that matter:
- `heartbeat_interval` ≈ 41.25s (jittered per Discord; you choose, e.g. 10s locally)
- Zombkie detection: server misses 2 heartbeats → close code 4009
- Close codes: 4000 unknown error, 4001 unknown opcode, 4004 auth fail,
  4007 invalid seq (resume), 4008 rate limited, 4009 session timed out

### Event types you'll implement (in roadmap order)
`READY, MESSAGE_CREATE/UPDATE/DELETE, GUILD_CREATE, CHANNEL_CREATE/UPDATE/DELETE,
GUILD_MEMBER_ADD/REMOVE/UPDATE, PRESENCE_UPDATE, TYPING_START, MESSAGE_REACTION_ADD,
VOICE_STATE_UPDATE, GUILD_ROLE_*`

## 4. Connection lifecycle (state machine)

```
CONNECTING → HELLO sent
  → wait IDENTIFY (≤ 60s or close)
IDENTIFIED → session_id issued, seq = 0
  → dispatch READY: {user, guilds[], session_id, resume_url}
ACTIVE → heartbeats flow; every dispatch: seq = seq + 1 FIRST, then frame
DISCONNECTED (client side) →
  RESUME within timeout (60s):
    seq in replay buffer? → replay missing frames, continue session
    else → op 9 INVALID_SESSION(false), full re-IDENTIFY
```

Critical subtlety — **seq is assigned per-session, by the guild actor→conn path,
right before writing to the socket.** The conn process owns its seq (single
writer), writes the frame, appends to its session's replay buffer. No locks.

## 5. Fan-out path, precisely

```
NATS → Consumer (pull, batched) → route by guild_id → Registry lookup
     → Guild.Actor.handle_event(event)
        for session <- subscribers do
          send(session_pid, {:dispatch, event})
        end
     → Conn.handle_info({:dispatch, event})
        seq = state.seq + 1
        :ok = WS.send(frame(event, seq))
        RingBuffer.put(state.replay, seq, event)
```

Backpressure rules:
- Per-conn outbound queue cap (e.g. 8MB or 2048 frames). Over cap → close 4008.
  A slow client must not stall a guild actor — `send` is async, but the socket
  buffer isn't; monitor it.
- Guild actor processing is O(subscribers). If a single guild exceeds what one
  BEAM scheduler can push (measure!), you've hit the "large guild" problem —
  Discord's answer was NATS + a dedicated fan-out service. Your Phase 7 answer:
  shard *subscribers* across multiple actors for one guild (documented in §6).

## 6. Resume buffer design (this is a Phase 7 deep dive)

v1 (Phase 1): per-conn `:ets`/process-dict ring buffer, memory-only, node-local.
Node dies → buffer dies → clients full-resync. Acceptable, learn why it hurts.

v2 (Phase 7) options — implement one, compare honestly:
| Option | How | Pros | Cons |
|---|---|---|---|
| Shared ETS via a "resume node" | buffer lives on a node chosen by session hash | simple, in-memory speed | extra hop, node loss = buffer loss |
| Redis-backed buffer | append frames to Redis stream w/ TTL | survives node death, cluster-wide | Redis round-trip on every frame (measure the tax!) |
| JetStream replay | re-consume the bus from client's last seq | zero extra infra | bus must retain guild events keyed by seq — but seq is *per-session*, so you need per-session mapping — usually rejected here; write down why |

Discord's real approach: sessions are pinned to gateway nodes, and on node loss
clients resync (they chose availability of the *system* over perfect resume).
That's a valid answer too — document the tradeoff you pick.

## 7. Guild data cache

Fan-out events need guild shape (who's a member, which channels exist) to filter
recipients. But gateway never writes that data:
- On IDENTIFY, load member's guild list from Postgres read replica → local ETS cache
- Invalidate via events (`GUILD_MEMBER_ADD` etc.) — the bus is the cache-coherence protocol
- Cache misses on RESUME: refetch. Stale reads are fine; events will correct.

This is a distributed-systems lesson in itself: **you have a read-replica cache
with no invalidation protocol until the bus exists.** Order your build: bus first.

## 8. Horizontal scale (Phase 7 preview)

- Nodes are symmetric. LB (consistent-hash on session_id if you want pinning).
- `Phoenix.PubSub` with BEAM distribution *vs* NATS — do both, measure:
  - BEAM dist: full mesh, GC pressure, but `send` semantics
  - NATS: serialized through broker, but multi-region-friendly and language-neutral
- Guild actors can live on any node; Registry (Horde/`:syn`) locates them.
  Learn split-brain of the registry: what happens when two nodes both think they
  own guild G? (Answer: you need per-guild monotonic term/version or lease —
  see `09-scalability-failover.md` §4.)

## 9. Metrics (export from day one)

- connections_gauge, identifies/sec, resumes/sec, resume_replay_size
- fan_out latency: NATS receive → socket write, p50/p99 (the *core* metric)
- per-conn send-queue depth histogram; close_code counter by code
- BEAM: scheduler utilization, message_queue_len of guild actors (top 10)

## 10. Load test targets (Phase 7 gates)

- 1 node: 50k connections idle, 10k msg/s fan-out to avg 20 subscribers, p99
  dispatch→write < 50ms. BEAM will happily exceed this; find YOUR limit.
- Chaos: SIGKILL a node with 20k live connections → all resumable clients
  back within 5s via another node, zero missed events for buffered sessions.

## 11. Reading before you build Phase 1

- Discord: "How Discord Scaled Elixir to 5,000,000 Concurrent Users"
- Phoenix Channels docs (the shape of the supervision tree)
- "The Road to 2x2^20 WebSocket connections" (WhatsApp, same model)
- `12-references.md` §Phase 1
