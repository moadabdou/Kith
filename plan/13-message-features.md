# 13 — Rich Messaging & Interactive Primitives

> Phase 9. Where the raw messaging engine (Phase 3's ScyllaDB bucketing, Phase 8's
> media pipeline) meets full Discord UX parity: emoji reactions, inline replies
> with parent quoting, hover action toolbars, live inline edits/deletions, channel
> pins, mentions, and client markdown AST formatting.
>
> **Curriculum Structure**: Broken into 11 discrete engineering issues covering database
> schemas, event pipelines, gateway fanout, client UI state machines, chaos drills,
> and gate sign-off.

---

## 1. Architectural Overview & Workload Characteristics

In Phase 3 you built the high-throughput write path (ScyllaDB TWCS, 10-day buckets,
dual-write migration) and in Phase 8 you built CDN-cached attachments. But Discord's
actual message experience is social, dense, and interactive:

1. **Reactions**: High-frequency mutation vector. Unlike messages, reactions are not append-only
   chat logs; they are per-message sets with high churn (adds/removes) and aggregate count requirements.
   Writing a reaction cannot afford full-row rewrites or locking.
2. **Replies (`reply_to`)**: Lightweight threading. Preserves conversation context across channels
   with parent snippets, author notifications, and backward-history navigation.
3. **Interactive Actions & Inline Edits/Deletes**: Micro-interactions that make chat feel immediate.
   Fast hover toolbars, keyboard shortcuts (`e` to edit), `(edited)` indicators, and real-time
   synchronization across all connected clients via `MESSAGE_UPDATE` and `MESSAGE_DELETE`.
4. **Markdown & Spoilers**: Discord's text parser turns raw text into rich formatted content with
   code highlighting, blockquotes, and click-to-reveal spoilers.
5. **Channel Pins**: Pinned message index per channel, tracked by `last_pin_timestamp` and
   `CHANNEL_PINS_UPDATE`.

---

## 2. Issues Breakdown (Phase 9 Implementation Plan)

### Issue #1: `feat(db): ScyllaDB schema for message reactions, counters & MemoryStore fallback`
- **Context**: Reactions are high-churn mutations colocated with messages. In accordance with the Phase 3 `scylla_only` messaging topology and the Phase 8 `read-states` pattern, reactions are stored exclusively in **ScyllaDB** to eliminate Postgres vacuum pressure, lock contention, and table bloat.
- **Tasks**:
  - [x] Write ScyllaDB CQL migration `api/cql/003_create_reactions.cql` (commit `b1a3edb`)
  - [x] Implement `ReactionsStore` interface in `internal/messages/reactions_store.go`
  - [x] Implement `ScyllaReactionsStore` in `internal/messages/reactions_store_scylla.go` leveraging partition slice reads
  - [x] Implement `MemoryReactionsStore` in `internal/messages/reactions_store_memory.go` for fast, hermetic Go unit tests
  - [x] Add unit tests verifying idempotent adds, removals, multi-user tally aggregation, and `me: true/false` status
- **Verification**: Verified via `api/internal/messages/reactions_store_test.go` (`PASS`, 0 race conditions). Closed GitHub Issue #107.

---

### Issue #2: `feat(api): Reaction REST endpoints, ADD_REACTIONS permissions & NATS events`
- **Context**: Expose Discord-compatible reaction mutation and query endpoints with strict permission checks.
- **Tasks**:
  - [ ] Enforce permission `ADD_REACTIONS` (`1 << 6`) for new reaction types; allow reacting to existing emojis if `VIEW_CHANNEL` is held.
  - [ ] Implement handlers:
    - `PUT /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me`
    - `DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me`
    - `DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/{uid}` (requires `MANAGE_MESSAGES`)
    - `GET /api/channels/{cid}/messages/{mid}/reactions/{emoji}` (paginated users who reacted)
  - [ ] Publish `MESSAGE_REACTION_ADD` and `MESSAGE_REACTION_REMOVE` to NATS JetStream after commit.
  - [ ] Include reactions list in `GET /api/channels/{cid}/messages` response payload.
