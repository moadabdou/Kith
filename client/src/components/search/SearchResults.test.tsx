import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../api', () => ({
  api: {
    presignAttachment: vi.fn(),
    getAttachment: vi.fn(),
  },
}))

import { SearchResults, SearchResultContent } from './SearchResults'
import type { Channel, Message } from '../../types'

describe('SearchResultContent', () => {
  it('renders custom emoji img instead of raw <:name:id> string', () => {
    const content = '<:cb7d1917db8171c26edd8d53d6e57b89:100024546593083392> hey hey'
    const html = renderToStaticMarkup(<SearchResultContent content={content} query="hey" />)

    expect(html).toContain('src="/emojis/100024546593083392.png"')
    expect(html).toContain('class="chat-custom-emoji"')
    expect(html).toContain('alt=":cb7d1917db8171c26edd8d53d6e57b89:"')
    expect(html).not.toContain('<:cb7d1917db8171c26edd8d53d6e57b89:100024546593083392>')
    expect(html).toContain('<mark class="search-highlight">hey</mark>')
  })

  it('renders animated custom emoji with .gif extension', () => {
    const content = '<a:party_parrot:555444333222111> celebration'
    const html = renderToStaticMarkup(<SearchResultContent content={content} query="party" />)

    expect(html).toContain('src="/emojis/555444333222111.gif"')
    expect(html).toContain('alt=":party_parrot:"')
  })
})

describe('SearchResults Component', () => {
  const dummyChannel: Channel = {
    id: 'chan-1',
    guild_id: 'guild-1',
    name: 'general',
    type: 0,
    position: 0,
    created_at: '2026-10-01T00:00:00.000Z',
  }

  const dummyMsg: Message = {
    id: 'msg-1',
    channel_id: 'chan-1',
    author: {
      id: 'user-1',
      username: 'moadabdou',
      discriminator: '0001',
    },
    content: '<:pepe:123456789> hello world',
    timestamp: '2026-10-04T01:25:00.000Z',
    sticker_ids: ['999888777'],
  }

  it('renders emoji img and sticker in search result card', () => {
    const html = renderToStaticMarkup(
      <SearchResults
        isOpen={true}
        onClose={vi.fn()}
        query="hello"
        results={[dummyMsg]}
        totalResults={1}
        loading={false}
        currentPage={1}
        pageSize={25}
        onPageChange={vi.fn()}
        channels={[dummyChannel]}
        currentChannel={dummyChannel}
        selectedChannelId=""
        onSelectChannelFilter={vi.fn()}
        selectedAuthorId=""
        onSelectAuthorFilter={vi.fn()}
        onJumpToMessage={vi.fn()}
      />
    )

    // Emoji image is rendered, raw syntax is not rendered
    expect(html).toContain('src="/emojis/123456789.png"')
    expect(html).toContain('class="chat-custom-emoji"')
    expect(html).not.toContain('<:pepe:123456789>')

    // Sticker image is rendered
    expect(html).toContain('src="/stickers/999888777.png"')
    expect(html).toContain('class="chat-message-sticker"')

    // Search query match is highlighted
    expect(html).toContain('<mark class="search-highlight">hello</mark>')
  })
})
