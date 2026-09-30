import { useState, type CSSProperties } from 'react'
import { FileText, Film, Loader2, Music } from 'lucide-react'
import { api } from '../../api'
import { formatBytes, kindOf } from '../../lib/uploads'
import type { Attachment } from '../../types'

interface AttachmentViewProps {
  attachment: Attachment
  channelId: string
}

function srcOf(a: Attachment): string {
  return a.proxy_url || a.url
}

function constrainedStyle(a: Attachment): CSSProperties | undefined {
  if (a.width && a.height && a.width > 0 && a.height > 0) {
    const ratio = a.height / a.width
    const maxW = Math.min(a.width, 400)
    return { width: maxW, aspectRatio: `${a.width} / ${a.height}`, maxHeight: Math.min(350, Math.round(maxW * ratio)) || 350 }
  }
  return undefined
}

export function AttachmentView({ attachment, channelId }: AttachmentViewProps) {
  const [src, setSrc] = useState(() => srcOf(attachment))
  const [refreshed, setRefreshed] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  if (attachment.status !== 'ready') {
    return (
      <div className="attachment attachment-pending">
        <Loader2 size={16} className="spin" />
        <span>{attachment.status === 'failed' ? 'Processing failed' : 'Processing…'}</span>
      </div>
    )
  }

  // Signed URLs expire (Discord-style refresh): on first media error, refetch
  // metadata once and retry before surfacing a broken tile.
  const refreshOnce = () => {
    if (refreshed) return
    setRefreshed(true)
    api
      .getAttachment(channelId, attachment.id)
      .then((fresh) => {
        const next = srcOf(fresh)
        if (next && next !== src) setSrc(next)
      })
      .catch(() => {})
  }

  const kind = kindOf(attachment.content_type, attachment.filename)

  if (kind === 'image') {
    return (
      <>
        <button
          type="button"
          className="attachment attachment-image"
          onClick={() => setLightbox(true)}
          title={`${attachment.filename} · ${formatBytes(attachment.size)} (click to expand)`}
        >
          <img src={src} alt={attachment.filename} loading="lazy" style={constrainedStyle(attachment)} onError={refreshOnce} />
        </button>
        {lightbox && (
          <div className="attachment-lightbox" onClick={() => setLightbox(false)} role="dialog" aria-label={attachment.filename}>
            <img src={src} alt={attachment.filename} onError={refreshOnce} />
          </div>
        )}
      </>
    )
  }

  if (kind === 'video') {
    const poster = posterOf(attachment)
    return (
      <div className="attachment attachment-video">
        <div className="attachment-video-badge" title="Video">
          <Film size={14} />
        </div>
        <video src={src} poster={poster} controls preload="metadata" onError={refreshOnce} />
        <a className="attachment-name" href={src} download={attachment.filename} title={`Download ${attachment.filename}`}>
          {attachment.filename} · {formatBytes(attachment.size)}
        </a>
      </div>
    )
  }

  if (kind === 'audio') {
    return (
      <div className="attachment attachment-audio">
        <Music size={16} />
        <div className="attachment-audio-body">
          <span className="attachment-name" title={attachment.filename}>
            {attachment.filename}
          </span>
          <audio src={src} controls preload="metadata" onError={refreshOnce} />
        </div>
      </div>
    )
  }

  return (
    <a
      className="attachment attachment-file"
      href={src}
      download={attachment.filename}
      title={`Download ${attachment.filename} (${formatBytes(attachment.size)})`}
    >
      <FileText size={20} />
      <span className="attachment-file-meta">
        <span className="attachment-name">{attachment.filename}</span>
        <span className="attachment-size">{formatBytes(attachment.size)}</span>
      </span>
    </a>
  )
}

/** Prefer a worker-generated poster frame when the thumbnails map carries one. */
function posterOf(a: Attachment): string | undefined {
  const thumbs = a.thumbnails as Record<string, unknown> | null | undefined
  if (!thumbs) return undefined
  for (const key of ['poster', 'thumbnail', 'preview']) {
    const v = thumbs[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (v && typeof v === 'object') {
      const url = (v as Record<string, unknown>).url
      if (typeof url === 'string' && url.length > 0) return url
    }
  }
  return undefined
}
