import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageToolbar } from './MessageToolbar'
import type { Message } from '../../types'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-12345',
    channel_id: 'chan-1',
    author: {
      id: 'author-1',
      username: 'alice',
      discriminator: '0001',
    },
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('MessageToolbar', () => {
  const dummyProps = {
    message: makeMessage(),
    canEdit: false,
    canDelete: false,
    canPin: false,
    canReply: false,
    canAddReaction: false,
    onQuickReaction: vi.fn(),
    onOpenReactionPicker: vi.fn(),
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onPin: vi.fn(),
    onDelete: vi.fn(),
  }

  it('renders nothing when no actions are permitted', () => {
    const html = renderToStaticMarkup(<MessageToolbar {...dummyProps} />)
    expect(html).toBe('')
  })

  it('renders quick reactions and Add Reaction button when canAddReaction is true', () => {
    const html = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canAddReaction={true} />
    )
    expect(html).toContain('message-toolbar')
    expect(html).toContain('quick-reaction-btn')
    expect(html).toContain('👍')
    expect(html).toContain('❤️')
    expect(html).toContain('🔥')
    expect(html).toContain('title="Add Reaction"')
  })

  it('renders Reply button when canReply is true', () => {
    const html = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canReply={true} />
    )
    expect(html).toContain('title="Reply"')
    expect(html).toContain('aria-label="Reply"')
  })

  it('renders Edit button only when canEdit is true', () => {
    const htmlWithoutEdit = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canReply={true} canEdit={false} />
    )
    expect(htmlWithoutEdit).not.toContain('title="Edit"')

    const htmlWithEdit = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canEdit={true} />
    )
    expect(htmlWithEdit).toContain('title="Edit"')
    expect(htmlWithEdit).toContain('aria-label="Edit"')
  })

  it('renders Pin button only when canPin is true', () => {
    const htmlWithoutPin = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canReply={true} canPin={false} />
    )
    expect(htmlWithoutPin).not.toContain('title="Pin Message"')

    const htmlWithPin = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canPin={true} />
    )
    expect(htmlWithPin).toContain('title="Pin Message"')
    expect(htmlWithPin).toContain('aria-label="Pin Message"')
  })

  it('renders Delete button with danger styling only when canDelete is true', () => {
    const htmlWithoutDelete = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canReply={true} canDelete={false} />
    )
    expect(htmlWithoutDelete).not.toContain('title="Delete"')

    const htmlWithDelete = renderToStaticMarkup(
      <MessageToolbar {...dummyProps} canDelete={true} />
    )
    expect(htmlWithDelete).toContain('title="Delete"')
    expect(htmlWithDelete).toContain('message-toolbar-btn-danger')
  })

  it('renders complete action suite for privileged author', () => {
    const html = renderToStaticMarkup(
      <MessageToolbar
        {...dummyProps}
        canAddReaction={true}
        canReply={true}
        canEdit={true}
        canPin={true}
        canDelete={true}
      />
    )
    expect(html).toContain('quick-reaction-btn')
    expect(html).toContain('title="Add Reaction"')
    expect(html).toContain('title="Reply"')
    expect(html).toContain('title="Edit"')
    expect(html).toContain('title="Pin Message"')
    expect(html).toContain('title="Delete"')
  })
})
