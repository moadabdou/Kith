import React, { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { Message } from '../../types'
import { ParentQuote } from './ParentQuote'

export interface DeleteMessageModalProps {
  message: Message
  isDeleting: boolean
  onConfirm: () => void
  onClose: () => void
}

export const DeleteMessageModal: React.FC<DeleteMessageModalProps> = ({
  message,
  isDeleting,
  onConfirm,
  onClose,
}) => {
  const modalRef = useRef<HTMLDivElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Focus confirm button on open & handle Escape key
  useEffect(() => {
    confirmBtnRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && !isDeleting) {
        // Prevent enter from bubbling if inside textarea, etc.
        e.preventDefault()
        onConfirm()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onConfirm, isDeleting])

  const authorInitials = message.author?.username
    ? message.author.username.substring(0, 2).toUpperCase()
    : 'U'

  const formattedTime = new Date(message.timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) {
          onClose()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-message-title"
    >
      <div className="delete-modal-card" ref={modalRef}>
        <div className="delete-modal-header">
          <h2 id="delete-message-title" className="delete-modal-title">
            Delete Message
          </h2>
          <p className="delete-modal-subtitle">
            Are you sure you want to delete this message? This cannot be undone.
          </p>
        </div>

        {/* Preview box */}
        <div className="delete-modal-preview">
          {message.reply_to && (
            <ParentQuote
              replyToId={message.reply_to}
              referencedMessage={message.referenced_message}
            />
          )}
          <div className="delete-modal-preview-inner">
            <div className="user-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
              {authorInitials}
            </div>
            <div className="delete-modal-preview-content">
              <div className="delete-modal-preview-meta">
                <span className="message-author">{message.author?.username ?? 'Unknown'}</span>
                <span className="message-time">{formattedTime}</span>
              </div>
              <div className="delete-modal-preview-text">{message.content}</div>
              {message.attachments && message.attachments.length > 0 && (
                <div className="delete-modal-preview-attachments">
                  {message.attachments.length} attachment{message.attachments.length > 1 ? 's' : ''}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Modal actions */}
        <div className="delete-modal-footer">
          <button
            type="button"
            className="delete-modal-cancel-btn"
            onClick={onClose}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className="delete-modal-confirm-btn"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 size={16} className="spin-animation" style={{ marginRight: 6 }} />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
