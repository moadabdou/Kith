import { describe, expect, it } from 'vitest'
import {
  cycleIndex,
  extractMentionQuery,
  rankSuggestions,
  splitMentionChunks,
  suggestionInsertText,
  suggestionSyntax,
  type SuggestMember,
  type SuggestRole,
} from './mentionSuggest'

const MEMBERS: SuggestMember[] = [
  { id: '1', username: 'alice', nick: 'Ali' },
  { id: '2', username: 'albert', nick: null },
  { id: '3', username: 'bob', nick: 'Bobby' },
  { id: '1', username: 'alice-dup', nick: 'Ali2' },
]

const ROLES: SuggestRole[] = [
  { id: 'r1', name: 'Admins', mentionable: true },
  { id: 'r2', name: 'Quiet', mentionable: false },
]

describe('extractMentionQuery (#123)', () => {
  it('extracts queries at word boundaries', () => {
    expect(extractMentionQuery('@al')).toBe('al')
    expect(extractMentionQuery('hey @al')).toBe('al')
    expect(extractMentionQuery('@')).toBe('')
    expect(extractMentionQuery('hey @AL')).toBe('al')
  })

  it('ignores mid-word @ (emails) and trailing text', () => {
    expect(extractMentionQuery('mail me at bob@example.com')).toBeNull()
    expect(extractMentionQuery('a@b')).toBeNull()
    expect(extractMentionQuery('@alice hi')).toBeNull()
    expect(extractMentionQuery('no trigger here')).toBeNull()
    expect(extractMentionQuery('')).toBeNull()
  })

  it('uses the last trigger', () => {
    expect(extractMentionQuery('@al hey @bo')).toBe('bo')
  })
})

describe('rankSuggestions (#123)', () => {
  it('ranks nick matches before username matches, dedupes ids', () => {
    const out = rankSuggestions('al', MEMBERS, [], false)
    expect(out.map((s) => s.id)).toEqual(['1', '2'])
    expect(out[0]).toMatchObject({ kind: 'user', label: '@Ali', sub: 'alice' })
  })

  it('matches roles by prefix, mentionable only', () => {
    const out = rankSuggestions('adm', MEMBERS, ROLES, false)
    expect(out).toEqual([{ kind: 'role', id: 'r1', label: '@Admins', sub: 'Role' }])
    expect(rankSuggestions('qui', MEMBERS, ROLES, false)).toEqual([])
  })

  it('gates broadcast entries on permission', () => {
    expect(rankSuggestions('eve', MEMBERS, ROLES, false)).toEqual([])
    expect(rankSuggestions('eve', MEMBERS, ROLES, true)).toEqual([
      { kind: 'everyone', id: 'everyone', label: '@everyone' },
    ])
    const both = rankSuggestions('', MEMBERS, ROLES, true)
    expect(both.map((s) => s.kind)).toContain('everyone')
    expect(both.map((s) => s.kind)).toContain('here')
  })

  it('caps the result count', () => {
    const many: SuggestMember[] = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      username: `user${i}`,
    }))
    expect(rankSuggestions('', many, [], false).length).toBeLessThanOrEqual(8)
  })

  it('empty query lists members', () => {
    const out = rankSuggestions('', MEMBERS, ROLES, false)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].kind).toBe('user')
  })
})

describe('cycleIndex (#123)', () => {
  it('cycles with wraparound', () => {
    expect(cycleIndex(0, 1, 3)).toBe(1)
    expect(cycleIndex(2, 1, 3)).toBe(0)
    expect(cycleIndex(0, -1, 3)).toBe(2)
    expect(cycleIndex(0, 1, 0)).toBe(0)
  })
})

describe('splitMentionChunks (#123)', () => {
  it('splits user and role syntax from plain text', () => {
    expect(splitMentionChunks('hey <@123> and <@&45> ok')).toEqual([
      { text: 'hey ' },
      { text: '', mention: { kind: 'user', id: '123', raw: '<@123>' } },
      { text: ' and ' },
      { text: '', mention: { kind: 'role', id: '45', raw: '<@&45>' } },
      { text: ' ok' },
    ])
  })

  it('handles nickname syntax and adjacent mentions', () => {
    expect(splitMentionChunks('<@!7><@8>')).toEqual([
      { text: '', mention: { kind: 'user', id: '7', raw: '<@!7>' } },
      { text: '', mention: { kind: 'user', id: '8', raw: '<@8>' } },
    ])
  })

  it('leaves emoji syntax and plain text untouched', () => {
    expect(splitMentionChunks('hi <:party:99>')).toEqual([{ text: 'hi <:party:99>' }])
    expect(splitMentionChunks('plain')).toEqual([{ text: 'plain' }])
    expect(splitMentionChunks('')).toEqual([])
    expect(splitMentionChunks('<@> <@&> <@abc>')).toEqual([{ text: '<@> <@&> <@abc>' }])
  })
})

describe('suggestion syntax (#123)', () => {
  it('emits wire syntax and display text', () => {
    expect(suggestionSyntax({ kind: 'user', id: '7', label: '@x' })).toBe('<@7>')
    expect(suggestionSyntax({ kind: 'role', id: '9', label: '@y' })).toBe('<@&9>')
    expect(suggestionSyntax({ kind: 'everyone', id: 'everyone', label: '@everyone' })).toBe(
      '@everyone',
    )
    expect(suggestionSyntax({ kind: 'here', id: 'here', label: '@here' })).toBe('@here')
    expect(suggestionInsertText({ kind: 'user', id: '7', label: '@Ali' })).toBe('@Ali')
  })
})
