import { describe, expect, it } from 'vitest'
import { highlightMatches, parseSearchQuery } from './search'

describe('highlightMatches', () => {
  it('returns single segment when query is empty', () => {
    const res = highlightMatches('Hello world', '')
    expect(res).toEqual([{ text: 'Hello world', isMatch: false }])
  })

  it('highlights exact case-insensitive match', () => {
    const res = highlightMatches('Hello world', 'world')
    expect(res).toEqual([
      { text: 'Hello ', isMatch: false },
      { text: 'world', isMatch: true },
    ])
  })

  it('highlights multiple occurrences', () => {
    const res = highlightMatches('test foo test bar test', 'test')
    expect(res).toEqual([
      { text: 'test', isMatch: true },
      { text: ' foo ', isMatch: false },
      { text: 'test', isMatch: true },
      { text: ' bar ', isMatch: false },
      { text: 'test', isMatch: true },
    ])
  })

  it('handles regex characters safely without crashing', () => {
    const res = highlightMatches('price is $10.00 [sale]', '$10.00 [sale]')
    expect(res.some((r) => r.isMatch)).toBe(true)
  })

  it('highlights multi-word search queries', () => {
    const res = highlightMatches('The quick brown fox jumps', 'quick fox')
    expect(res).toEqual([
      { text: 'The ', isMatch: false },
      { text: 'quick', isMatch: true },
      { text: ' brown ', isMatch: false },
      { text: 'fox', isMatch: true },
      { text: ' jumps', isMatch: false },
    ])
  })
})

describe('parseSearchQuery', () => {
  it('extracts from and in filters from search query', () => {
    const res = parseSearchQuery('from:said hello world in:general')
    expect(res.from).toBe('said')
    expect(res.in).toBe('general')
    expect(res.text).toBe('hello world')
  })

  it('handles quotes in filters', () => {
    const res = parseSearchQuery('from:"moad abdou" test query')
    expect(res.from).toBe('moad abdou')
    expect(res.text).toBe('test query')
  })

  it('handles query with no filters', () => {
    const res = parseSearchQuery('simple keyword search')
    expect(res.from).toBeUndefined()
    expect(res.in).toBeUndefined()
    expect(res.text).toBe('simple keyword search')
  })
})

