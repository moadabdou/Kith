# 02 — REST API (Go) + Postgres

> The write path and the transactional truth. Phases 0 and 4 land here.
> This tier is *intentionally boring* — that's a design lesson, not a shortcut.

## 1. Service layout

Start as **one Go binary with internal packages** (modular monolith), split into
separate services only when a phase demands it (learning: service boundaries
should be *discovered*, not assumed).

```
api/
├── cmd/server/main.go
├── internal/
│   ├── auth/         JWT issue/refresh, argon2id hashing, register/login
│   ├── users/
│   ├── guilds/       guild/channel CRUD, invites, members
│   ├── roles/        role CRUD, member-role assignment (Phase 4)
│   ├── messages/     POST /messages (write path!), edit/delete, GET pagination
│   └── events/       outbound event publisher (the ONLY code that talks to NATS)
├── pkg/
│   ├── snowflake/    ID generation (§4)
│   ├── permissions/  bitfield resolution (06-permissions.md) — shared lib
│   └── ratelimit/
```

Routes (Discord-compatible where it matters):
```
POST   /auth/register, /auth/login, /auth/refresh
GET    /users/@me
GET/PATCH /guilds, POST /guilds
GET/POST/PATCH/DELETE /guilds/:id/channels
PUT/DELETE /guilds/:id/members/:uid
GET/PUT /guilds/:id/members/:uid/roles/:rid   (Phase 4)
POST   /guilds/:id/channels/:cid/messages      ← the hot path
GET    /guilds/:id/channels/:cid/messages?before=<id>&limit=50
PATCH/DELETE /channels/:cid/messages/:mid     (edit ≤15min, author only)
POST   /invites, POST /invites/:code/join
```

## 2. Postgres schema (v1)

```sql
users      (id bigint PK, username text unique, discriminator smallint,
            email citext unique, password_hash text, created_at, ...)
sessions   (id bigint PK, user_id FK, refresh_token_hash, expires_at)
guilds     (id bigint PK, name, owner_id FK, created_at)
channels   (id bigint PK, guild_id FK, -- NULL for DMs (later)
            type smallint,  -- 0 text, 2 voice (Discord's numbering)
            name, position int, parent_id)
members    (guild_id, user_id, joined_at, nickname, PRIMARY KEY (guild_id, user_id))
roles      (id bigint PK, guild_id FK, name, color int, position int,
            permissions bigint, mentionable bool)  -- permissions = BITFIELD (06)
member_roles (guild_id, user_id, role_id, PRIMARY KEY (guild_id, user_id, role_id))
channel_overwrites (channel_id, target_id, target_type smallint, -- 0 role, 1 member
            allow bigint, deny bigint, PRIMARY KEY (channel_id, target_id))
invites    (code text PK, guild_id, channel_id, inviter_id, uses, max_uses,
            expires_at)
```

Schema lessons to absorb while building:
- **No message table here.** Messages go to ScyllaDB from Phase 3 (in Phase 0–2,
  a stop-gap `messages` table in PG is fine — you'll feel the migration pain,
  which is the point of Phase 3).
- `members` and `member_roles` are the only many-to-many tables; watch their
  growth — guilds with 100k members make these hot. (Discord moved the member
  table itself out of PG eventually — the "5M member guild" blog post.)
- Index design: every FK gets an index; `members(user_id)` for "my guilds" query.
- Use `pgx` + `sqlc` (or GORM if you prefer; measure the difference once).

## 3. The write path: POST /messages (the flow to memorize)

```
1. Auth middleware: JWT → user_id (no DB hit; keys are stateless)
2. Rate limit: per (user, channel) token bucket — Redis in Phase 1+,
   in-memory Phase 0. Return X-RateLimit-* headers like Discord.
3. Permission check: pkg/permissions.CanSend(user, channel) — see 06.
4. Generate snowflake ID.
5. Phase 0-2: INSERT into PG. Phase 3+: INSERT into ScyllaDB (03).
6. Fetch channel→guild, author object (for the event payload).
7. AFTER COMMIT: events.Publish("MESSAGE_CREATE", payload)
   → This ordering is the single most important decision in this file.
     Publishing before commit = phantom events on rollback.
     Publishing in the same PG transaction (via LISTEN/NOTIFY) = coupling
     the bus to PG. Learn both; justify your choice in the postmortem.
8. Respond 200 with the message JSON (same shape as the event payload — DRY it).
```

Idempotency: support `Idempotency-Key` header on POST /messages (Discord does).
Store `key → message_id` in Redis TTL 24h. Duplicate = return original 200.
This single feature is what makes "at-least-once everywhere" safe end-to-end.

## 4. Snowflake IDs

```
64 bits: [1 unused][41 ms epoch][10 node id][12 sequence]
- epoch: your custom epoch (e.g. 2026-01-01) → IDs valid until ~2093
- node id: from env/config (Phase 7: assign per gateway node or per API replica)
- sequence: per-process counter, resets each ms
```
Properties you get for free: time-sortable (pagination keys!), bucket derivation
for Scylla (03 §3), no DB sequence coordination. Write it yourself (~40 lines
with a mutex or atomic), then port it to Elixir and compare notes — the IDs
must be identical in shape across services.

## 5. Rate limiting (learn Discord's actual model)

- Per-route buckets: `POST /messages` = 5/5s per channel per user; mutations
  on guilds = rarer. Response headers:
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`,
  `X-RateLimit-Bucket` (a hash identifying the bucket), and 429 + `Retry-After`.
- Implementation: Redis `INCR` + `EXPIRE` or a Lua script for correct
  window-reset semantics. Per-user *global* limit (50 req/s) as a backstop.
- Lesson: rate limiting is a *contract* with well-behaved clients (bots).
  It's load shaping, not security. Security is authz + validation.

## 6. Validation & errors

- Error envelope exactly like Discord: `{"code": 50001, "message": "Missing Access"}`
  (50001 missing access, 50013 missing permissions, 50035 invalid form body).
- Error code registry lives in `pkg/errs`; gateway and REST share the codes.
- Validate with `go-playground/validator`; never trust gateway-cache data on
  the REST path — REST re-reads Postgres (it's the truth owner).

## 7. Migrations & seeds

- `golang-migrate` (or goose). One migration per schema change, never edit old ones.
- Seed script: 1 user, 1 guild, 3 channels, 50 roles to perm-test (Phase 4),
  and a "big guild" generator (10k members) for Phase 7 load tests.

## 8. Phase gates

- Phase 0 gate: register→login→create guild→create channel→send message→read
  it back, all via curl script (keep it as `scripts/smoke.sh` forever).
- Phase 4 gate: permission matrix test — 20+ cases (role has, role denies,
  channel overwrite denies, admin bypass...) as table-driven Go tests. This
  suite is gold; carry it through every refactor.

## 9. Reading

- Discord API reference: "Rate Limits", "Snowflakes", "Permissions" (the docs
  themselves are the spec you're cloning)
- `12-references.md` §Phase 0/4