- **Verification**: REST tests for permission rejection, self-reaction removal, and 404 on nonexistent messages.

---

### Issue #3: `feat(gateway): Elixir gateway fan-out for MESSAGE_REACTION_* events`
- **Context**: Real-time reaction fanout across active sessions viewing the target channel.
- **Tasks**:
  - [ ] Ensure `MESSAGE_REACTION_ADD` and `MESSAGE_REACTION_REMOVE` payloads are dispatched through `Gateway.Guild.Actor` split lanes (`lane_family`).
  - [ ] Validate session permission cache filters private channel reactions from unauthorized sessions.
  - [ ] Support reaction event replay in `Gateway.Session` sequence buffer for reconnecting clients.
- **Verification**: Multi-session test: User A reacts $\rightarrow$ User B receives `MESSAGE_REACTION_ADD` with `{ channel_id, message_id, user_id, emoji }` within 50ms.

---

### Issue #4: `feat(client): Interactive emoji reaction picker & reaction pills UI`
- **Context**: Client UX for browsing and toggling reactions beneath messages.
- **Tasks**:
  - [ ] Build `ReactionPicker.tsx`: Lightweight popover with standard emojis (`👍`, `❤️`, `😂`, `🎉`, `🔥`, `🚀`, `👀`, `💯`) and search.
  - [ ] Build `ReactionPills.tsx`: Chip container under each message displaying `emoji`, `count`, and highlighted active border if reacted by current user.
  - [ ] Implement optimistic UI updates: clicking a pill toggles local count immediately and rolls back if the API request fails.
  - [ ] Gateway listener: Subscribe to `MESSAGE_REACTION_ADD/REMOVE` in `useGateway` and update `messages` state in place.
- **Verification**: Clicking reaction updates pill without flickering; external reactions appear in real-time.

---

### Issue #5: `feat(messages): Inline replies & message references in backend storage`
- **Context**: Allow messages to reference parent messages (`reply_to`), preserving context and quoting.
- **Tasks**:
  - [ ] Update `Message` struct:
    ```go
    type Message struct {
        // ... existing fields ...
        Type            int16           `json:"type"` // 0 = DEFAULT, 19 = REPLY
        ReplyTo         *string         `json:"reply_to,omitempty"`
        ReferencedMsg   *ReferencedMsg  `json:"referenced_message,omitempty"`
    }
    type ReferencedMsg struct {
        ID       string    `json:"id"`
        Author   AuthorRef `json:"author"`
        Content  string    `json:"content"`
    }
    ```
  - [ ] Support `message_reference: { message_id }` in `POST /api/channels/{cid}/messages`.
  - [ ] Validate referenced message exists and belongs to the same channel.
  - [ ] Populate parent author and snippet in `MESSAGE_CREATE` event and message list queries.
- **Verification**: Sending a reply links to parent; returns HTTP 400 if `message_reference` points to another channel.

---

### Issue #6: `feat(client): Reply composer, quote thread rendering & jump-to-source navigation`
- **Context**: Rich reply UX in the chat window.
- **Tasks**:
  - [ ] Build `ReplyBar.tsx`: Render banner above `MessageInput` showing *"Replying to @username"* with an `✕` cancel button.
  - [ ] Build `ParentQuote.tsx`: Curved SVG line connector connecting parent snippet to the reply card.
  - [ ] Jump navigation: Clicking the referenced snippet smoothly scrolls to `#msg-{reply_to}` and triggers a temporary pulse highlight animation.
  - [ ] If parent message is outside current view window, fetch history around that ID or load older messages.
- **Verification**: Clicking reply on hover bar enters reply mode; sending message renders quote; clicking quote jumps to parent.

---

