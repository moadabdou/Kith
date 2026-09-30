import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttachmentView } from './AttachmentView'
import type { Attachment } from '../../types'

vi.mock('../../api', () => ({
  api: {
    presignAttachment: vi.fn(),
    getAttachment: vi.fn(),
  },
}))

function base(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    channel_id: 'chan-1',
    uploader_id: 'user-1',
    filename: 'file.bin',
    content_type: 'application/octet-stream',
    size: 1234,
    sha256: 'abc',
    url: 'http://cdn/attachments/file.bin',
    status: 'ready',
    ...over,
  }
}

describe('AttachmentView', () => {
  it('renders images with the proxied url preferred', () => {
    const html = renderToStaticMarkup(
      <AttachmentView
        channelId="chan-1"
        attachment={base({
          filename: 'cat.png',
          content_type: 'image/png',
          url: 'http://cdn/cat.png',
          proxy_url: 'http://cdn/proxy/cat.png',
          width: 800,
          height: 600,
        })}
      />
    )
    expect(html).toContain('<img')
    expect(html).toContain('http://cdn/proxy/cat.png')
    expect(html).not.toContain('http://cdn/cat.png"')
  })

  it('renders video with controls and audio with controls', () => {
    const video = renderToStaticMarkup(
      <AttachmentView channelId="chan-1" attachment={base({ filename: 'c.mp4', content_type: 'video/mp4' })} />
    )
    expect(video).toContain('<video')
    expect(video).toContain('controls')
    const audio = renderToStaticMarkup(
      <AttachmentView channelId="chan-1" attachment={base({ filename: 's.mp3', content_type: 'audio/mpeg' })} />
    )
    expect(audio).toContain('<audio')
  })

  it('renders generic files as download cards with formatted size', () => {
    const html = renderToStaticMarkup(
      <AttachmentView
        channelId="chan-1"
        attachment={base({ filename: 'report.pdf', content_type: 'application/pdf', size: 2048 })}
      />
    )
    expect(html).toContain('download')
    expect(html).toContain('report.pdf')
    expect(html).toContain('2 KB')
  })

  it('renders a placeholder while the worker is still processing', () => {
    const html = renderToStaticMarkup(
      <AttachmentView channelId="chan-1" attachment={base({ status: 'pending' })} />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('Processing')
    const failed = renderToStaticMarkup(
      <AttachmentView channelId="chan-1" attachment={base({ status: 'failed' })} />
    )
    expect(failed).toContain('failed')
  })
})
