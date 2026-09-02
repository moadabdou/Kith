# 00 — Architecture: The Big Picture

> Read this before Phase 1, and again after every phase. The question this doc
> answers: **what does each box do, what talks to what, and why this shape?**

## 1. Why Discord is hard (the problem, stated precisely)

Discord is not a CRUD app with sockets bolted on. It is:

1. **A fan-out problem.** One message in a 500-member guild → up to 500 WebSocket
   frames delivered in ~ms, while millions of other frames are in flight.
2. **An ordering problem.** A client must see a consistent, gapless, ordered
   event stream per guild, even when it reconnects to a *different server*.
3. **A storage problem.** Trillions of messages, written once, read in
   "last 50, then paginate up" patterns, never updated (except 15-min edit window).
4. **A realtime media problem.** Voice = RTP packets every 20ms that must not
   queue behind chat traffic; video = bandwidth adaptation per subscriber.
5. **A failure problem.** Everything above must survive: gateway node death,
   DB node death, network partitions, and deploys — *without users noticing*.

Everything in this plan is one of those five problems.

## 2. System shape (target, Phase 7+)

```
                                    ┌────────────────────┐
        wss://gateway                │   Load Balancer     │   https://api
   ┌──────────────────────┐         │  (HAProxy/Caddy)    │  ┌──────────────┐
   │      CLIENTS         │────────▶│──────┬──────────────┴─▶│  Go REST API │
   │ (React client, bots) │                │                  │  auth/guilds │
   └──────────┬───────────┘                ▼                  │  /messages   │
              │                    ┌───────────────┐          └──────┬───────┘
              │                    │ Elixir Gateway │                 │
              │  media (RTP/SRTP)  │  (cluster,     │          ┌──────▼───────┐
              │                    │   N nodes)     │          │   Postgres   │
              │                    └───────┬───────┘          │ users/guilds │
              │                            │                  │ roles/invites│
              │                    ┌───────▼───────┐          └──────────────┘
              │                    │  Event Bus     │
              │                    │ NATS JetStream │◀─── publish (after commit)
              │                    └───────┬───────┘
              │                            │
              │                    ┌───────▼───────┐
              │                    │   ScyllaDB    │  messages (bucketed partitions)
              │                    └───────────────┘
              │
              │                    ┌───────────────┐     ┌──────────────────┐
              └───────────────────▶│ Rust SFU-adj. │     │  Rust read-states │
                                   │ media workers  │     │  service         │
                                   └───────┬───────┘     └──────────────────┘
                                           │
                                   ┌───────▼───────┐
                                   │  Pion SFU (Go) │  voice/video channels
                                   └───────────────┘
```

(Yes, the SFU and Rust placement evolves — see `07-voice-video.md` and
`08-media-pipeline.md`. In early phases this whole diagram collapses into
one compose network; see `10-deployment.md`.)

## 3. The event lifecycle (the most important flow in the system)

A message send, end to end:

```
Client ──REST POST /channels/42/messages──▶ Go API
  1. Auth (JWT), rate-limit check, permission check (06)
  2. Validate body, snowflake-generate message ID
  3. INSERT into ScyllaDB (bucket = snowflake >> 22 & mask, see 03)
  4. AFTER COMMIT: publish MESSAGE_CREATE to event bus
       (why after commit? phantom events / event for data that rolled back)
Gateway (Elixir):
  5. Bus consumer receives MESSAGE_CREATE
  6. Looks up guild actor (GenServer, one per guild — see 01)
  7. Actor iterates subscribers, sends frame over each WebSocket
  8. Each connection assigns seq++ per its session, writes to resume buffer
Client:
  9. Receives {"t":"MESSAGE_CREATE","s":123,"d":{...}}
```

Key insight to internalize: **REST is the write path; the gateway is the read
path; the bus is the spine between them.** REST never talks to WebSockets.
This separation is why you can scale writes and fan-out independently.

## 4. Ordering & resume: why the gateway is "hard"

- Every connected session has a **monotonic per-session sequence number** (`s`).
- Client tracks last-seen `s`. On disconnect+reconnect, it sends
  `RESUME {session, last_seq}`.
- Gateway keeps a bounded **event replay buffer** per guild (Discord: a few
  minutes). If `last_seq` is still in the buffer → replay the gap. Else →
  `INVALID_SESSION`, client does a full `IDENTIFY` resync.