### Issue #7: `feat(client): Message hover action toolbar & inline edit/delete parity`
- **Context**: Complete interactive message management matching Discord desktop.
- **Tasks**:
  - [ ] Build `MessageToolbar.tsx`: Floating action toolbar appearing on message row hover:
    - Quick reaction buttons (`👍`, `❤️`, `🔥`) + "Add Reaction" icon.
    - "Reply" button.
    - "Edit" button (visible if current user is author and `< 15m`).
    - "Delete" button (visible if author or user holds `MANAGE_MESSAGES`).
    - "Pin" button (visible if user holds `MANAGE_MESSAGES`).
  - [ ] Inline editing in `ChatArea.tsx`:
    - Keyboard shortcut `e` on hovered message activates edit mode.
    - Message text transforms into an inline input with "escape to cancel • enter to save".
    - Calls `PATCH /api/channels/{cid}/messages/{mid}`.
    - Displays `(edited)` tag next to timestamp when `edited_timestamp != null`.
  - [ ] Delete modal: Confirmation dialog before issuing `DELETE /api/channels/{cid}/messages/{mid}`.
- **Verification**: Inline edit updates content across clients; deleted messages vanish immediately.

---

### Issue #8: `feat(markdown): Discord-flavor AST markdown parser & spoiler tags`
- **Context**: Replace plain text message rendering with a fast, safe AST parser.
- **Tasks**:
  - [ ] Implement AST parser in `client/src/lib/markdown.tsx`:
    - `**bold**` $\rightarrow$ `<strong>`
    - `*italic*` or `_italic_` $\rightarrow$ `<em>`
    - `~~strike~~` $\rightarrow$ `<del>`
    - `__underline__` $\rightarrow$ `<u>`
    - `` `inline code` `` $\rightarrow$ `<code className="inline-code">`
    - ```` ```lang\ncode\n``` ```` $\rightarrow$ `<pre><code className="code-block">`
    - `> quote` $\rightarrow$ `<blockquote>`
    - `||spoiler||` $\rightarrow$ `<span className="spoiler-blur" onClick={toggle}>`
    - URL auto-linking with safe `rel="noreferrer noopener"`
  - [ ] Parse user mentions (`<@id>`) and role mentions (`<@&id>`) into interactive colored mention badges.
  - [ ] Highlight message row with amber background if message mentions `@me`, `@everyone`, or user's roles.
- **Verification**: Golden markdown test suite passes; clicking spoilers reveals hidden content; code blocks preserve whitespace.

---

### Issue #9: `feat(pins): Channel pinned messages API & client slide-over panel`
- **Context**: Persistent pinned messages per channel for announcements and references.
- **Tasks**:
  - [ ] Add `pinned boolean DEFAULT false` column to Postgres and ScyllaDB messages tables.
  - [ ] Implement endpoints:
    - `PUT /api/channels/{cid}/pins/{mid}` (enforces `MANAGE_MESSAGES`)
    - `DELETE /api/channels/{cid}/pins/{mid}` (enforces `MANAGE_MESSAGES`)
    - `GET /api/channels/{cid}/pins` (returns up to 50 pinned messages)
  - [ ] Emit `CHANNEL_PINS_UPDATE` event with `{ channel_id, last_pin_timestamp }`.
  - [ ] Build `PinnedMessagesDrawer.tsx`: Header pin icon toggles drawer with list of pinned messages and "Jump to Message" buttons.
- **Verification**: Pinning message adds it to drawer; unpinning removes it; non-moderators cannot pin/unpin.

---

