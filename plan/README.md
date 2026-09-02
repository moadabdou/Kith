# Discord Clone — Learning Plan

> Goal: understand **why something like Discord is possible** — massive concurrent
> WebSocket fan-out, realtime event ordering, wide-column message storage at scale,
> WebRTC voice/video, and distributed-systems failover — by building it.

## The stack (and why)

| Component | Tech | Discord parallel |
|---|---|---|
| Gateway (WebSocket fan-out) | **Elixir / BEAM** | Discord's gateway is Elixir; 5M+ concurrent users on one BEAM cluster |
| REST API + business logic | **Go** | Discord's REST services are mostly Go |
| Primary DB (users, guilds, roles) | **Postgres** | Discord's original primary store |
| Message store | **ScyllaDB** | Discord stores trillions of messages in ScyllaDB (moved from Cassandra, which itself was moved from Mongo) |
| Performance-critical services | **Rust** | Read States service (Go→Rust rewrite, famous blog post) + media processing |
| Voice/video | **WebRTC, Pion (Go) SFU** | Discord mediasoup→in-house media servers |
| Event bus | Redis Streams → NATS JetStream | Discord uses NATS + a fan-out monolith (guild actor) |
| Object storage / CDN | MinIO (local) → CDN pattern | Discord: GCS + Cloudflare CDN |
| Client | React + Vite + TS (minimal) | — |

## How to read this plan

- **Start with `11-roadmap.md`** — it is the spine. Everything else is a deep-dive
  reference that the roadmap points to when you reach that phase.
- `00-architecture.md` explains the big picture; re-read it after every phase —
  it will mean more each time.
- Every phase ends with a **chaos experiment** and a **"you now understand X"** gate.
  Don't skip these; they are the actual learning.
- `12-references.md` maps Discord engineering posts/talks to phases. Read the
  relevant post *before* starting each phase, then compare your design to theirs
  *after* finishing it.

## File index

| File | Subject | Phases |
|---|---|---|
| `00-architecture.md` | Services, event lifecycle, tech rationale | all |
| `01-gateway.md` | Elixir gateway: conns, guild actors, seq/resume, fan-out | 1, 7 |
| `02-rest-api.md` | Go REST: auth, CRUD, Postgres schema, rate limits | 0, 4 |
| `03-message-store.md` | ScyllaDB: bucketed partitions, pagination, migrations | 3 |
| `04-search.md` | Search: pg_trgm → Meilisearch/OpenSearch | 3 |
| `05-presence-typing.md` | Presence, typing, read states (Rust service) | 2, 8 |
| `06-permissions.md` | Role bitfields, permission resolution | 4 |
| `07-voice-video.md` | WebRTC: SDP/ICE/STUN/TURN, P2P mesh → own SFU, simulcast | 5, 6 |
| `08-media-pipeline.md` | Uploads, Rust transcode/thumbnails, CDN | 8 |
| `09-scalability-failover.md` | Sharding, multi-node, chaos catalog, SLOs | 7 |
| `10-deployment.md` | Docker Compose evolution → Oracle Cloud topology | all |
| `11-roadmap.md` | **The phased 3–6 month timeline (start here)** | all |
| `12-references.md` | Discord engineering posts, RFCs, papers mapped to phases | all |

## Ground rules

1. **Learning > shipping.** When two designs exist, pick the one that teaches more.
2. **Measure everything.** Each phase adds dashboards/metrics. "It works" is not
   data; p99 latency under N concurrent users is data.
3. **Break it on purpose.** Every phase has a chaos experiment. Failover you
   haven't tested is a rumor.
4. **Write post-mortems.** After each phase, ½ page: what surprised you, what
   Discord did differently, what you'd do next time. Keep them in `../postmortems/`.
5. **Timebox rabbit holes.** WebRTC alone can eat 6 months. The roadmap's phase
   ordering and gates exist to prevent that.
