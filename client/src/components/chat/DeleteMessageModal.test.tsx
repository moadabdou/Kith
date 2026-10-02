import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteMessageModal } from './DeleteMessageModal'
import type { Message } from '../../types'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-999',
    channel_id: 'chan-1',
    author: {
      id: 'author-1',
      username: 'charlie',
      discriminator: '1234',
    },
    content: 'This message will be deleted',
    timestamp: '2026-10-02T12:00:00.000Z',
    ...overrides,
  }
}

describe('DeleteMessageModal', () => {
  it('renders dialog with header, preview content, and action buttons', () => {
    const msg = makeMessage({ content: 'Confidential message to purge' })
    const html = renderToStaticMarkup(
      <DeleteMessageModal
        message={msg}
        isDeleting={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Delete Message')
    expect(html).toContain('Are you sure you want to delete this message?')
    expect(html).toContain('Confidential message to purge')
    expect(html).toContain('charlie')
    expect(html).toContain('delete-modal-cancel-btn')
    expect(html).toContain('delete-modal-confirm-btn')
    expect(html).toContain('Delete')
  })

  it('renders loading indicator and disabled state when isDeleting is true', () => {
    const msg = makeMessage()
    const html = renderToStaticMarkup(
      <DeleteMessageModal
        message={msg}
        isDeleting={true}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('Deleting...')
    expect(html).toContain('disabled=""')
  })

  it('renders attachment count preview when attachments exist', () => {
    const msg = makeMessage({
      attachments: [
        {
          id: 'att-1',
          channel_id: 'chan-1',
          uploader_id: 'u-1',
          filename: 'photo.png',
          content_type: 'image/png',
          size: 1024,
          sha256: 'abc',
          url: 'http://cdn/photo.png',
          status: 'ready',
        },
      ],
    })
    const html = renderToStaticMarkup(
      <DeleteMessageModal
        message={msg}
        isDeleting={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('1 attachment')
  })
})
