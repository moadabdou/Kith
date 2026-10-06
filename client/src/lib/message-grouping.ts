import type { Message } from '../types'

export const MESSAGE_GROUPING_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

export interface GroupingOptions {
  isFirstUnread?: boolean
}

/**
 * Determines whether a message should be rendered as a consecutive message
 * grouped under the preceding message's header and avatar.
 */
export function shouldGroupConsecutiveMessage(
  prevMsg: Message | null | undefined,
  currentMsg: Message,
  options?: GroupingOptions
): boolean {
  if (!prevMsg) return false
  if (options?.isFirstUnread) return false
  if (currentMsg.pinned) return false
  // Replies always break grouping and show author header + avatar
  if (currentMsg.type === 19 || Boolean(currentMsg.reply_to)) return false

  const prevAuthorId = prevMsg.author?.id
  const currentAuthorId = currentMsg.author?.id
  if (!prevAuthorId || !currentAuthorId || prevAuthorId !== currentAuthorId) {
    return false
  }

  const prevTime = new Date(prevMsg.timestamp).getTime()
  const currentTime = new Date(currentMsg.timestamp).getTime()
  if (Number.isNaN(prevTime) || Number.isNaN(currentTime)) {
    return false
  }

  const diffMs = Math.abs(currentTime - prevTime)
  return diffMs < MESSAGE_GROUPING_WINDOW_MS
}

/**
 * Scans messages backwards to find the latest editable message sent by the user.
 * (Power-user ergonomics: Up arrow edit shortcut).
 */
export function findLastEditableMessage(
  messages: Message[],
  currentUserId: string | undefined,
  canEdit: (msg: Message) => boolean
): Message | null {
  if (!currentUserId || !messages || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.author?.id === currentUserId && canEdit(msg)) {
      return msg
    }
  }
  return null
}

