# 06 — Roles & Permissions

> Phase 4. Discord's permission model is a genuinely elegant piece of
> bitfield algebra — implementing it *exactly* teaches bitmask math, layered
> override resolution, and defense-in-depth across services.

## 1. The model (implement Discord's actual semantics)

### Permission bits (subset — follow Discord's canonical ordering)
```go
// pkg/permissions/permissions.go — shared by Go REST, gateway cache, client TS
const (
    CREATE_INSTANT_INVITE uint64 = 1 << 0
    KICK_MEMBERS          uint64 = 1 << 1
    BAN_MEMBERS           uint64 = 1 << 2
    ADMINISTRATOR         uint64 = 1 << 3
    MANAGE_CHANNELS       uint64 = 1 << 4
    MANAGE_GUILD          uint64 = 1 << 5
    ADD_REACTIONS         uint64 = 1 << 6
    VIEW_CHANNEL          uint64 = 1 << 10
    SEND_MESSAGES         uint64 = 1 << 11
    MANAGE_MESSAGES       uint64 = 1 << 13
    EMBED_LINKS           uint64 = 1 << 14
    ATTACH_FILES          uint64 = 1 << 15
    READ_MESSAGE_HISTORY  uint64 = 1 << 16
    MENTION_EVERYONE      uint64 = 1 << 17
    CONNECT               uint64 = 1 << 20   // voice
    SPEAK                 uint64 = 1 << 21
    MUTE_MEMBERS          uint64 = 1 << 22
    DEAFEN_MEMBERS        uint64 = 1 << 23
    MOVE_MEMBERS          uint64 = 1 << 24
)
```
Store as `uint64`/`bigint` in Postgres (`roles.permissions`, `channel_overwrites.allow/deny`).

### Roles
- Every guild has `@everyone` (id == guild_id) as the base role.
- Roles are **positionally ordered** (higher position wins on conflicts).
- Hoist (shown separately in sidebar), mentionable, color — cosmetic, but build
  them; the sidebar grouping in Phase 2 used them.

## 2. The resolution algorithm (the heart — get this exactly right)

Base permissions of a member in a guild:
```
perms = OR of all role.permissions the member has (incl. @everyone)
if ADMINISTRATOR in perms → perms = ALL
```

Effective permissions in a channel:
```
perms = base guild perms
overwrite_everyone = overwrites[role_id = @everyone]
    perms &= ~overwrite_everyone.deny
    perms |= overwrite_everyone.allow
for each role of the member (ascending position) with an overwrite:
    perms &= ~overwrite.deny ; perms |= overwrite.allow
member overwrite (if exists) — applied LAST, wins over roles:
    perms &= ~member_overwrite.deny ; perms |= member_overwrite.allow
```

Landmines (each one is a test case — see §5):
- Channel overwrites **stack across roles**: allow from one role + deny from
  another are *both* applied; order is deny-then-allow within the loop.
- A role positioned *higher* does NOT override a lower role's channel
  overwrite — position matters for role-vs-role management, NOT for overwrite
  application. (Common misconception; Discord's own docs are the tiebreaker.)
- ADMINISTRATOR bypasses everything (but can be *channel-overwritten*? NO —
  it cannot. Admin sees all. Test it.)
- Owner: implicitly all permissions, no role needed.

Implement as a pure function:
```go
func Resolve(base uint64, roles []Role, overwrites []Overwrite, userID int64) uint64
```
Pure = trivially table-testable = the test suite becomes the spec.

## 3. Enforcement points (defense in depth — the real lesson)

**Permission checks are NOT one function in one place.** They're a cross-cutting
contract enforced at multiple layers, each catching what the others miss:

| Layer | What it checks | What it catches |
|---|---|---|
| REST (Go) | Resolve() before *every* mutating route | The source of truth. Everything else is optimization/UX |
| REST field-level | e.g. ATTACH_FILES when attachments present, MENTION_EVERYONE for @everyone pings | Permission ≠ single flag per route; one route can need several |
| Gateway fan-out | Does this session's user still have VIEW_CHANNEL for this event's channel? | Permission *revoked between write and fan-out* (TOCTOU), private channels leaking via events |
| Gateway cache | Rebuild perms on GUILD_ROLE_UPDATE, MEMBER_ROLE_UPDATE events | Stale-cache enforcement — cache invalidation IS permission security |
| Client | Hide buttons it can't use | UX only. Trust nothing here |

The gateway fan-out check is the deep one: **the event bus delivers
MESSAGE_CREATE for channel C to the guild actor, which must filter per
subscriber's current view of C.** If you skip it: demote a user's role, and
they keep receiving private-channel events until cache refresh. Build the
attack, watch it work against a naive gateway, then fix it. That's the
Phase 4 chaos experiment.

## 4. Events (all flow through the normal fan-out path)

`GUILD_ROLE_CREATE/UPDATE/DELETE`, `GUILD_MEMBER_UPDATE` (role adds/removes,
nickname), plus the permission-relevant parts of `CHANNEL_UPDATE` (overwrite
changes). Order matters here more than anywhere else in the system: a role
delete arriving before the last permission check that used it = transient
wrong answer. Your seq/ordering machinery from Phase 1 is what makes this
safe. Notice this: *permissions are the first feature where event ordering is
a correctness requirement, not a UX nicety.* Note it in the postmortem.

## 5. The test matrix (gold — carry it forever)

Table-driven tests over Resolve():
- @everyone grants, member has it, no overwrites → grant
- @everyone grants, channel deny → revoke
- channel allow for @everyone → grant even without role
- two roles: one allow, one deny (applied together) → union logic per §2
- member overwrite denies what roles allow → member wins
- member overwrite allows what @everyone denies → member wins
- ADMINISTRATOR bypasses channel deny
- owner without roles → all
- permission absent everywhere → revoke
- revocation event flow: demote mid-session → next MESSAGE_CREATE for the
  restricted channel is not delivered (integration test through REST→bus→gateway)

Aim for 40+ cases. When Phase 7 refactorings break permissions (they will),
this suite is your parachute.

## 6. API surface

```
POST/PATCH/DELETE /guilds/:id/roles            (MANAGE_GUILD)
PUT/DELETE /guilds/:id/members/:uid/roles/:rid (permission to manage that
                                                 role position — learn the
                                                 hierarchical check: you can
                                                 only assign roles BELOW your
                                                 highest; Discord rule)
PUT /channels/:id/permissions/:target_id       (MANAGE_ROLES at channel scope —
  {type, allow, deny}                            yes, per-channel role granting
                                                 is a real Discord subtlety)
GET /guilds/:id/permissions/me (or in READY payload — client computes too,
  shared Resolve() ported to TS in the client. Same code, three languages:
  Go, Elixir (gateway cache), TS (client UI). Keep a JSON test-vector file
  that all three suites consume — cross-language golden tests. You'll thank
  yourself when they disagree.)
```

## 7. Phase 4 gate

- [ ] 40+ case matrix green in Go
- [ ] Same test vectors green in Elixir and TS (golden-file)
- [ ] TOCTOU chaos experiment: role revoked → private events stop within
      one cache-refresh event
- [ ] Hierarchy rules enforced (can't assign role above your own)

## 8. Reading
- Discord docs: "Permissions" + "Permission overwrites" (your spec)
- Discord API changelog history for permission bits (they've added ~15 bits
  over the years — the model's evolution is itself instructive)
