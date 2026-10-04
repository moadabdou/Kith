import { describe, expect, it } from 'vitest'
import type { TypingStartPayload } from '../types'
import { remainingMs, removeTyper, shouldSendTyping, typingDisplayName, typingIndicatorText } from './typing'

function typing(opts: Partial<TypingStartPayload> = {}): TypingStartPayload {
  return {
    channel_id: '1',
    user_id: '10',
    guild_id: '2',
    timestamp: Math.floor(Date.now() / 1000),
    ...opts,
  }
}

describe('Typing indicators (#39)', () => {
  it('typingIndicatorText renders Discord-style strings by typer count', () => {
    expect(typingIndicatorText([])).toBeNull()
    expect(typingIndicatorText(['Alice'])).toBe('Alice is typing…')
    expect(typingIndicatorText(['Alice', 'Bob'])).toBe('Alice and Bob are typing…')
    expect(typingIndicatorText(['Alice', 'Bob', 'Carol'])).toBe('Several people are typing…')
    expect(typingIndicatorText(['A', 'B', 'C', 'D'])).toBe('Several people are typing…')
  })

  it('typingDisplayName prefers nick, then username, then Someone', () => {
    expect(typingDisplayName(typing({ nick: 'Ali', user: { id: '10', username: 'alice', discriminator: '0001' } }))).toBe('Ali')
    expect(typingDisplayName(typing({ user: { id: '10', username: 'alice', discriminator: '0001' } }))).toBe('alice')
    expect(typingDisplayName(typing())).toBe('Someone')
  })

  it('shouldSendTyping throttles to one per 8s window', () => {
    expect(shouldSendTyping(undefined, 1_000)).toBe(true)
    expect(shouldSendTyping(1_000, 5_000)).toBe(false)
    expect(shouldSendTyping(1_000, 8_999)).toBe(false)
    expect(shouldSendTyping(1_000, 9_000)).toBe(true)
  })

  it('remainingMs derives from the payload timestamp, not arrival', () => {
    const now = 1_000_000
    const fresh = typing({ timestamp: Math.floor((now - 1_000) / 1000) })
    expect(remainingMs(fresh, now)).toBe(7_000)

    // Stale / replayed event: dead on arrival
    const stale = typing({ timestamp: Math.floor((now - 30_000) / 1000) })
    expect(remainingMs(stale, now)).toBe(0)

    // Clock skew tolerance: future timestamps clamp to the full TTL
    const future = typing({ timestamp: Math.floor((now + 5_000) / 1000) })
    expect(remainingMs(future, now)).toBe(8_000)
  })

  it('removeTyper drops user from Map and returns a new Map instance', () => {
    const initial = new Map([
      ['user-1', { name: 'Alice' }],
      ['user-2', { name: 'Bob' }],
    ])

    const updated = removeTyper(initial, 'user-1')
    expect(updated).not.toBe(initial)
    expect(updated.has('user-1')).toBe(false)
    expect(updated.has('user-2')).toBe(true)
    expect(updated.size).toBe(1)
  })

  it('removeTyper returns the identical Map reference if user is not present', () => {
    const initial = new Map([
      ['user-1', { name: 'Alice' }],
    ])

    const updated = removeTyper(initial, 'user-999')
    expect(updated).toBe(initial)
    expect(updated.size).toBe(1)
  })

  it('removeTyper safely handles empty Map', () => {
    const initial = new Map<string, any>()
    const updated = removeTyper(initial, 'user-1')
    expect(updated).toBe(initial)
    expect(updated.size).toBe(0)
  })
})
