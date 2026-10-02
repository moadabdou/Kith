import { describe, it, expect } from 'vitest'
import {
  applyReactionAdd,
  applyReactionRemove,
  toggleReactionOptimistic,
} from './reactions'
import type { ReactionTally } from '../types'

describe('reactions reducer', () => {
  describe('applyReactionAdd', () => {
    it('adds a new emoji tally when list is empty or undefined', () => {
      const result = applyReactionAdd(undefined, '🔥', true)
      expect(result).toEqual([{ emoji: '🔥', count: 1, me: true }])

      const resultEmpty = applyReactionAdd([], '👍', false)
      expect(resultEmpty).toEqual([{ emoji: '👍', count: 1, me: false }])
    })

    it('increments count for an existing emoji', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 2, me: false }]
      const result = applyReactionAdd(initial, '🔥', true)
      expect(result).toEqual([{ emoji: '🔥', count: 3, me: true }])
    })

    it('preserves existing me: true when a peer adds the same emoji', () => {
      const initial: ReactionTally[] = [{ emoji: '🚀', count: 1, me: true }]
      const result = applyReactionAdd(initial, '🚀', false)
      expect(result).toEqual([{ emoji: '🚀', count: 2, me: true }])
    })

    it('appends distinct emoji without mutating other tallies', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 1, me: true }]
      const result = applyReactionAdd(initial, '❤️', false)
      expect(result).toEqual([
        { emoji: '🔥', count: 1, me: true },
        { emoji: '❤️', count: 1, me: false },
      ])
    })

    it('is idempotent when isMe: true and user already has me: true', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 1, me: true }]
      const result = applyReactionAdd(initial, '🔥', true)
      expect(result).toEqual([{ emoji: '🔥', count: 1, me: true }])
    })
  })

  describe('applyReactionRemove', () => {
    it('returns empty array when list is empty or undefined', () => {
      expect(applyReactionRemove(undefined, '🔥', true)).toEqual([])
      expect(applyReactionRemove([], '🔥', false)).toEqual([])
    })

    it('returns unmodified array when emoji does not exist', () => {
      const initial: ReactionTally[] = [{ emoji: '👍', count: 1, me: false }]
      expect(applyReactionRemove(initial, '🔥', false)).toEqual(initial)
    })

    it('is idempotent when isMe: true and user already has me: false', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 2, me: false }]
      const result = applyReactionRemove(initial, '🔥', true)
      expect(result).toEqual([{ emoji: '🔥', count: 2, me: false }])
    })

    it('decrements count without removing when count > 1', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 3, me: true }]
      const result = applyReactionRemove(initial, '🔥', true)
      expect(result).toEqual([{ emoji: '🔥', count: 2, me: false }])
    })

    it('preserves me status when a peer removes a reaction', () => {
      const initial: ReactionTally[] = [{ emoji: '🔥', count: 3, me: true }]
      const result = applyReactionRemove(initial, '🔥', false)
      expect(result).toEqual([{ emoji: '🔥', count: 2, me: true }])
    })

    it('removes tally when count drops to 0', () => {
      const initial: ReactionTally[] = [
        { emoji: '🔥', count: 1, me: true },
        { emoji: '👍', count: 2, me: false },
      ]
      const result = applyReactionRemove(initial, '🔥', true)
      expect(result).toEqual([{ emoji: '👍', count: 2, me: false }])
    })
  })

  describe('toggleReactionOptimistic', () => {
    it('optimistically adds reaction when user has not reacted yet', () => {
      const initial: ReactionTally[] = [{ emoji: '👍', count: 1, me: false }]
      const { nextReactions, wasMe } = toggleReactionOptimistic(initial, '👍')
      expect(wasMe).toBe(false)
      expect(nextReactions).toEqual([{ emoji: '👍', count: 2, me: true }])
    })

    it('optimistically removes reaction when user already reacted', () => {
      const initial: ReactionTally[] = [{ emoji: '👍', count: 2, me: true }]
      const { nextReactions, wasMe } = toggleReactionOptimistic(initial, '👍')
      expect(wasMe).toBe(true)
      expect(nextReactions).toEqual([{ emoji: '👍', count: 1, me: false }])
    })

    it('optimistically adds brand new reaction when emoji is not present', () => {
      const initial: ReactionTally[] = []
      const { nextReactions, wasMe } = toggleReactionOptimistic(initial, '🎉')
      expect(wasMe).toBe(false)
      expect(nextReactions).toEqual([{ emoji: '🎉', count: 1, me: true }])
    })
  })
})
