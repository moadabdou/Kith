import { describe, it, expect } from 'vitest'
import { applyMessageUpdate } from './message-updates'
import type { Message } from '../types'

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '1',
    channel_id: 'c1',
    author: { id: 'u', username: 'u', discriminator: '0' },
    content: 'hello',
    timestamp: '2026-09-30T00:00:00Z',
    ...over,
  }
}

describe('applyMessageUpdate', () => {
  it('merges edit content into the cached message', () => {
    const out = applyMessageUpdate([msg()], { id: '1', channel_id: 'c1', content: 'edited' })
    expect(out[0].content).toBe('edited')
  })

  it('leaves the message untouched for slim worker hints', () => {
    const prev = [msg()]
    const out = applyMessageUpdate(prev, { id: '1', channel_id: 'c1' })
    expect(out).toBe(prev)
  })

  it('replaces attachments when the payload carries them', () => {
    const out = applyMessageUpdate([msg()], {
      id: '1',
      channel_id: 'c1',
      attachments: [
        {
          id: 'a1',
          channel_id: 'c1',
          uploader_id: 'u',
          filename: 'x.png',
          content_type: 'image/png',
          size: 10,
          sha256: 's',
          url: 'http://cdn/x.png',
          status: 'ready',
        },
      ],
    })
    expect(out[0].attachments).toHaveLength(1)
    expect(out[0].attachments?.[0].status).toBe('ready')
  })

  it('ignores updates for uncached messages', () => {
    const prev = [msg()]
    expect(applyMessageUpdate(prev, { id: '999', channel_id: 'c1', content: 'x' })).toBe(prev)
  })
})
