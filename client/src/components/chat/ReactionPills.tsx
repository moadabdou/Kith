import { SmilePlus } from 'lucide-react'
import type { ReactionTally } from '../../types'

export interface ReactionPillsProps {
  reactions: ReactionTally[]
  onToggleReaction: (emoji: string) => void
  onOpenPicker?: (e: React.MouseEvent) => void
  canAddReaction?: boolean
}

function renderEmojiDisplay(emoji: string) {
  const match = /^<?(?:a)?:?([a-zA-Z0-9_]{2,32}):([0-9]+)>?$/.exec(emoji)
  if (match) {
    const name = match[1]
    const id = match[2]
    return (
      <img
        src={`/emojis/${id}.png`}
        alt={`:${name}:`}
        title={`:${name}:`}
        className="reaction-pill-custom-emoji"
      />
    )
  }
  return <span className="reaction-pill-emoji">{emoji}</span>
}

export function ReactionPills({
  reactions,
  onToggleReaction,
  onOpenPicker,
  canAddReaction = true,
}: ReactionPillsProps) {
  if (!reactions || reactions.length === 0) {
    return null
  }

  return (
    <div className="reaction-pills-row" role="group" aria-label="Reactions">
      {reactions.map((tally) => (
        <button
          key={tally.emoji}
          type="button"
          className={`reaction-pill ${tally.me ? 'reaction-pill-active' : ''}`}
          onClick={() => onToggleReaction(tally.emoji)}
          title={tally.me ? `Remove your ${tally.emoji} reaction` : `React with ${tally.emoji}`}
          aria-pressed={tally.me}
        >
          {renderEmojiDisplay(tally.emoji)}
          <span className="reaction-pill-count">{tally.count}</span>
        </button>
      ))}

      {canAddReaction && onOpenPicker && (
        <button
          type="button"
          className="reaction-pill reaction-pill-add"
          onClick={onOpenPicker}
          title="Add Reaction"
          aria-label="Add Reaction"
        >
          <SmilePlus size={16} />
        </button>
      )}
    </div>
  )
}
