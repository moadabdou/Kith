import type { ReactionTally } from '../types'

/**
 * Pure reducer function to apply a reaction add event (either optimistic or via gateway).
 */
export function applyReactionAdd(
  currentReactions: ReactionTally[] | undefined,
  emoji: string,
  isMe: boolean
): ReactionTally[] {
  const reactions = currentReactions ? [...currentReactions] : []
  const index = reactions.findIndex((r) => r.emoji === emoji)

  if (index >= 0) {
    const existing = reactions[index]
    // If the event is for current user and user is ALREADY recorded as having reacted,
    // do not double-increment count (idempotent for optimistic + gateway sync).
    if (isMe && existing.me) {
      return reactions
    }
    reactions[index] = {
      ...existing,
      count: existing.count + 1,
      me: existing.me || isMe,
    }
    return reactions
  }

  reactions.push({
    emoji,
    count: 1,
    me: isMe,
  })
  return reactions
}

/**
 * Pure reducer function to apply a reaction remove event (either optimistic or via gateway).
 */
export function applyReactionRemove(
  currentReactions: ReactionTally[] | undefined,
  emoji: string,
  isMe: boolean
): ReactionTally[] {
  if (!currentReactions || currentReactions.length === 0) return []

  const index = currentReactions.findIndex((r) => r.emoji === emoji)
  if (index === -1) return currentReactions

  const existing = currentReactions[index]
  // If the event is for current user and user is ALREADY not reacting,
  // do not double-decrement count.
  if (isMe && !existing.me) {
    return currentReactions
  }

  const newCount = existing.count - 1

  if (newCount <= 0) {
    return currentReactions.filter((_, i) => i !== index)
  }

  const updated = [...currentReactions]
  updated[index] = {
    ...existing,
    count: newCount,
    me: isMe ? false : existing.me,
  }
  return updated
}

/**
 * Optimistically toggles a reaction for the current user.
 * Returns the new reactions list and whether the user previously had reacted (wasMe).
 */
export function toggleReactionOptimistic(
  currentReactions: ReactionTally[] | undefined,
  emoji: string
): { nextReactions: ReactionTally[]; wasMe: boolean } {
  const reactions = currentReactions || []
  const existing = reactions.find((r) => r.emoji === emoji)
  const wasMe = existing ? existing.me : false

  if (wasMe) {
    return {
      nextReactions: applyReactionRemove(reactions, emoji, true),
      wasMe: true,
    }
  }

  return {
    nextReactions: applyReactionAdd(reactions, emoji, true),
    wasMe: false,
  }
}
