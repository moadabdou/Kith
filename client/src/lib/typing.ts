import type { TypingStartPayload } from '../types'

/** Indicator lifetime — the self-healing window (plan/05 §2). */
export const TYPING_TTL_MS = 8_000

/**
 * Whether an outgoing typing trigger should be sent given the last send time.
 * Client mirror of the gateway's per-(user, channel) cooldown.
 */
export function shouldSendTyping(lastSentAt: number | undefined, now: number): boolean {
  if (lastSentAt === undefined) return true
  return now - lastSentAt >= TYPING_TTL_MS
}

/** Display name from a TYPING_START payload: nick || username || 'Someone'. */
export function typingDisplayName(payload: TypingStartPayload): string {
  return payload.nick || payload.user?.username || 'Someone'
}

/**
 * Remaining indicator lifetime in ms, derived from the payload's server
 * timestamp (unix seconds) — never from arrival time. A replayed or stale
 * event is dead on arrival (0), which is what makes replayed typing harmless.
 */
export function remainingMs(payload: TypingStartPayload, nowMs: number = Date.now()): number {
  const eventMs = payload.timestamp * 1000
  const remaining = TYPING_TTL_MS - (nowMs - eventMs)
  return Math.max(0, Math.min(TYPING_TTL_MS, remaining))
}

/**
 * Indicator text, Discord-style:
 * 1 typer  -> "Alice is typing…"
 * 2 typers -> "Alice and Bob are typing…"
 * 3+       -> "Several people are typing…"
 */
export function typingIndicatorText(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}
