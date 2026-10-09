import { useState, useEffect, type CSSProperties } from 'react'
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
  const [current, setCurrent] = useState(() => attachment)
  const [src, setSrc] = useState(() => srcOf(attachment))
  const [refreshed, setRefreshed] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  // Keep internal state in sync with parent updates
  useEffect(() => {
    setCurrent(attachment)
    setSrc(srcOf(attachment))
  }, [attachment])

  // Bounded fallback timer (2s, 5s) if mounted as pending (safety net for severe lag / socket drops)
  useEffect(() => {
    if (current.status !== 'pending') return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const delays = [2000, 3000, 5000, 5000, 10000]
    let attempt = 0

    const check = () => {
      if (cancelled || attempt >= delays.length) return
      const delay = delays[attempt++]

      timer = setTimeout(() => {
        if (cancelled) return
        api
          .getAttachment(channelId, current.id)
          .then((fresh) => {
            if (cancelled) return
            if (fresh.status !== 'pending') {
              setCurrent(fresh)
              setSrc(srcOf(fresh))
              return
            }
            check()
          })
          .catch(() => {
            if (!cancelled) check()
          })
      }, delay)
    }

    check()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [current.id, current.status, channelId])

  if (current.status !== 'ready') {
    return (
      <div className="attachment attachment-pending">
        <Loader2 size={16} className="spin" />
        <span>{current.status === 'failed' ? 'Processing failed' : 'Processing…'}</span>
      </div>
    )
  }

  // Signed URLs expire (Discord-style refresh): on first media error, refetch
  // metadata once and retry before surfacing a broken tile.
  const refreshOnce = () => {
    if (refreshed) return
    setRefreshed(true)
    api
      .getAttachment(channelId, current.id)
      .then((fresh) => {
        const next = srcOf(fresh)
        if (next && next !== src) setSrc(next)
      })
      .catch(() => {})
  }

  const kind = kindOf(current.content_type, current.filename)

  if (kind === 'image') {
    return (
      <>
        <button
          type="button"
          className="attachment attachment-image"
          onClick={() => setLightbox(true)}
          title={`${current.filename} · ${formatBytes(current.size)} (click to expand)`}
        >
          <img src={src} alt={current.filename} loading="lazy" style={constrainedStyle(current)} onError={refreshOnce} />
        </button>
        {lightbox && (
          <div className="attachment-lightbox" onClick={() => setLightbox(false)} role="dialog" aria-label={current.filename}>
            <img src={src} alt={current.filename} onError={refreshOnce} />
          </div>
        )}
      </>
    )
  }

  if (kind === 'video') {
    const poster = posterOf(current)
    return (
      <div className="attachment attachment-video">
        <div className="attachment-video-badge" title="Video">
          <Film size={14} />
        </div>
        <video src={src} poster={poster} controls preload="metadata" onError={refreshOnce} />
        <a className="attachment-name" href={src} download={current.filename} title={`Download ${current.filename}`}>
          {current.filename} · {formatBytes(current.size)}
        </a>
      </div>
    )
  }

  if (kind === 'audio') {
    return (
      <div className="attachment attachment-audio">
        <Music size={16} />
        <div className="attachment-audio-body">
          <span className="attachment-name" title={current.filename}>
            {current.filename}
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
      download={current.filename}
      title={`Download ${current.filename} (${formatBytes(current.size)})`}
    >
      <FileText size={20} />
      <span className="attachment-file-meta">
        <span className="attachment-name">{current.filename}</span>
        <span className="attachment-size">{formatBytes(current.size)}</span>
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
