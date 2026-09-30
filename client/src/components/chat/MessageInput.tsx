import { useRef, type FormEvent } from 'react'
import { AlertCircle, FileText, Loader2, Plus, Send, X } from 'lucide-react'
import type { PendingUpload } from '../../lib/uploads'
import { formatBytes } from '../../lib/uploads'

interface MessageInputProps {
  channelName: string
  canSend: boolean
  inputText: string
  onChange: (value: string) => void
  onSend: (e: FormEvent) => void
  sending?: boolean
  canAttach: boolean
  pending: PendingUpload[]
  hasReadyUploads: boolean
  uploadsBlocked: boolean
  onPickFiles: (files: File[]) => void
  onRemovePending: (key: string) => void
}

export function MessageInput({
  channelName,
  canSend,
  inputText,
  onChange,
  onSend,
  sending = false,
  canAttach,
  pending,
  hasReadyUploads,
  uploadsBlocked,
  onPickFiles,
  onRemovePending,
}: MessageInputProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const placeholder = canSend
    ? `Message #${channelName}`
    : 'You do not have permission to send messages in this channel'
  const canSubmit = canSend && !sending && !uploadsBlocked && (inputText.trim() !== '' || hasReadyUploads)

  return (
    <div className={`chat-input-container ${!canSend ? 'disabled' : ''}`}>
      {canSend && pending.length > 0 && (
        <div className="pending-uploads" aria-live="polite">
          {pending.map((p) => (
            <div key={p.key} className={`pending-upload pending-${p.state}`}>
              <FileText size={16} className="pending-upload-icon" />
              <div className="pending-upload-meta">
                <span className="pending-upload-name" title={p.filename}>
                  {p.filename}
                </span>
                <span className="pending-upload-sub">
                  {p.state === 'error' ? (
                    <span className="pending-upload-error">
                      <AlertCircle size={12} /> {p.error ?? 'Upload failed'}
                    </span>
                  ) : p.state === 'uploaded' ? (
                    formatBytes(p.size)
                  ) : (
                    `${Math.round(p.progress * 100)}% · ${formatBytes(p.size)}`
                  )}
                </span>
                {(p.state === 'presigning' || p.state === 'uploading') && (
                  <span
                    className="pending-upload-bar"
                    role="progressbar"
                    aria-valuenow={Math.round(p.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      className="pending-upload-bar-fill"
                      style={{ width: `${Math.round(p.progress * 100)}%` }}
                    />
                  </span>
                )}
              </div>
              {p.state === 'uploading' || p.state === 'presigning' ? (
                <Loader2 size={14} className="spin pending-upload-spinner" />
              ) : (
                <button
                  type="button"
                  className="pending-upload-remove"
                  onClick={() => onRemovePending(p.key)}
                  title={p.state === 'error' ? 'Dismiss' : 'Remove attachment'}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={canSend ? onSend : (e) => e.preventDefault()}
        className={`chat-input-bar ${!canSend ? 'disabled' : ''}`}
      >
        {canSend && canAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : []
                e.target.value = ''
                if (files.length > 0) onPickFiles(files)
              }}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileRef.current?.click()}
              title="Upload a file"
            >
              <Plus size={18} />
            </button>
          </>
        )}
        <input
          type="text"
          className="chat-input"
          value={canSend ? inputText : ''}
          onChange={(e) => canSend && onChange(e.target.value)}
          placeholder={placeholder}
          disabled={!canSend || sending}
          autoFocus={canSend}
          title={!canSend ? 'You do not have permission to send messages in this channel' : undefined}
        />
        {canSend && (
          <button
            type="submit"
            className="send-btn"
            disabled={!canSubmit}
            title={uploadsBlocked ? 'Waiting for uploads to finish' : 'Send Message'}
          >
            <Send size={18} />
          </button>
        )}
      </form>
    </div>
  )
}
