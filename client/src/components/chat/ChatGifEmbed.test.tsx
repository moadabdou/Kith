import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatGifEmbed } from './ChatGifEmbed'

describe('ChatGifEmbed', () => {
  it('renders shimmer placeholder and gif badge initially', () => {
    const html = renderToStaticMarkup(
      <ChatGifEmbed url="https://media.klipy.com/gifs/sample.gif" />
    )

    expect(html).toContain('chat-gif-embed')
    expect(html).toContain('chat-gif-placeholder')
    expect(html).toContain('chat-gif-placeholder-shimmer')
    expect(html).toContain('chat-gif-badge')
    expect(html).toContain('GIF')
    expect(html).toContain('src="https://media.klipy.com/gifs/sample.gif"')
  })
})
