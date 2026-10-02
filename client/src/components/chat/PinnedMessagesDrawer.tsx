import { useEffect, useState, useCallback, useRef } from 'react'
import { Pin, X, ArrowRight, Loader2, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useGateway } from '../../gateway/useGateway'
import { MarkdownView } from '../../lib/markdown'
import type { Channel, Message } from '../../types'
import { AttachmentView } from './AttachmentView'

export interface PinnedMessagesDrawerProps {
  isOpen: boolean
  onClose: () => void
  channel: Channel | null
  canManageMessages: boolean
  onJumpToMessage: (messageId: string) => void
}

export function PinnedMessagesDrawer({
  isOpen,
  onClose,
  channel,
  canManageMessages,
  onJumpToMessage,
}: PinnedMessagesDrawerProps) {
  const { subscribeToChannelPinsUpdate, subscribeToMessageDeletes, subscribeToMessageUpdates } = useGateway()
  const [pins, setPins] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unpinningId, setUnpinningId] = useState<string | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  const fetchPins = useCallback(async () => {
    if (!channel) return
    try {
      setLoading(true)
      setError(null)
      const data = await api.getPinnedMessages(channel.id)
      setPins(data || [])
    } catch (err: any) {
      console.error('Failed to load pinned messages:', err)
      setError(err?.message || 'Failed to load pinned messages')
    } finally {
      setLoading(false)
    }
  }, [channel])

  // Fetch when opened or channel changed
  useEffect(() => {
    if (isOpen && channel) {
      fetchPins()
    }
  }, [isOpen, channel, fetchPins])

  // Real-time updates via Gateway
  useEffect(() => {
    if (!isOpen || !channel) return

    const unsubPins = subscribeToChannelPinsUpdate((payload) => {
      if (payload.channel_id === channel.id) {
        fetchPins()
      }
    })

    const unsubDelete = subscribeToMessageDeletes((payload) => {
      if (payload.channel_id === channel.id) {
        setPins((prev) => prev.filter((p) => p.id !== payload.id))
      }
    })

    const unsubUpdate = subscribeToMessageUpdates((msg) => {
      if (msg.channel_id === channel.id) {
        setPins((prev) =>
          prev.map((p) => (p.id === msg.id ? { ...p, ...msg, content: msg.content ?? p.content } : p))
        )
      }
    })

    return () => {
      unsubPins()
      unsubDelete()
      unsubUpdate()
    }
  }, [isOpen, channel, fetchPins, subscribeToChannelPinsUpdate, subscribeToMessageDeletes, subscribeToMessageUpdates])

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleUnpin = async (messageId: string) => {
    if (!channel) return
    try {
      setUnpinningId(messageId)
      await api.unpinMessage(channel.id, messageId)
      setPins((prev) => prev.filter((p) => p.id !== messageId))
    } catch (err: any) {
      console.error('Failed to unpin message:', err)
      setError(err?.message || 'Failed to unpin message')
    } finally {
      setUnpinningId(null)
    }
  }

  const formatPinTimestamp = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ts
    }
  }

  if (!isOpen) return null

  return (
    <aside
      ref={drawerRef}
      className="pinned-drawer"
      role="dialog"
      aria-label="Pinned Messages"
      aria-modal="false"
    >
      {/* Drawer Header */}
      <div className="pinned-drawer-header">
        <div className="pinned-drawer-title-row">
          <div className="pinned-drawer-title">
            <Pin size={18} className="pinned-header-icon" />
            <span>Pinned Messages</span>
            <span className="pinned-count-badge">{pins.length} / 50</span>
          </div>
          <button
            type="button"
            className="pinned-close-btn"
            onClick={onClose}
            title="Close Pins"
            aria-label="Close Pins"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Drawer Content */}
      <div className="pinned-drawer-content">
        {loading && pins.length === 0 && (
          <div className="pinned-loading-state">
            <Loader2 size={24} className="spin" />
            <span>Loading pinned messages...</span>
          </div>
        )}

        {error && (
          <div className="pinned-error-banner">
            <span>{error}</span>
          </div>
        )}

        {!loading && pins.length === 0 && !error && (
          <div className="pinned-empty-state">
            <div className="pinned-empty-icon-circle">
              <Pin size={32} />
            </div>
            <h3>No pinned messages yet</h3>
            <p>
              Pin important messages here so anyone in #{channel?.name || 'this channel'} can easily find them later.
            </p>
          </div>
        )}

        {pins.length > 0 && (
          <div className="pinned-list">
            {pins.map((pin) => (
              <div key={pin.id} className="pinned-item-card">
                {/* Pin Card Header */}
                <div className="pinned-item-header">
                  <div className="user-avatar" style={{ width: 32, height: 32, fontSize: 13 }}>
                    {pin.author?.username?.substring(0, 2).toUpperCase() ?? 'U'}
                  </div>
                  <div className="pinned-item-meta">
                    <span className="pinned-item-author">{pin.author?.username || 'Unknown'}</span>
                    <span className="pinned-item-time">{formatPinTimestamp(pin.timestamp)}</span>
                  </div>
                  <div className="pinned-item-actions">
                    <button
                      type="button"
                      className="pinned-jump-btn"
                      onClick={() => onJumpToMessage(pin.id)}
                      title="Jump to message"
                      aria-label="Jump to message"
                    >
                      <span>Jump</span>
                      <ArrowRight size={14} />
                    </button>
                    {canManageMessages && (
                      <button
                        type="button"
                        className="pinned-unpin-btn"
                        onClick={() => handleUnpin(pin.id)}
                        disabled={unpinningId === pin.id}
                        title="Unpin message"
                        aria-label="Unpin message"
                      >
                        {unpinningId === pin.id ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Pin Card Body */}
                <div className="pinned-item-body">
                  <MarkdownView content={pin.content} />
                </div>

                {/* Attachments if any */}
                {pin.attachments && pin.attachments.length > 0 && (
                  <div className="pinned-item-attachments">
                    {pin.attachments.map((att) => (
                      <AttachmentView key={att.id} channelId={channel?.id || ''} attachment={att} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
