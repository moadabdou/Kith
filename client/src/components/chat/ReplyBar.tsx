import { useEffect } from 'react'
import { Reply, X } from 'lucide-react'
import type { Message } from '../../types'

interface ReplyBarProps {
  replyingTo: Message
  onCancel: () => void
}

export function ReplyBar({ replyingTo, onCancel }: ReplyBarProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onCancel])

  const username = replyingTo.author?.username || 'Unknown'

  return (
    <div className="reply-bar" role="region" aria-label="Reply composer indicator">
      <div className="reply-bar-info">
        <Reply size={16} className="reply-bar-icon" />
        <span className="reply-bar-text">
          Replying to <span className="reply-bar-target">@{username}</span>
        </span>
      </div>
      <button
        type="button"
        className="reply-bar-close"
        onClick={onCancel}
        title="Cancel reply (Escape)"
        aria-label="Cancel reply"
      >
        <X size={14} />
      </button>
    </div>
  )
}
