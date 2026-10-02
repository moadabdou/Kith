import type { ReferencedMsg } from '../../types'

interface ParentQuoteProps {
  replyToId: string
  referencedMessage?: ReferencedMsg | null
  onJump?: (targetId: string) => void
}

export function ParentQuote({ replyToId, referencedMessage, onJump }: ParentQuoteProps) {
  const handleClick = () => {
    onJump?.(replyToId)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onJump?.(replyToId)
    }
  }

  const isDeleted = !referencedMessage

  return (
    <div
      className={`parent-quote ${isDeleted ? 'is-deleted' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      title={isDeleted ? 'Original message was deleted' : 'Jump to referenced message'}
      aria-label={isDeleted ? 'Original message was deleted' : `Jump to message by ${referencedMessage?.author?.username}`}
    >
      {/* Discord-style curved spine connector */}
      <div className="reply-spine" aria-hidden="true" />

      {isDeleted ? (
        <span className="reply-quote-deleted">Original message was deleted</span>
      ) : (
        <div className="reply-quote-body">
          <div className="reply-quote-avatar">
            {referencedMessage.author?.username?.substring(0, 1).toUpperCase() || '?'}
          </div>
          <span className="reply-quote-username">
            @{referencedMessage.author?.username || 'Unknown'}
          </span>
          <span className="reply-quote-text">
            {referencedMessage.content || '(attachment)'}
          </span>
        </div>
      )}
    </div>
  )
}