- This is how Discord survives gateway node death: the LB routes the resumed
  connection to a *different node*, which replays from the shared buffer.
  (In Phase 1 the buffer is in-memory per node; Phase 7 makes it cluster-wide
  or Redis-backed — the tradeoffs are in `01-gateway.md` §6.)

## 5. Why each tech (and what it teaches you)

| Tech | Chosen because | The lesson |
|---|---|---|
| Elixir/BEAM | Millions of lightweight processes; pre-emptive scheduling; `Phoenix.PubSub` + distribution built-in; this is literally Discord's choice | Actor-per-entity is the natural model for guilds; you learn supervision trees, backpressure, `:gen_tcp`/WS internals |
| Go | Fast HTTP services, great DB ecosystem, boring concurrency | You learn when "boring and explicit" beats "elegant": the REST tier is intentionally dull so the interesting parts stay isolated |
| Postgres | Transactional truth for users/guilds/roles | Consistency boundaries: which data *must* be transactional vs eventually consistent |
| ScyllaDB | LSM wide-column store built for exactly Discord's write pattern | Partition design, clustering keys, compaction, QUORUM reads/writes, tombstones — the "massive data" part of your goals |
| Rust | Systems performance where GC pauses hurt (read-states p99, media workers) | The famous Discord post: Go GC causing p99 spikes every 2min → Rust rewrite → 99th percentile basically flat. You'll reproduce the measurement, not just the claim |
| NATS JetStream | Durable, replayable, clustered queue; simpler ops than Kafka | Stream/consumer semantics, at-least-once delivery, dedup on the consumer |
| Pion (Go SFU) | WebRTC without C++ hell; readable codebase you can hack | RTP/RTCP, simulcast, congestion control — the "own SFU" learning path |

## 6. Data ownership map (who owns what, one source of truth each)

| Data | Owner | Notes |
|---|---|---|
| Users, sessions, hashes | Postgres | transactional |
| Guilds, channels, roles, members | Postgres | transactional; gateway caches read-only replicas |
| Messages | ScyllaDB | immutable after write (edit = new version field, 15min window) |
| Event stream (transient) | NATS JetStream | replay window hours, not forever |
| Presence | Gateway (in-memory, ETS) | intentionally NOT persisted — ephemeral by design |
| Read states / acks | Rust service (ScyllaDB-backed) | hot, tiny, per-user-per-channel counters |
| Voice states | SFU + gateway events | in-memory, voice-state-update events |
| Media blobs | MinIO/S3 + CDN | immutable, content-addressed |

Rule: if two services both "own" a piece of data, you have a bug in the design.
Gateway caches Postgres data but never writes it back except via REST.

## 7. Discord vs. you (honest differences)

| Discord (production) | You (learning build) |
|---|---|
| Hundreds of gateway nodes, a custom "guild fan-out monolith" consuming NATS | 1→N gateway nodes; guild actor *is* the fan-out service |
| Sharded gateway endpoints + client-side shard routing for big bots | Sharding math learned, then one gateway cluster |
| Datastore team maintaining Scylla at trillion-row scale | 3-node Scylla cluster in Docker, but same schema design |
| In-house media servers (C++/Rust lineage) | Pion SFU, same protocols |
| Millions of dollars of infra | Oracle free tier + patience |

This is fine. The *shape* of the problems, not their magnitude, is the lesson.
You'll simulate magnitude with load tests (Phase 7).

## 8. Cross-cutting decisions (made once, apply everywhere)

1. **Snowflake IDs everywhere** (64-bit: 42 time + 10 machine + 12 seq). Gives you
   time-ordering, bucket derivation for Scylla, and no coordination. Format in `02-rest-api.md` §4.
2. **Events are JSON in v1** (like Discord), with an escape hatch: the envelope
   is versioned so you can try protobuf/msgpack in a stretch goal.
3. **At-least-once delivery + client dedup by event id** from day one. Exactly-once
   is a lie you pay for; idempotent consumers are cheap.
4. **Blue/green-ish deploys from Phase 1**: two gateway containers behind LB,
   drain one, kill it, watch clients resume. This habit is the failover curriculum.
5. **Every service exposes /healthz (liveness) and /readyz (readiness)** — plus
   Prometheus metrics from Phase 0. No exceptions; Phase 7 chaos tooling depends on it.
