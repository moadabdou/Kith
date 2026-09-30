import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatBytes,
  kindOf,
  nextUploadKey,
  runPendingUpload,
  validateFile,
  MAX_PENDING_FILES,
  MAX_UPLOAD_BYTES,
  type PendingUpload,
} from './uploads'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    presignAttachment: vi.fn(),
  },
}))

function makeFile(name: string, size: number, type: string): File {
  const blob = new Blob([new Uint8Array(size)], { type })
  return new File([blob], name, { type })
}

describe('formatBytes', () => {
  it('formats bytes, KB, MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB')
  })
})

describe('kindOf', () => {
  it('classifies by content-type first', () => {
    expect(kindOf('image/png', 'a.bin')).toBe('image')
    expect(kindOf('video/mp4', 'a.bin')).toBe('video')
    expect(kindOf('audio/mpeg', 'a.bin')).toBe('audio')
    expect(kindOf('application/pdf', 'a.pdf')).toBe('file')
  })
  it('falls back to extension', () => {
    expect(kindOf('', 'photo.jpg')).toBe('image')
    expect(kindOf('', 'clip.webm')).toBe('video')
    expect(kindOf('', 'song.ogg')).toBe('audio')
    expect(kindOf('', 'archive.zip')).toBe('file')
  })
})

describe('validateFile', () => {
  it('rejects empty and oversized files', () => {
    expect(validateFile(makeFile('e.png', 0, 'image/png'))).toMatch(/empty/i)
    const big = { name: 'big.bin', size: MAX_UPLOAD_BYTES + 1, type: 'application/octet-stream' } as File
    expect(validateFile(big)).toMatch(/too large/i)
    expect(validateFile(makeFile('ok.png', 10, 'image/png'))).toBeNull()
  })
  it('stays consistent with server default and pending cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024)
    expect(MAX_PENDING_FILES).toBe(10)
  })
})

describe('nextUploadKey', () => {
  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 50 }, () => nextUploadKey()))
    expect(keys.size).toBe(50)
  })
})

class FakeXHR {
  static instances: FakeXHR[] = []
  upload: { onprogress: ((ev: any) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 200
  aborted = false
  constructor() {
    FakeXHR.instances.push(this)
  }
  open() {}
  send() {}
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  succeed() {
    this.status = 200
    this.onload?.()
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total })
  }
}

describe('runPendingUpload', () => {
  beforeEach(() => {
    FakeXHR.instances = []
    vi.stubGlobal('XMLHttpRequest', FakeXHR as any)
    vi.mocked(api.presignAttachment).mockReset()
  })

  it('presigns, PUTs with progress, and resolves the attachment id', async () => {
    vi.mocked(api.presignAttachment).mockResolvedValue({
      id: 'att-1',
      upload_url: 'http://localhost:9000/attachments/k?sig',
      s3_key: 'k',
      expires_at: new Date().toISOString(),
    })
    const patches: Partial<PendingUpload>[] = []
    const file = makeFile('cat.png', 100, 'image/png')
    const done = runPendingUpload('chan-1', file, (p) => patches.push(p), () => {})
    // let presign resolve
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(FakeXHR.instances).toHaveLength(1)
    FakeXHR.instances[0].progress(50, 100)
    FakeXHR.instances[0].succeed()
    const id = await done
    expect(id).toBe('att-1')
    const states = patches.map((p) => p.state).filter(Boolean)
    expect(states[0]).toBe('presigning')
    expect(states).toContain('uploading')
    expect(states[states.length - 1]).toBe('uploaded')
    expect(vi.mocked(api.presignAttachment)).toHaveBeenCalledWith('chan-1', {
      filename: 'cat.png',
      content_type: 'image/png',
      byte_size: 100,
    })
  })

  it('surfaces PUT failures as errors', async () => {
    vi.mocked(api.presignAttachment).mockResolvedValue({
      id: 'att-2',
      upload_url: 'http://localhost:9000/x',
      s3_key: 'k',
      expires_at: new Date().toISOString(),
    })
    const file = makeFile('cat.png', 100, 'image/png')
    const done = runPendingUpload('chan-1', file, () => {}, () => {})
    await new Promise((r) => setTimeout(r, 0))
    const xhr = FakeXHR.instances[0]
    xhr.status = 403
    xhr.onload?.()
    await expect(done).rejects.toThrow(/403/)
  })
})
