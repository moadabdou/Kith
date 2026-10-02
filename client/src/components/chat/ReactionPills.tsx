import { SmilePlus } from 'lucide-react'
import type { ReactionTally } from '../../types'

export interface ReactionPillsProps {
  reactions: ReactionTally[]
  onToggleReaction: (emoji: string) => void
  onOpenPicker?: (e: React.MouseEvent) => void
  canAddReaction?: boolean
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
          <span className="reaction-pill-emoji">{tally.emoji}</span>
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
          <SmilePlus size={14} />
        </button>
      )}
    </div>
  )
}
