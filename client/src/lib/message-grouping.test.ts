import { describe, it, expect } from 'vitest'
import { shouldGroupConsecutiveMessage, findLastEditableMessage, MESSAGE_GROUPING_WINDOW_MS } from './message-grouping'
import type { Message } from '../types'

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    content: 'hello',
    timestamp: '2026-10-06T12:00:00.000Z',
    author: {
      id: 'user-1',
      username: 'alice',
      discriminator: '0001',
    },
    ...overrides,
  }
}

describe('shouldGroupConsecutiveMessage', () => {
  it('returns false when prevMsg is null or undefined', () => {
    const current = makeMsg()
    expect(shouldGroupConsecutiveMessage(null, current)).toBe(false)
    expect(shouldGroupConsecutiveMessage(undefined, current)).toBe(false)
  })

  it('returns false when authors are different', () => {
    const prev = makeMsg({ id: 'msg-1', author: { id: 'user-1', username: 'alice', discriminator: '0001' } })
    const current = makeMsg({ id: 'msg-2', author: { id: 'user-2', username: 'bob', discriminator: '0002' } })
    expect(shouldGroupConsecutiveMessage(prev, current)).toBe(false)
  })

  it('returns true when same author sends within 5 minutes', () => {
    const prev = makeMsg({
      id: 'msg-1',
      timestamp: '2026-10-06T12:00:00.000Z',
    })
    const current = makeMsg({
      id: 'msg-2',
      timestamp: '2026-10-06T12:04:30.000Z', // 4.5 minutes later
    })
    expect(shouldGroupConsecutiveMessage(prev, current)).toBe(true)
  })

  it('returns false when time difference is 5 minutes or greater', () => {
    const prev = makeMsg({
      id: 'msg-1',
      timestamp: '2026-10-06T12:00:00.000Z',
    })
    const current = makeMsg({
      id: 'msg-2',
      timestamp: new Date(new Date('2026-10-06T12:00:00.000Z').getTime() + MESSAGE_GROUPING_WINDOW_MS).toISOString(),
    })
    expect(shouldGroupConsecutiveMessage(prev, current)).toBe(false)
  })

  it('returns false when message is a reply (type 19 or has reply_to)', () => {
    const prev = makeMsg({ id: 'msg-1' })
    const currentType19 = makeMsg({ id: 'msg-2', type: 19 })
    const currentReplyTo = makeMsg({
      id: 'msg-3',
      reply_to: 'msg-0',
    })

    expect(shouldGroupConsecutiveMessage(prev, currentType19)).toBe(false)
    expect(shouldGroupConsecutiveMessage(prev, currentReplyTo)).toBe(false)
  })

  it('returns false when message is pinned', () => {
    const prev = makeMsg({ id: 'msg-1' })
    const current = makeMsg({ id: 'msg-2', pinned: true })
    expect(shouldGroupConsecutiveMessage(prev, current)).toBe(false)
  })

  it('returns false when marked as first unread message', () => {
    const prev = makeMsg({ id: 'msg-1' })
    const current = makeMsg({ id: 'msg-2' })
    expect(shouldGroupConsecutiveMessage(prev, current, { isFirstUnread: true })).toBe(false)
  })

  it('returns false if timestamps are invalid dates', () => {
    const prev = makeMsg({ id: 'msg-1', timestamp: 'invalid-date' })
    const current = makeMsg({ id: 'msg-2', timestamp: 'another-invalid' })
    expect(shouldGroupConsecutiveMessage(prev, current)).toBe(false)
  })
})

describe('findLastEditableMessage', () => {
  it('returns null when currentUserId is missing or messages list is empty', () => {
    expect(findLastEditableMessage([], 'user-1', () => true)).toBeNull()
    expect(findLastEditableMessage([makeMsg()], undefined, () => true)).toBeNull()
  })

  it('scans from newest to oldest and returns the latest editable message by the current user', () => {
    const msg1 = makeMsg({ id: 'msg-1', author: { id: 'user-1', username: 'alice', discriminator: '0001' } })
    const msg2 = makeMsg({ id: 'msg-2', author: { id: 'user-2', username: 'bob', discriminator: '0002' } })
    const msg3 = makeMsg({ id: 'msg-3', author: { id: 'user-1', username: 'alice', discriminator: '0001' } })
    const msg4 = makeMsg({ id: 'msg-4', author: { id: 'user-2', username: 'bob', discriminator: '0002' } })

    const result = findLastEditableMessage([msg1, msg2, msg3, msg4], 'user-1', () => true)
    expect(result).toBe(msg3)
  })

  it('skips user messages that canEdit returns false for', () => {
    const msg1 = makeMsg({ id: 'msg-1', author: { id: 'user-1', username: 'alice', discriminator: '0001' } })
    const msg2 = makeMsg({ id: 'msg-2', author: { id: 'user-1', username: 'alice', discriminator: '0001' } })

    // Suppose msg2 edit window expired, msg1 is still editable
    const result = findLastEditableMessage([msg1, msg2], 'user-1', (m) => m.id === 'msg-1')
    expect(result).toBe(msg1)
  })

  it('returns null if the user has no messages', () => {
    const msg1 = makeMsg({ id: 'msg-1', author: { id: 'user-2', username: 'bob', discriminator: '0002' } })
    const result = findLastEditableMessage([msg1], 'user-1', () => true)
    expect(result).toBeNull()
  })
})
