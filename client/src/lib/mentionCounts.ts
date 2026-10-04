/**
 * Unread mention counting for channel badges (Issue #122).
 *
 * Pure helpers so the counting policy is unit-testable without React.
 * Matching precedence per message:
 *  1. Server-authoritative fields from #121 (`mentions`, `mention_roles`,
 *     `mention_everyone`) — a match here always counts.
 *  2. Legacy content fallback (`isMessageMentioningUser`) — only when the
 *     server fields are absent or undecided. Note: a post-#121 message whose
 *     content carries mention syntax the server stripped (e.g. a
 *     non-mentionable role) omits the fields via `omitempty` and is
 *     indistinguishable from a pre-#121 message, so it may over-count by one
 *     badge. Harmless (clears on read) and self-heals as new messages arrive.
 */
import type { Message } from '../types'
import { isMessageMentioningUser } from './mentions'

export interface MentionIdentity {
  userId: string
  roleIds: string[]
}

export interface MentionCountState {
  /** channel_id -> outstanding unread mention count */
  counts: Record<string, number>
  /** channel_id -> id of the first (earliest) unread mention, for jump targeting */
  firstIds: Record<string, string>
}

export const EMPTY_MENTION_STATE: MentionCountState = { counts: {}, firstIds: {} }

/** Snowflake-aware newer-than comparison with lexicographic fallback. */
export function isIdNewer(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return a > b
  }
}

function serverFieldsPresent(msg: Message): boolean {
  return (
    msg.mentions !== undefined ||
    msg.mention_roles !== undefined ||
    msg.mention_everyone !== undefined
  )
}

/**
 * Whether an incoming message mentions the given identity and should feed
 * the unread-mention badge. Never counts the user's own messages.
 */
export function messageMentionsUser(
  msg: Pick<Message, 'author' | 'content' | 'mentions' | 'mention_roles' | 'mention_everyone'>,
  identity: MentionIdentity,
): boolean {
  if (!identity.userId) return false
  if (msg.author?.id != null && String(msg.author.id) === String(identity.userId)) return false

  // 1. Server-authoritative verdict (#121).
  if (msg.mention_everyone) return true
  if (msg.mentions?.some((id) => String(id) === String(identity.userId))) return true
  if (
    msg.mention_roles &&
    msg.mention_roles.length > 0 &&
    identity.roleIds.some((r) => msg.mention_roles?.some((m) => String(m) === String(r)))
  ) {
    return true
  }

  // 2. Legacy fallback — only when the server expressed no opinion.
  if (!serverFieldsPresent(msg as Message)) {
    return isMessageMentioningUser(msg.content, identity.userId, identity.roleIds)
  }
  return false
}

/**
 * Fold one incoming message id into the badge state: increments the count
 * and records the first (earliest) mention id for jump targeting.
 */
export function applyIncomingMention(
  state: MentionCountState,
  channelId: string,
  messageId: string,
): MentionCountState {
  return {
    counts: { ...state.counts, [channelId]: (state.counts[channelId] ?? 0) + 1 },
    firstIds: state.firstIds[channelId]
      ? state.firstIds
      : { ...state.firstIds, [channelId]: messageId },
  }
}

/** Drop a channel from badge state (read / acked / selected). */
export function clearChannelMentions(
  state: MentionCountState,
  channelId: string,
): MentionCountState {
  if (state.counts[channelId] === undefined && state.firstIds[channelId] === undefined) {
    return state
  }
  const counts = { ...state.counts }
  const firstIds = { ...state.firstIds }
  delete counts[channelId]
  delete firstIds[channelId]
  return { counts, firstIds }
}

/**
 * Merge server hydration (`mention_count` per channel) with live state.
 * Max-wins per channel so a stale hydration response never regresses a
 * newer live count — and server-side counts (once the read-states service
 * computes them) flow through with zero client changes.
 */
export function hydrateMentionCounts(
  prev: MentionCountState,
  server: Array<{ channel_id: string; mention_count: number }>,
): MentionCountState {
  let changed = false
  const counts = { ...prev.counts }
  for (const s of server) {
    if (!s.channel_id) continue
    const serverCount = Math.max(0, s.mention_count ?? 0)
    if (serverCount > (counts[s.channel_id] ?? 0)) {
      counts[s.channel_id] = serverCount
      changed = true
    }
  }
  if (!changed) return prev
  return { counts, firstIds: prev.firstIds }
}
