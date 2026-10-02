import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ParentQuote } from './ParentQuote'

describe('ParentQuote', () => {
  it('renders author username, content snippet, and curved spine connector', () => {
    const html = renderToStaticMarkup(
      <ParentQuote
        replyToId="987654321"
        referencedMessage={{
          id: '987654321',
          author: { id: 'user-2', username: 'charlie', discriminator: '0000' },
          content: 'This is the parent text being quoted',
        }}
        onJump={() => {}}
      />
    )

    expect(html).toContain('parent-quote')
    expect(html).toContain('reply-spine')
    expect(html).toContain('@charlie')
    expect(html).toContain('This is the parent text being quoted')
    expect(html).toContain('Jump to referenced message')
  })

  it('renders tombstone when parent message was deleted', () => {
    const html = renderToStaticMarkup(
      <ParentQuote
        replyToId="987654321"
        referencedMessage={null}
        onJump={() => {}}
      />
    )

    expect(html).toContain('parent-quote')
    expect(html).toContain('is-deleted')
    expect(html).toContain('reply-spine')
    expect(html).toContain('Original message was deleted')
  })

  it('renders fallback for attachment-only parent message', () => {
    const html = renderToStaticMarkup(
      <ParentQuote
        replyToId="987654321"
        referencedMessage={{
          id: '987654321',
          author: { id: 'user-2', username: 'charlie', discriminator: '0000' },
          content: '',
        }}
        onJump={() => {}}
      />
    )

    expect(html).toContain('(attachment)')
  })
})
