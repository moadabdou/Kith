import { useEffect, useState, type FormEvent } from 'react'
import { Hash, Volume2 } from 'lucide-react'

interface CreateChannelModalProps {
  isOpen: boolean
  initialType?: number
  onClose: () => void
  onCreate: (name: string, type?: number) => Promise<void>
}

export function CreateChannelModal({
  isOpen,
  initialType = 0,
  onClose,
  onCreate,
}: CreateChannelModalProps) {
  const [name, setName] = useState('')
  const [channelType, setChannelType] = useState<number>(initialType)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setChannelType(initialType)
      setName('')
      setError(null)
    }
  }, [isOpen, initialType])

  if (!isOpen) return null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    // normalize channel name (lowercase, dashes)
    const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!normalized) return

    setSubmitting(true)
    setError(null)
    try {
      await onCreate(normalized, channelType)
      setName('')
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to create channel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Create Channel</h3>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="error-banner">{error}</div>}

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label" style={{ marginBottom: 8, display: 'block' }}>
                Channel Type
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  className={`channel-type-option ${channelType === 0 ? 'selected' : ''}`}
                  onClick={() => setChannelType(0)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 6,
                    backgroundColor: channelType === 0 ? 'var(--bg-active)' : 'var(--bg-input)',
                    border: `1px solid ${channelType === 0 ? 'var(--brand)' : 'transparent'}`,
                    cursor: 'pointer',
                  }}
                >
                  <Hash size={24} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-header)' }}>
                      Text
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Post messages, images, and chat with members
                    </div>
                  </div>
                </div>

                <div
                  className={`channel-type-option ${channelType === 2 ? 'selected' : ''}`}
                  onClick={() => setChannelType(2)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 6,
                    backgroundColor: channelType === 2 ? 'var(--bg-active)' : 'var(--bg-input)',
                    border: `1px solid ${channelType === 2 ? 'var(--brand)' : 'transparent'}`,
                    cursor: 'pointer',
                  }}
                >
                  <Volume2 size={24} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-header)' }}>
                      Voice
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Hang out together with voice and audio
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Channel Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={channelType === 2 ? 'General Voice' : 'new-channel'}
                required
                autoFocus
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !name.trim()}
            >
              {submitting ? 'Creating…' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
