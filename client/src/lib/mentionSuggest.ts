/**
 * Mention autocomplete suggestions for the message composer (Issue #123).
 *
 * Pure helpers, unit-tested without DOM:
 * - extractMentionQuery: finds an @-trigger at a word boundary in the text
 *   before the caret (emails and mid-word @ never trigger).
 * - rankSuggestions: prefix-matches members (nick first, then username) and
 *   mentionable roles, plus @everyone/@here when broadcast is allowed.
 * - cycleIndex: pure arrow-key index arithmetic for the popover.
 */

export type MentionSuggestion =
  | { kind: 'user'; id: string; label: string; sub?: string }
  | { kind: 'role'; id: string; label: string; sub?: string }
  | { kind: 'everyone'; id: 'everyone'; label: string }
  | { kind: 'here'; id: 'here'; label: string }

export interface SuggestMember {
  id: string
  username: string
  nick?: string | null
}

export interface SuggestRole {
  id: string
  name: string
  mentionable: boolean
}

export const MAX_MENTION_SUGGESTIONS = 8

// @query at a word boundary: start-of-input or preceded by whitespace.
// Capped so runaway typing doesn't scan unbounded text.
const MENTION_QUERY_REGEX = /(?:^|\s)@([A-Za-z0-9_]{0,32})$/

/**
 * Extracts the mention query from text before the caret. Returns null when
 * the caret is not inside an @-trigger (including mid-word @ like emails).
 */
export function extractMentionQuery(textBeforeCaret: string): string | null {
  if (!textBeforeCaret) return null
  const match = MENTION_QUERY_REGEX.exec(textBeforeCaret)
  if (!match) return null
  return match[1].toLowerCase()
}

function startsWith(haystack: string, needle: string): boolean {
  return needle.length === 0 || haystack.toLowerCase().startsWith(needle)
}

/**
 * Ranks mention suggestions for a query. Users before roles before
 * broadcast; within users, nick matches outrank username matches.
 */
export function rankSuggestions(
  query: string,
  members: SuggestMember[],
  roles: SuggestRole[],
  canBroadcast: boolean,
): MentionSuggestion[] {
  const q = (query ?? '').toLowerCase()
  const out: MentionSuggestion[] = []

  const nickHits: MentionSuggestion[] = []
  const userHits: MentionSuggestion[] = []
  const seen = new Set<string>()
  for (const m of members) {
    if (!m?.id || seen.has(m.id)) continue
    const nick = m.nick ?? ''
    if (nick && startsWith(nick, q)) {
      seen.add(m.id)
      nickHits.push({ kind: 'user', id: m.id, label: `@${nick}`, sub: m.username })
    } else if (startsWith(m.username ?? '', q)) {
      seen.add(m.id)
      userHits.push({ kind: 'user', id: m.id, label: `@${m.username}`, sub: nick || undefined })
    }
  }
  out.push(...nickHits, ...userHits)

  for (const r of roles) {
    if (!r?.mentionable || !r.id) continue
    if (startsWith(r.name ?? '', q)) {
      out.push({ kind: 'role', id: r.id, label: `@${r.name}`, sub: 'Role' })
    }
    if (out.length >= MAX_MENTION_SUGGESTIONS) break
  }

  if (canBroadcast && out.length < MAX_MENTION_SUGGESTIONS) {
    if (startsWith('everyone', q)) out.push({ kind: 'everyone', id: 'everyone', label: '@everyone' })
    if (out.length < MAX_MENTION_SUGGESTIONS && startsWith('here', q)) {
      out.push({ kind: 'here', id: 'here', label: '@here' })
    }
  }

  return out.slice(0, MAX_MENTION_SUGGESTIONS)
}

/** Arrow-key index cycling for the popover list. */
export function cycleIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0
  return (current + delta + length) % length
}

/** Wire syntax inserted into message content for a suggestion. */
export function suggestionSyntax(s: MentionSuggestion): string {
  switch (s.kind) {
    case 'user':
      return `<@${s.id}>`
    case 'role':
      return `<@&${s.id}>`
    case 'everyone':
      return '@everyone'
    case 'here':
      return '@here'
  }
}

/** Plain-text label shown in the composer for an accepted suggestion. */
export function suggestionInsertText(s: MentionSuggestion): string {
  return s.label
}

export interface MentionChunk {
  text: string
  mention?: { kind: 'user' | 'role'; id: string; raw: string }
}

const mentionChunkRegex = /<@!?([0-9]+)>|<@&([0-9]+)>/g

/**
 * Splits text into mention/non-mention chunks for the composer renderer.
 * Pure and unit-tested; MessageInput consumes it for DOM rendering.
 */
export function splitMentionChunks(text: string): MentionChunk[] {
  const chunks: MentionChunk[] = []
  if (!text) return chunks
  mentionChunkRegex.lastIndex = 0
  let mMatch: RegExpExecArray | null
  let mLast = 0
  while ((mMatch = mentionChunkRegex.exec(text)) !== null) {
    if (mMatch.index > mLast) {
      chunks.push({ text: text.slice(mLast, mMatch.index) })
    }
    chunks.push({
      text: '',
      mention:
        mMatch[1] !== undefined
          ? { kind: 'user', id: mMatch[1], raw: mMatch[0] }
          : { kind: 'role', id: mMatch[2], raw: mMatch[0] },
    })
    mLast = mentionChunkRegex.lastIndex
  }
  if (mLast < text.length) chunks.push({ text: text.slice(mLast) })
  return chunks
}
