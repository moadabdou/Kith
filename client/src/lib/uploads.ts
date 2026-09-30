import { api } from '../api'

// Discord-style client upload pipeline (Phase 8 media):
//   presign (REST) -> PUT bytes direct to storage (XHR, progress) ->
//   complete at send time (REST) -> send message with attachment ids.
//
// PUT happens at selection time so progress is visible immediately;
// complete runs at send time so cancelled/forgotten uploads never finalize
// (the server's abandoned-upload pruner reaps the staging rows).

export type PendingState = 'presigning' | 'uploading' | 'uploaded' | 'error' | 'cancelled'

export interface PendingUpload {
  key: string
  file: File
  filename: string
  size: number
  contentType: string
  state: PendingState
  /** 0..1 fraction of bytes PUT to storage (meaningful while uploading). */
  progress: number
  /** Server attachment id once presigned; sent with the message after complete. */
  attachmentId?: string
  uploadUrl?: string
  error?: string
}

/** Discord allows up to 10 files per message. */
export const MAX_PENDING_FILES = 10

/** Mirrors the server MAX_UPLOAD_BYTES default (25 MiB); server is truth. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

let keySeq = 0
export function nextUploadKey(): string {
  keySeq += 1
  return `pending-${Date.now().toString(36)}-${keySeq}`
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export function kindOf(contentType: string, filename = ''): AttachmentKind {
  const ct = (contentType || '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio'
  return 'file'
}

/** Client-side pre-check; the server re-validates (size cap, MIME sniff). */
export function validateFile(file: File): string | null {
  if (file.size <= 0) return 'File is empty'
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File is too large (${formatBytes(file.size)} > ${formatBytes(MAX_UPLOAD_BYTES)})`
  }
  return null
}

export interface PutHandle {
  promise: Promise<void>
  abort: () => void
}

/**
 * PUTs bytes to a presigned URL with upload-progress callbacks.
 * XHR is used deliberately: fetch has no upload-progress signal.
 * No Content-Type override is set — the presigned URL carries no signed
 * headers, so the browser default for the Blob applies.
 */
export function putWithProgress(
  url: string,
  file: File | Blob,
  onProgress: (fraction: number) => void
): PutHandle {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<void>((resolve, reject) => {
    xhr.open('PUT', url)
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(1, ev.loaded / ev.total))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed (network error)'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

/**
 * Runs one pending upload through presign -> PUT. Mutations are reported
 * through patch callbacks so the owner (React state) stays the source of
 * truth; the returned promise resolves when bytes are stored.
 */
export async function runPendingUpload(
  channelId: string,
  file: File,
  patch: (p: Partial<PendingUpload>) => void,
  trackXhr: (xhr: { abort: () => void } | null) => void
): Promise<string> {
  patch({ state: 'presigning', progress: 0, error: undefined })
  const presigned = await api.presignAttachment(channelId, {
    filename: file.name || 'attachment',
    content_type: file.type || 'application/octet-stream',
    byte_size: file.size,
  })
  patch({ state: 'uploading', attachmentId: presigned.id, uploadUrl: presigned.upload_url })
  const handle = putWithProgress(presigned.upload_url, file, (fraction) =>
    patch({ progress: fraction })
  )
  trackXhr(handle)
  try {
    await handle.promise
  } finally {
    trackXhr(null)
  }
  patch({ state: 'uploaded', progress: 1 })
  return presigned.id
}
