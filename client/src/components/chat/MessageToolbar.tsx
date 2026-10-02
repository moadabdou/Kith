import React from 'react'
import { Pencil, Pin, Reply, SmilePlus, Trash2 } from 'lucide-react'
import type { Message } from '../../types'

export interface MessageToolbarProps {
  message: Message
  canEdit: boolean
  canDelete: boolean
  canPin: boolean
  canReply: boolean
  canAddReaction: boolean
  onQuickReaction: (emoji: string) => void
  onOpenReactionPicker: (e: React.MouseEvent) => void
  onReply: () => void
  onEdit: () => void
  onPin?: () => void
  onDelete: () => void
}

const QUICK_REACTIONS = ['👍', '❤️', '🔥']

export const MessageToolbar: React.FC<MessageToolbarProps> = ({
  message,
  canEdit,
  canDelete,
  canPin,
  canReply,
  canAddReaction,
  onQuickReaction,
  onOpenReactionPicker,
  onReply,
  onEdit,
  onPin,
  onDelete,
}) => {
  // If no action is permitted, do not render anything
  if (!canAddReaction && !canReply && !canEdit && !canPin && !canDelete) {
    return null
  }

  return (
    <div className="message-toolbar" role="toolbar" aria-label="Message actions">
      {canAddReaction && (
        <div className="message-toolbar-group">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="message-toolbar-btn quick-reaction-btn"
              title={`React with ${emoji}`}
              aria-label={`React with ${emoji}`}
              onClick={(e) => {
                e.stopPropagation()
                onQuickReaction(emoji)
              }}
            >
              <span className="quick-emoji">{emoji}</span>
            </button>
          ))}
        </div>
      )}

      {canAddReaction && (
        <button
          type="button"
          className="message-toolbar-btn"
          title="Add Reaction"
          aria-label="Add Reaction"
          onClick={(e) => {
            e.stopPropagation()
            onOpenReactionPicker(e)
          }}
        >
          <SmilePlus size={18} />
        </button>
      )}

      {canReply && (
        <button
          type="button"
          className="message-toolbar-btn"
          title="Reply"
          aria-label="Reply"
          onClick={(e) => {
            e.stopPropagation()
            onReply()
          }}
        >
          <Reply size={18} />
        </button>
      )}

      {canEdit && (
        <button
          type="button"
          className="message-toolbar-btn"
          title="Edit"
          aria-label="Edit"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          <Pencil size={18} />
        </button>
      )}

      {canPin && (
        <button
          type="button"
          className={`message-toolbar-btn ${message?.pinned ? 'is-pinned active' : ''}`}
          title={message?.pinned ? "Unpin Message" : "Pin Message"}
          aria-label={message?.pinned ? "Unpin Message" : "Pin Message"}
          onClick={(e) => {
            e.stopPropagation()
            onPin?.()
          }}
        >
          <Pin size={18} fill={message?.pinned ? "currentColor" : "none"} />
        </button>
      )}

      {canDelete && (
        <button
          type="button"
          className="message-toolbar-btn message-toolbar-btn-danger"
          title="Delete"
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 size={18} />
        </button>
      )}
    </div>
  )
}
