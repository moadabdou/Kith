import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import {
  applyIncomingMention,
  clearChannelMentions,
  EMPTY_MENTION_STATE,
  hydrateMentionCounts,
  isIdNewer,
  messageMentionsUser,
  type MentionCountState,
} from './mentionCounts'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: '1',
    channel_id: '10',
    author: { id: '99', username: 'bob', discriminator: '0001' },
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

const ME = { userId: '7', roleIds: ['r1', 'r2'] }

describe('messageMentionsUser (#122)', () => {
  it('matches server user mentions', () => {
    expect(messageMentionsUser(msg({ mentions: ['7'] }), ME)).toBe(true)
    expect(messageMentionsUser(msg({ mentions: ['8'] }), ME)).toBe(false)
  })

  it('matches server role mentions by intersection', () => {
    expect(messageMentionsUser(msg({ mention_roles: ['r2'] }), ME)).toBe(true)
    expect(messageMentionsUser(msg({ mention_roles: ['r9'] }), ME)).toBe(false)
    expect(messageMentionsUser(msg({ mention_roles: [] }), ME)).toBe(false)
  })

  it('matches server broadcast flag', () => {
    expect(messageMentionsUser(msg({ mention_everyone: true }), ME)).toBe(true)
  })

  it('trusts server fields over content (stripped syntax does not count)', () => {
    // Server expressed an opinion (fields present) with no match: content
    // syntax alone must not badge.
    expect(
      messageMentionsUser(
        msg({ content: 'hey <@7>', mentions: [], mention_roles: [], mention_everyone: false }),
        ME,
      ),
    ).toBe(false)
  })

  it('falls back to content parsing when server fields are absent', () => {
    expect(messageMentionsUser(msg({ content: 'hey <@7>' }), ME)).toBe(true)
    expect(messageMentionsUser(msg({ content: 'hey <@&r1>' }), ME)).toBe(true)
    expect(messageMentionsUser(msg({ content: '@everyone rise' }), ME)).toBe(true)
    expect(messageMentionsUser(msg({ content: 'nothing here' }), ME)).toBe(false)
  })

  it('never counts your own messages', () => {
    const mine = msg({
      author: { id: '7', username: 'me', discriminator: '0000' },
      mentions: ['7'],
      content: 'hey <@7>',
    })
    expect(messageMentionsUser(mine, ME)).toBe(false)
  })

  it('requires an identity', () => {
    expect(messageMentionsUser(msg({ mentions: ['7'] }), { userId: '', roleIds: [] })).toBe(false)
  })
})

describe('mention badge state (#122)', () => {
  it('applyIncomingMention increments and keeps the first id', () => {
    let s: MentionCountState = EMPTY_MENTION_STATE
    s = applyIncomingMention(s, 'c1', 'm1')
    expect(s).toEqual({ counts: { c1: 1 }, firstIds: { c1: 'm1' } })
    s = applyIncomingMention(s, 'c1', 'm2')
    expect(s).toEqual({ counts: { c1: 2 }, firstIds: { c1: 'm1' } })
    s = applyIncomingMention(s, 'c2', 'm9')
    expect(s.counts).toEqual({ c1: 2, c2: 1 })
  })

  it('clearChannelMentions drops the channel and preserves reference when absent', () => {
    const s: MentionCountState = { counts: { c1: 2 }, firstIds: { c1: 'm1' } }
    expect(clearChannelMentions(s, 'c9')).toBe(s)
    expect(clearChannelMentions(s, 'c1')).toEqual({ counts: {}, firstIds: {} })
  })

  it('hydrateMentionCounts is max-wins and never regresses live counts', () => {
    const live: MentionCountState = { counts: { c1: 3 }, firstIds: { c1: 'm1' } }
    // Stale server value does not regress.
    expect(hydrateMentionCounts(live, [{ channel_id: 'c1', mention_count: 1 }])).toBe(live)
    // Higher server value (e.g. future server-side counting) flows through.
    const merged = hydrateMentionCounts(live, [
      { channel_id: 'c1', mention_count: 5 },
      { channel_id: 'c2', mention_count: 2 },
    ])
    expect(merged.counts).toEqual({ c1: 5, c2: 2 })
    expect(merged.firstIds).toEqual({ c1: 'm1' })
    // Negative / missing counts clamp to zero / skip.
    expect(
      hydrateMentionCounts(EMPTY_MENTION_STATE, [{ channel_id: 'c3', mention_count: -4 }]).counts,
    ).toEqual({})
  })

  it('isIdNewer compares snowflakes with fallback', () => {
    expect(isIdNewer('200', '100')).toBe(true)
    expect(isIdNewer('100', '200')).toBe(false)
    expect(isIdNewer('100', '100')).toBe(false)
    expect(isIdNewer('b', 'a')).toBe(true)
  })
})
