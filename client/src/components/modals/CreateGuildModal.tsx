import { useState, type FormEvent } from 'react'

interface CreateGuildModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
  onJoin: (code: string) => Promise<void>
}

export function CreateGuildModal({ isOpen, onClose, onCreate, onJoin }: CreateGuildModalProps) {
  const [tab, setTab] = useState<'create' | 'join'>('create')
  const [name, setName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setName('')
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to create server')
    } finally {
      setSubmitting(false)
    }
  }

  const handleJoinSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!inviteCode.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onJoin(inviteCode.trim())
      setInviteCode('')
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to join server. Check the invite code.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Tab switcher */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            marginBottom: 4,
          }}
        >
          <button
            type="button"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              padding: '14px 16px',
              color: tab === 'create' ? 'var(--text-header)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              borderBottom: tab === 'create' ? '2px solid var(--brand)' : '2px solid transparent',
              transition: 'all 0.15s ease',
            }}
            onClick={() => {
              setTab('create')
              setError(null)
            }}
          >
            Create a Server
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              padding: '14px 16px',
              color: tab === 'join' ? 'var(--text-header)' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              borderBottom: tab === 'join' ? '2px solid var(--brand)' : '2px solid transparent',
              transition: 'all 0.15s ease',
            }}
            onClick={() => {
              setTab('join')
              setError(null)
            }}
          >
            Join a Server
          </button>
        </div>

        {tab === 'create' ? (
          <>
            <div className="modal-header">
              <h3 className="modal-title">Customize your server</h3>
              <p className="modal-subtitle">
                Give your new server a personality with a name. You can always change it later.
              </p>
            </div>

            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                {error && <div className="error-banner">{error}</div>}
                <div className="form-group">
                  <label className="form-label">Server Name</label>
                  <input
                    type="text"
                    className="form-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Awesome Server"
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
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="modal-header">
              <h3 className="modal-title">Join a Server</h3>
              <p className="modal-subtitle">
                Enter an invite code or link below to join an existing server.
              </p>
            </div>

            <form onSubmit={handleJoinSubmit}>
              <div className="modal-body">
                {error && <div className="error-banner">{error}</div>}
                <div className="form-group">
                  <label className="form-label">Invite Code or Link</label>
                  <input
                    type="text"
                    className="form-input"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="e.g. h8aB2k9 or http://localhost/join/h8aB2k9"
                    required
                    autoFocus
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    INVITES SHOULD LOOK LIKE <code>h8aB2k9</code> OR <code>http://localhost/join/h8aB2k9</code>
                  </span>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={submitting || !inviteCode.trim()}
                >
                  {submitting ? 'Joining…' : 'Join Server'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
