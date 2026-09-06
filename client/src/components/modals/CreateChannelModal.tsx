import { useState, type FormEvent } from 'react'

interface CreateChannelModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}

export function CreateChannelModal({ isOpen, onClose, onCreate }: CreateChannelModalProps) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    // normalize channel name (lowercase, dashes)
    const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!normalized) return

    setSubmitting(true)
    setError(null)
    try {
      await onCreate(normalized)
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
          <p className="modal-subtitle">in Text Channels</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="error-banner">{error}</div>}
            <div className="form-group">
              <label className="form-label">Channel Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="new-channel"
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
