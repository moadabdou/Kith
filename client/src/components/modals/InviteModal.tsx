import { useState, useEffect } from 'react'
import { Check, Copy, Link, X } from 'lucide-react'
import { api } from '../../api'
import type { Channel, Guild, Invite } from '../../types'

interface InviteModalProps {
  isOpen: boolean
  onClose: () => void
  guild: Guild | null
  channel: Channel | null
}

export function InviteModal({ isOpen, onClose, guild, channel }: InviteModalProps) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!channel) {
      return
    }

    let isMounted = true

    api.createInvite(channel.id)
      .then((inv) => {
        if (isMounted) {
          setInvite(inv)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message || 'Failed to generate invite')
          setLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [channel])

  if (!isOpen) return null

  const inviteUrl = invite ? `${window.location.origin}/join/${invite.code}` : ''

  const handleCopy = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback copy
      const el = document.createElement('textarea')
      el.value = inviteUrl
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
          onClick={onClose}
        >
          <X size={20} />
        </div>

        <div className="modal-header">
          <h3 className="modal-title">Invite friends to {guild?.name ?? 'Server'}</h3>
          <p className="modal-subtitle">
            Direct them to <strong style={{ color: 'var(--text-header)' }}>#{channel?.name ?? 'general'}</strong>
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="form-group">
            <label className="form-label">Send a server invite link or code to a friend</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div
                style={{
                  position: 'relative',
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <input
                  type="text"
                  className="form-input"
                  style={{ width: '100%', paddingRight: 36 }}
                  readOnly
                  value={loading ? 'Generating invite code…' : invite ? inviteUrl : ''}
                />
                <Link
                  size={16}
                  style={{
                    position: 'absolute',
                    right: 12,
                    color: 'var(--text-muted)',
                    pointerEvents: 'none',
                  }}
                />
              </div>

              <button
                type="button"
                className="btn-primary"
                onClick={handleCopy}
                disabled={loading || !invite}
                style={{
                  backgroundColor: copied ? '#23a55a' : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 90,
                  justifyContent: 'center',
                }}
              >
                {copied ? (
                  <>
                    <Check size={16} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={16} /> Copy
                  </>
                )}
              </button>
            </div>

            {invite && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Invite code: <strong style={{ color: 'var(--brand)', fontFamily: 'monospace' }}>{invite.code}</strong>
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Expires in 24 hours
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
