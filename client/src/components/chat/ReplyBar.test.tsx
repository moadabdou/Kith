import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReplyBar } from './ReplyBar'
import type { Message } from '../../types'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '123456789',
    channel_id: 'chan-1',
    author: {
      id: 'author-1',
      username: 'alice',
      discriminator: '0001',
    },
    content: 'Original hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('ReplyBar', () => {
  it('renders target author username in reply bar banner', () => {
    const msg = makeMessage({ author: { id: '99', username: 'bob_ross', discriminator: '0000' } })
    const html = renderToStaticMarkup(<ReplyBar replyingTo={msg} onCancel={() => {}} />)

    expect(html).toContain('reply-bar')
    expect(html).toContain('Replying to')
    expect(html).toContain('@bob_ross')
  })

  it('renders close button with accessible cancel attributes', () => {
    const msg = makeMessage()
    const html = renderToStaticMarkup(<ReplyBar replyingTo={msg} onCancel={() => {}} />)

    expect(html).toContain('reply-bar-close')
    expect(html).toContain('Cancel reply (Escape)')
    expect(html).toContain('aria-label="Cancel reply"')
  })

  it('renders region role and label for accessibility', () => {
    const msg = makeMessage()
    const html = renderToStaticMarkup(<ReplyBar replyingTo={msg} onCancel={() => {}} />)

    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Reply composer indicator"')
  })
})