### Issue #10: `feat(emojis): Guild custom emojis & stickers pipeline with cross-server member usage`
- **Context**: Allow guild moderators to upload custom emojis and stickers. Following Kith's "No Nitro paywall" policy, any user can use their joined guilds' custom emojis and stickers anywhere across Kith, provided they hold `USE_EXTERNAL_EMOJIS` (bit `1 << 18`, default on).
- **Tasks**:
  - [ ] Add PostgreSQL migration `000007_create_guild_emojis_stickers.up.sql`:
    ```sql
    CREATE TABLE guild_emojis (
        id BIGINT PRIMARY KEY,
        guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        name VARCHAR(32) NOT NULL,
        uploader_id BIGINT NOT NULL REFERENCES users(id),
        animated BOOLEAN NOT NULL DEFAULT FALSE,
        content_type VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_guild_emojis_guild ON guild_emojis(guild_id);

    CREATE TABLE guild_stickers (
        id BIGINT PRIMARY KEY,
        guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        name VARCHAR(32) NOT NULL,
        description VARCHAR(100),
        uploader_id BIGINT NOT NULL REFERENCES users(id),
        content_type VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_guild_stickers_guild ON guild_stickers(guild_id);
    ```
  - [ ] Integrate with Phase 8 media pipeline: Store assets in MinIO at `emojis/{id}.png` and `stickers/{id}.png`, served via Caddy CDN.
  - [ ] Implement REST endpoints:
    - `GET /api/guilds/{id}/emojis`
    - `POST /api/guilds/{id}/emojis` (requires `MANAGE_GUILD` or admin)
    - `DELETE /api/guilds/{id}/emojis/{emoji_id}`
    - `GET /api/guilds/{id}/stickers`
    - `POST /api/guilds/{id}/stickers` (requires `MANAGE_GUILD`)
    - `DELETE /api/guilds/{id}/stickers/{sticker_id}`
  - [ ] Cross-server authorization: Validate that the sender is a member of the emoji/sticker's owning guild when posting `<:name:id>` or sending sticker IDs.
  - [ ] Emit `GUILD_EMOJIS_UPDATE` and `GUILD_STICKERS_UPDATE` over NATS and gateway.
  - [ ] Client UI: Update `ReactionPicker` and `MessageInput` emoji/sticker popover to list custom emojis grouped by server with server icons.
- **Verification**: Moderator can upload emoji; member can use it in a completely different guild; non-members cannot spoof external emojis.

---

### Issue #11: `chaos(messages): Reaction storm drill & concurrent reply/delete race tests`
- **Context**: Push the reaction and reply paths under high concurrency and failure injection.
- **Tasks**:
  - [ ] Write `scripts/chaos/phase9_reaction_storm.js`:
    - 50 simulated WebSocket sessions concurrently reacting/unreacting to a single message at 500 requests/sec.
    - Inject 10% simulated network packet drop via toxiproxy / netem.
    - Assert that final aggregate counts match `SELECT count(*) FROM message_reactions` with zero drift.
  - [ ] Write race test: Client A sends a reply referencing message X while Client B deletes message X simultaneously. Verify API returns clean error or handles ghost parent gracefully without crashing.
- **Verification**: Zero count divergence in database; gateway memory remains bounded during the storm.

---

### Issue #12: `postmortem(phase-9): Gate sign-off & architecture write-up`
- **Context**: Complete all gate verifications and document findings.
- **Tasks**:
  - [ ] Verify all 7 Phase 9 gates are green.
  - [ ] Write `postmortems/phase-9.md`:
    - Compare Kith's reaction storage vs Discord's Cassandra/Scylla set columns vs separate tables.
    - Document lessons from optimistic UI state reconciliation during gateway reconnection.
    - Measure p99 write latency for reactions vs plain messages.
    - Document cross-server emoji permission evaluation cost.
- **Verification**: Postmortem committed and all checklist boxes ticked.

---

## 3. Phase 9 Gates

- [ ] **Gate 1**: Reaction add/remove latency p99 < 15ms locally; optimistic UI updates without layout jumps; multi-user aggregation passes without drift.
- [ ] **Gate 2**: Inline replies quote parent author and content snippet; clicking jump scrolls and highlights target message.
- [ ] **Gate 3**: Hover action toolbar provides instant access to Reactions, Reply, Edit, Pin, and Delete; 15-minute edit window is enforced.
- [ ] **Gate 4**: Markdown AST parser renders bold, italic, code blocks, blockquotes, and click-to-reveal spoilers correctly without XSS vulnerabilities.
- [ ] **Gate 5**: Channel pinned messages drawer displays pins and updates live on `CHANNEL_PINS_UPDATE`.
- [ ] **Gate 6 (Chaos)**: Reaction storm drill (50 clients @ 500 req/s under 10% packet drop) completes with zero tally divergence.
- [ ] **Gate 7 (Custom Emojis & Stickers)**: Guild custom emojis and stickers upload successfully; members can use them across any channel where they have `USE_EXTERNAL_EMOJIS`; non-members are rejected.
