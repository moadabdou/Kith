import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageInput, PendingUploadChip, shouldTriggerEditLastMessage } from './MessageInput'
import type { Message } from '../../types'
import type { PendingUpload } from '../../lib/uploads'

vi.mock('../../api', () => ({
  api: {
    getTrendingGifs: vi.fn(),
    searchGifs: vi.fn(),
    getGifCategories: vi.fn(),
  },
}))

describe('shouldTriggerEditLastMessage', () => {
  it('returns true when ArrowUp is pressed in an empty input with no pending files or active mentions', () => {
    expect(shouldTriggerEditLastMessage('ArrowUp', {}, '', 0, false)).toBe(true)
    expect(shouldTriggerEditLastMessage('ArrowUp', {}, '   ', 0, false)).toBe(true)
  })

  it('returns false for other keys', () => {
    expect(shouldTriggerEditLastMessage('Enter', {}, '', 0, false)).toBe(false)
    expect(shouldTriggerEditLastMessage('ArrowDown', {}, '', 0, false)).toBe(false)
  })

  it('returns false when modifier keys are pressed', () => {
    expect(shouldTriggerEditLastMessage('ArrowUp', { shiftKey: true }, '', 0, false)).toBe(false)
    expect(shouldTriggerEditLastMessage('ArrowUp', { ctrlKey: true }, '', 0, false)).toBe(false)
    expect(shouldTriggerEditLastMessage('ArrowUp', { altKey: true }, '', 0, false)).toBe(false)
    expect(shouldTriggerEditLastMessage('ArrowUp', { metaKey: true }, '', 0, false)).toBe(false)
  })

  it('returns false when input contains text', () => {
    expect(shouldTriggerEditLastMessage('ArrowUp', {}, 'hello world', 0, false)).toBe(false)
  })

  it('returns false when pending uploads are queued', () => {
    expect(shouldTriggerEditLastMessage('ArrowUp', {}, '', 1, false)).toBe(false)
  })

  it('returns false when mention autocomplete query is active', () => {
    expect(shouldTriggerEditLastMessage('ArrowUp', {}, '', 0, true)).toBe(false)
  })
})

describe('PendingUploadChip', () => {
  const dummyFile = new File(['hello'], 'document.pdf', { type: 'application/pdf' })
  const baseUpload: PendingUpload = {
    key: 'p-1',
    file: dummyFile,
    filename: 'document.pdf',
    size: 2048,
    contentType: 'application/pdf',
    state: 'uploaded',
    progress: 1,
  }

  it('renders filename and formatted size', () => {
    const html = renderToStaticMarkup(
      <PendingUploadChip upload={baseUpload} onRemove={vi.fn()} />
    )
    expect(html).toContain('document.pdf')
    expect(html).toContain('2 KB')
    expect(html).toContain('pending-upload')
  })

  it('renders progress bar when uploading or presigning', () => {
    const uploading: PendingUpload = {
      ...baseUpload,
      state: 'uploading',
      progress: 0.65,
    }
    const html = renderToStaticMarkup(
      <PendingUploadChip upload={uploading} onRemove={vi.fn()} />
    )
    expect(html).toContain('pending-upload-bar')
    expect(html).toContain('width:65%')
    expect(html).toContain('65% · 2 KB')
  })

  it('renders error indicator when upload fails', () => {
    const failed: PendingUpload = {
      ...baseUpload,
      state: 'error',
      error: 'File exceeds 25 MB limit',
    }
    const html = renderToStaticMarkup(
      <PendingUploadChip upload={failed} onRemove={vi.fn()} />
    )
    expect(html).toContain('pending-upload-error')
    expect(html).toContain('File exceeds 25 MB limit')
  })
})

describe('MessageInput', () => {
  const defaultProps = {
    channelName: 'general',
    canSend: true,
    inputText: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    canAttach: true,
    pending: [],
    hasReadyUploads: false,
    uploadsBlocked: false,
    onPickFiles: vi.fn(),
    onRemovePending: vi.fn(),
  }

  it('renders channel name in input placeholder and container', () => {
    const html = renderToStaticMarkup(<MessageInput {...defaultProps} />)
    expect(html).toContain('chat-input-container')
    expect(html).toContain('chat-input-bar')
    expect(html).toContain('chat-input-placeholder')
    expect(html).toContain('Message #general')
  })

  it('renders reply bar when replyingTo is set', () => {
    const replyTarget: Message = {
      id: 'msg-target',
      channel_id: 'chan-1',
      content: 'Hello prior',
      timestamp: new Date().toISOString(),
      author: {
        id: 'u-1',
        username: 'sammy',
        discriminator: '0001',
      },
    }

    const html = renderToStaticMarkup(
      <MessageInput
        {...defaultProps}
        replyingTo={replyTarget}
        onCancelReply={vi.fn()}
      />
    )
    expect(html).toContain('has-reply-bar')
    expect(html).toContain('reply-bar')
    expect(html).toContain('@sammy')
  })

  it('renders pending upload chips when pending array is non-empty', () => {
    const upload: PendingUpload = {
      key: 'p-1',
      file: new File([''], 'photo.png', { type: 'image/png' }),
      filename: 'photo.png',
      size: 1024,
      contentType: 'image/png',
      state: 'uploaded',
      progress: 1,
    }

    const html = renderToStaticMarkup(
      <MessageInput {...defaultProps} pending={[upload]} />
    )
    expect(html).toContain('pending-uploads')
    expect(html).toContain('photo.png')
  })
})
