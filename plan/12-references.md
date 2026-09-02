# 12 — References (mapped to phases)

> Read the phase's "required" items *before* building; the rest as you hit
> the relevant wall. Blog posts age — titles below are the canonical Discord
> engineering ones; find them via discord.com/blog or your favorite search.

## Discord engineering (the primary sources)

| Post / talk | Phase | Why it matters here |
|---|---|---|
| How Discord Scaled Elixir to 5,000,000 Concurrent Users | 1, 7 | The guild-actor + connection architecture you're building |
| Using Rust to Scale Elixir... / Elixir at Discord talks | 1 | NIF boundaries, BEAM tuning in production |
| How Discord Stored Billions of Messages (Mongo era) | 3 | Why the first store failed — workload analysis |
| How Discord Tripled Its Message Capacity (Cassandra bucketing) | 3 | **Your Scylla schema is this post.** Read twice |
| Discord's Migration to ScyllaDB (Scylla Summit talk) | 3 | Cassandra pain → C++ rewrite, shard-per-core |
| Why Discord is switching from Go to Rust (Read States) | 8 | GC p99 sawtooth → flat. The most famous systems chart in blog history |
| Lazy guild members / GUILD_MEMBER_LIST_UPDATE material | 2 | Windowed member lists, chunking |
| Discord rate limits / API docs (Rate Limits, Snowflakes, Permissions, Gateway) | 0, 1, 4 | Your literal spec — clone the wire formats |
| Discord media/RTC posts + "500ms voice" style talks | 5, 6 | Media server architecture, jitter/p99 targets |
| Discord signed-attachment-URL announcement | 8 | Authorized CDN media design |

## WebRTC (Phase 5–6 core curriculum)

- **webrtcforthecurious.com** — read fully before Phase 5; the best short treatment
- Pion: `pion/webrtc` examples → `pion/sfu` (read every line) → LiveKit `livekit/protocol`+`sfu` (source-reading, patterns)
- Wireshark RTP streams guide + one mandatory SRTP-capture exercise (07 §5)
- RFCs (reference, not cover-to-cover): 8825 overview, 8829 JSEP, 8445 ICE, 5389 STUN, 8656 TURN, 3550 RTP, 4585/5104 PLI/FIR, 3550 RTCP RR/SR
- coturn wiki (REST-credential TTL auth)

## Distributed systems (read alongside, not before)

| Material | Phase | The piece you'll use |
|---|---|---|
| "The Tail at Scale" — Dean & Barroso (CACM) | 7 | Why p99/p999 is the number |
| Kleppmann, *Designing Data-Intensive Applications* ch. 5 (replication), 8 (unreliable clocks), 9 (consistency) | 3, 7 | QUORUM, clock skew, eventual consistency vocabulary |
| NATS JetStream docs: clustering, consumers, dedup window | 1, 7 | Your bus's exact semantics |
| Scylla University (free): data modeling + compaction courses | 3 | Partition design, TWCS |
| Postgres docs: LISTEN/NOTIFY, logical replication, bloat/vacuum | 0, 3, 7 | Why PG was the wrong store for messages (feel it, name it) |
| BEAM: "The BEAM Book" (ch. on schedulers + distribution) + learn-you-some-erlang supervision chapters | 1, 7 | Preemption, `send` semantics, netsplit behavior |
- WhatsApp "2M WebSocket connections on FreeBSD" + "The Road to 2x2^20 connections" — same class of problem, different runtime
- Riak's "Understanding Bucket Replication..." — skip; instead: Jepsen analyses (aphyr) for Cassandra-class stores — read one writeup for tone and skepticism methodology

## Elixir / Go / Rust practicals

- Phoenix.PubSub + `Phoenix.Channel` docs (Phase 1 — even though you're on raw WS, the supervision-tree shape is the template)
- `libcluster` + `Horde` READMEs (Phase 7 — and their "caveats" sections ARE the lesson)
- `gocql` docs: consistency-per-query, prepared statements (Phase 3)
- Go: `golang-migrate`, `pgx`/`sqlc` docs (Phase 0)
- Rust: `image` crate (limits API), `axum` examples, `scylla-rust-driver` (Phase 8)
- Wireshark + `chrome://webrtc-internals` — tools, but treat fluency as reading material

## Tools reference (one link each, learn by using)

k6 (load), pumba (chaos), tc/netem (network violence), `nodetool` (scylla),
`webrtc-internals`, Grafana provisioning-as-code, Caddy (ACME + cache),
MinIO (S3 local), Meilisearch (filters/batching docs).

## Reading discipline

1 post/week max alongside building — more reading than that is procrastination
with better branding. The posts land 10x harder *after* you've hit the wall
they describe, so when in doubt: build first, read second.
