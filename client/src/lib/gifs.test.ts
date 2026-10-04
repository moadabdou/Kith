import { describe, it, expect } from 'vitest'
import { extractGifUrls, stripGifUrls } from './gifs'

describe('extractGifUrls', () => {
  it('returns empty array when content is empty or contains no gif urls', () => {
    expect(extractGifUrls('')).toEqual([])
    expect(extractGifUrls('hello world!')).toEqual([])
    expect(extractGifUrls('check out https://example.com/page')).toEqual([])
  })

  it('extracts direct .gif URLs', () => {
    const content = 'Look at this funny cat: https://media.giphy.com/media/xyz123/giphy.gif!'
    const urls = extractGifUrls(content)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe('https://media.giphy.com/media/xyz123/giphy.gif')
  })

  it('extracts KLIPY URLs without needing .gif extension', () => {
    const content = 'https://media.klipy.com/gifs/funny-dance-123'
    const urls = extractGifUrls(content)
    expect(urls).toEqual(['https://media.klipy.com/gifs/funny-dance-123'])
  })

  it('extracts multiple unique GIF URLs from mixed content', () => {
    const content = 'Two gifs: https://media.klipy.com/gifs/cat1 and https://static.klipy.com/dog-anim.gif. Same again https://media.klipy.com/gifs/cat1'
    const urls = extractGifUrls(content)
    expect(urls).toEqual([
      'https://media.klipy.com/gifs/cat1',
      'https://static.klipy.com/dog-anim.gif',
    ])
  })

  it('strips trailing punctuation like commas, periods, exclamation marks', () => {
    const content = 'See: https://example.com/dance.gif, and https://example.com/jump.gif; wow https://example.com/cheer.gif!'
    const urls = extractGifUrls(content)
    expect(urls).toEqual([
      'https://example.com/dance.gif',
      'https://example.com/jump.gif',
      'https://example.com/cheer.gif',
    ])
  })

  it('extracts root-relative fallback GIF paths', () => {
    const content = 'Sent /api/gifs/fallback/excited-happy.gif in chat'
    const urls = extractGifUrls(content)
    expect(urls).toEqual(['/api/gifs/fallback/excited-happy.gif'])
  })
})

describe('stripGifUrls', () => {
  it('returns empty string when given empty content or when message is only a GIF URL', () => {
    expect(stripGifUrls('')).toBe('')
    expect(stripGifUrls('https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/18/53/GBYEPKOo.gif')).toBe('')
    expect(stripGifUrls('  https://media.giphy.com/media/xyz123/giphy.gif  ')).toBe('')
    expect(stripGifUrls('<https://static.klipy.com/ii/test.gif>')).toBe('')
  })

  it('preserves text surrounding a GIF URL without leaving the URL', () => {
    const content = 'check this out https://static.klipy.com/ii/c3a19a0b747a76e98651f2b9a3cca5ff/18/53/GBYEPKOo.gif so cool'
    expect(stripGifUrls(content)).toBe('check this out so cool')
  })

  it('handles multi-line text with GIF URLs cleanly', () => {
    const content = 'Hello world\nhttps://static.klipy.com/test.gif\nEnjoy the party!'
    expect(stripGifUrls(content)).toBe('Hello world\nEnjoy the party!')
  })

  it('leaves regular text and non-gif URLs intact', () => {
    const content = 'Visit https://github.com for code'
    expect(stripGifUrls(content)).toBe('Visit https://github.com for code')
  })
})
