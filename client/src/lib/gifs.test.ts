import { describe, it, expect } from 'vitest'
import { extractGifUrls } from './gifs'

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
