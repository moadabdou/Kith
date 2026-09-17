# Phase 4 Postmortem: Roles, Permissions & Real-Time TOCTOU Defense

- **Phase:** Phase 4 — Roles & Permissions (`plan/11-roadmap.md`, `plan/06-permissions.md`)
- **Execution Period:** Week 11–12
- **Closing Milestone Issue:** [#67](https://github.com/moadabdou/Kith/issues/67)

---

## 1. What Surprised Me

### 1.1 Bitfield Stacking vs. Role Position (The Fallacy of Role Hierarchy in Permissions)
Before diving deep into Discord's access control specification, intuition suggested that **Role Position** acted as a priority rank for permissions: that a higher-positioned role's permissions would override or veto a lower-positioned role's permissions.

The mathematical reality is completely different:
1. **Server-Level Roles are Pure Additive Bitfield Unions:**
   At the server level, roles **only grant**; they cannot deny. Every custom role held by a member is bitwise OR'd together:
   $$\text{base\_permissions} = \text{perms}(@\text{everyone}) \cup \bigcup_{r \in \text{roles}} \text{perms}(r)$$
   Position plays **zero role** in calculating whether a member has a permission at the guild level.
2. **Channel Role Overwrites: Allow Strictly Dominates Deny:**
   At the channel overwrite level, when a user holds multiple custom roles with competing channel overwrites (e.g., Role A denies `SEND_MESSAGES` but Role B allows `SEND_MESSAGES`), position is once again **completely ignored**. All role denials are aggregated, all role allows are aggregated, and the allow set strictly overrides the deny set:
   $$\text{role\_denies} = \bigcup_{r \in \text{roles}} \text{deny}(r), \quad \text{role\_allows} = \bigcup_{r \in \text{roles}} \text{allow}(r)$$
   $$\text{perms} = (\text{perms} \setminus \text{role\_denies}) \cup \text{role\_allows}$$
3. **Where Position Actually Matters:**
   Role hierarchy is exclusively an **administrative authorization barrier**:
   - A user holding `MANAGE_ROLES` can only create, modify, assign, or delete roles strictly *below* their own highest role.
   - Moderation actions (`KICK_MEMBERS`, `BAN_MEMBERS`) can only target members whose highest role is strictly *below* the caller's highest role.
   - Member name colors in the sidebar and chat take the color of the member's highest positioned role that has a non-default color.

Decoupling administrative hierarchy from bitfield resolution was the first major architectural clarity gained in Phase 4.

---

### 1.2 Event Ordering as a Hard Correctness Requirement
In Phases 1 through 3, event ordering was primarily a user experience consideration: an out-of-order message or presence update resulted in minor visual flicker or a jumpy scrollbar, which was quickly corrected by the next sequence number.

In Phase 4, **event ordering became a strict security correctness requirement**:
- Consider a scenario where a user is stripped of a sensitive role (`GUILD_MEMBER_UPDATE`) while messages are actively streaming into a restricted channel (`MESSAGE_CREATE`).
- If the event bus or WebSocket gateway delivers `MESSAGE_CREATE` frames out-of-order before the `GUILD_MEMBER_UPDATE` cache invalidation is processed, the unauthorized client receives private events intended only for privileged eyes.
- Similarly, if `GUILD_ROLE_DELETE` arrives after a new permission check that attempted to resolve against that role, transient access violations occur.

The monotonic sequence number protocol (`seq`) and the per-guild GenServer actor serialization established in Phase 1 proved to be the foundational security boundary that made real-time permission revocation possible.

---

### 1.3 Synthetic Lifecycle Transitions (`CHANNEL_CREATE` & `CHANNEL_DELETE` vs. `CHANNEL_UPDATE`)
In a naive gateway design, when an administrator edits channel permissions or role assignments, the gateway simply broadcasts `CHANNEL_UPDATE` or `GUILD_ROLE_UPDATE` to all connected clients.

In Discord's architecture, this is fundamentally broken for two reasons:
1. **Information Leakage:** Broadcasting a `CHANNEL_UPDATE` containing private channel metadata to a user who doesn't have `VIEW_CHANNEL` leaks the existence, name, topic, and permission overwrites of secret channels.
2. **Client State Desync:** If a user loses access to a channel, the channel must disappear from their sidebar. A standard `CHANNEL_UPDATE` payload does not inform the client to delete the channel from its local collection.

To solve this, the Gateway Guild Actor (`Gateway.Guild.Actor`) maintains an in-memory set of visible channel IDs for each connected subscriber session (`%{pid: pid, user_id: user_id, channels: MapSet.new([...])}`). When any permission mutation occurs (`CHANNEL_UPDATE`, `GUILD_MEMBER_UPDATE`, `GUILD_ROLE_UPDATE`, `GUILD_ROLE_DELETE`):
- **Access Revocation ($\Delta V_c < 0$):** The gateway intercepts the mutation and dispatches a **synthetic `CHANNEL_DELETE`** frame directly to the demoted subscriber's WebSocket session, removing the channel from their client immediately.
- **Access Grant ($\Delta V_c > 0$):** The gateway synthesizes a **full `CHANNEL_CREATE`** frame containing complete channel metadata and overwrites, allowing the client to mount the channel seamlessly.
- **Access Maintained:** The subscriber receives the standard `CHANNEL_UPDATE` payload.
- **Denied Before & After:** The event is completely suppressed, leaking zero bytes.

---

### 1.4 The Asymmetric 3-State Model (Server Roles vs. Channel Overwrites)
Another major revelation was designing the client UI for permission management. Discord employs an asymmetric permission structure:
- **Server Level (2-State):** Permissions are boolean switches (Grant or Do Not Grant). There is no explicit "Deny" at the server level.
- **Channel Level (3-State Overwrites):** Overwrites operate on a ternary logic model:
  - **`✓` Allow:** Explicitly grants the permission in this channel, overriding server-level omissions and role denials.
  - **`/` Inherit (Neutral):** Defers to server-level base permissions or lower-tier overwrites.
  - **`✕` Deny:** Explicitly revokes the permission in this channel, overriding base server permissions.

Users frequently expect to "deny" a role from sending messages at the server level. In Discord's architecture, the canonical pattern is:
1. Revoke `SEND_MESSAGES` from `@everyone` at the channel level (Deny `✕`).
2. Grant `SEND_MESSAGES` to trusted roles (Allow `✓`).

Designing the [ChannelSettingsModal.tsx](../client/src/components/modals/ChannelSettingsModal.tsx) with clear 3-state segmented buttons (`✕` Red, `/` Grey, `✓` Green) and an unsaved changes floating dock resolved user ambiguity and matched Discord's desktop application exactly.

---

### 1.5 The TOCTOU Mid-Burst Race Window (Why Point-in-Time Pre-Checks Fail)
A classic vulnerability in collaborative real-time systems is Time-Of-Check to Time-Of-Use (TOCTOU):
- An authorized user initiates an action or subscribes to a channel stream.
- An administrator demotes the user's role.
- If permission checks only occur at connection handshake or HTTP route entry, the in-flight WebSocket stream continues delivering restricted events indefinitely until the user manually disconnects.

Our Phase 4 chaos experiment ([docs/chaos-phase4.md](../docs/chaos-phase4.md)) simulated a high-concurrency burst where an admin fired a role revocation request while 5 rapid messages were in-flight. The gateway's ETS cache invalidation and subscriber channel-filtering severed delivery at message #1, preventing the remaining 4 messages from reaching the target while delivering 100% of messages to authorized bystanders.

---

## 2. What Discord Did Differently

### 2.1 Distributed Permission Cache (C++ Read-States & Rust Core vs. Erlang ETS)
- **Discord:** Discord operates at a scale of 200M+ active users. In Discord's architecture:
  - The Gateway is implemented in Elixir, but hot permission evaluation and read-state management were migrated into high-performance **Rust and C++ microservices** connected via gRPC and shared memory.
  - Guild state is distributed across multi-node clusters using a consistent hash ring. Cache invalidation on role changes utilizes a distributed broadcast tree to invalidate permissions across tens of thousands of gateway connections in sub-millisecond windows.
- **Kith:** Kith implements the complete Discord permission algorithm natively across three runtimes:
  - **Go:** In the REST API, using optimized 64-bit unsigned integer bitmasks (`api/pkg/permissions/permissions.go`).
  - **Elixir:** In the Gateway, utilizing concurrent in-memory ETS tables (`:gateway_guild_cache`) with read-concurrency enabled.
  - **TypeScript:** In the React client, computing permissions client-side using native BigInt arithmetic for reactive UI gating.

---

### 2.2 Permissions V2 & Schema Evolution
- **Discord:** Discord's permission system started with a 32-bit integer bitfield in 2015. Over 8+ years, they exhausted 32 bits and migrated to 64-bit integer strings in JSON (to prevent JavaScript 53-bit float precision loss). They introduced:
  - **Application Command Permissions:** Scoped permissions for bots and slash commands.
  - **Thread Permissions:** Hierarchical inheritance where threads inherit from parent channels with additional private thread access controls.
  - **Integration Roles:** Managed roles created automatically by OAuth2 integrations and bots (e.g. Patreon, Twitch subscribers).
- **Kith:** Kith implements the core 29 Discord permissions up through `MANAGE_EVENTS` (Bit 33), serializing bitmasks as decimal strings across REST and Gateway JSON frames to avoid JavaScript IEEE-754 precision clipping.

---

### 2.3 Guild Actor Concurrency & Thread-Per-Guild Serialization
- **Discord:** Discord runs one Elixir GenServer process per active guild (*"Guild Worker"*). All state mutations for a guild (channel creations, role updates, member joins) flow through that single process mailbox, guaranteeing absolute sequential consistency without distributed locking.
- **Kith:** Kith adopts Discord's exact Guild Actor model:
  - `Gateway.Guild.Actor` is spawned per guild upon subscriber connection.
  - NATS JetStream consumer delivers all events partitioned by `guild_id`.
  - Subscriber visibility sets and ETS cache updates are processed strictly sequentially within the actor, making race conditions impossible.

---

## 3. What I'd Do Next Time

1. **Unify Wire Key Schemas Upfront (`target_id` vs `id`, `target_type` vs `type`):**
   In early iterations, the Go relational schema used `target_id` and `target_type` for channel overwrites, while Discord's public gateway API uses `id` and `type`. Supporting both required normalization shims across Elixir cache handlers and TypeScript interfaces. Establishing unified naming from day one eliminates translation layers.

2. **Automate Golden Test Vector Generation:**
   Our cross-language golden test suite ([testvectors/permissions_vectors.json](../testvectors/permissions_vectors.json)) contains 45 exhaustive test cases consumed identically by Go, Elixir, and TypeScript. In the future, I would build an automated property-based test generator (e.g. using QuickCheck / rapid) that synthesizes thousands of random permutations of roles, overwrites, and bitmasks to detect obscure boundary edge cases.

3. **Formalize Synthetic Gateway Dispatch Abstractions:**
   The logic for synthesizing `CHANNEL_CREATE` and `CHANNEL_DELETE` frames was initially spread across `handle_channel_update_dispatch`, `handle_guild_member_update_dispatch`, and `handle_guild_role_change_dispatch`. Refactoring this into a centralized `Gateway.Guild.Lifecycle` module with a clean state diffing pipeline ($\Delta(\text{old\_visible}, \text{new\_visible})$) makes adding future entity types (e.g. Threads, Voice channels) cleaner.

---

## 4. Chaos & Benchmark Evidence

The Phase 4 TOCTOU Chaos Drill was conducted using [`scripts/chaos/phase4_toctou.sh`](../scripts/chaos/phase4_toctou.sh). The full report is documented in [`docs/chaos-phase4.md`](../docs/chaos-phase4.md).

### Invariants Verified:

| Drill | Scenario | Invariant Tested | Outcome | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Drill 1** | High-Concurrency Burst Race | Zero TOCTOU Leak | **PASS** | Target cut off at msg #1; 0 leaked messages; bystander received 5/5. |
| **Drill 2** | Real-Time Sidebar Transitions | Dynamic `CHANNEL_CREATE` | **PASS** | Target received synthetic `CHANNEL_CREATE` with full overwrite array within 800ms. |
| **Drill 3a** | Member Overwrite Deny | Direct User Isolation | **PASS** | Synthetic `CHANNEL_DELETE` delivered; messages blocked; restored upon clearing. |
| **Drill 3b** | Role Overwrite Mutation | Multi-Session Invalidation | **PASS** | Both User A and User B received synthetic `CHANNEL_DELETE`; restored on allow. |
| **Drill 3c** | Ephemeral Role Deletion | Cascading Role Revocation | **PASS** | Role deletion via REST immediately triggered synthetic `CHANNEL_DELETE`. |
| **Drill 4** | Disconnect, Revoke & RESUME | Replay Ring Buffer Isolation | **PASS** | 0 private messages leaked during Opcode 6 `RESUME` replay ring buffer sweep. |
| **Drill 5** | Inbound Typing Flood | Unauthorized Input Dropping | **PASS** | Unauthorized `TYPING_START` dropped; 0 events leaked; WebSocket stayed alive. |

---

## 5. Phase 4 Gate Checklist Sign-Off

The four mandatory acceptance gates defined in `plan/06-permissions.md` §7 and `plan/11-roadmap.md` are formally verified:

| Gate Criterion | Verification Method | Status | Sign-off Date |
| :--- | :--- | :---: | :--- |
| **1. 40+ case matrix green in Go** | `api/pkg/permissions/permissions_test.go` (45/45 golden vectors pass) | **VERIFIED** | 2026-09-17 |
| **2. Same test vectors green in Elixir & TS** | `client/src/lib/permissions.test.ts` (45/45 pass) & `gateway/test/gateway/permissions_test.exs` | **VERIFIED** | 2026-09-17 |
| **3. TOCTOU chaos experiment green** | 5/5 drills passed in `docs/chaos-phase4.md` via `scripts/chaos/phase4_toctou.sh` | **VERIFIED** | 2026-09-17 |
| **4. Hierarchy rules enforced** | Go API `service.go` (`UpdateRole`, `AssignRole`) + Client UI hierarchy locks | **VERIFIED** | 2026-09-17 |

**Phase 4 — Roles & Permissions is officially complete.**
