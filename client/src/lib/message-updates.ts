import type { Message } from '../types'

export type MessageUpdatePayload = Partial<Message> & { id: string; channel_id: string }

/**
 * Merges a MESSAGE_UPDATE payload into cached history. Handles both shapes:
 * - full-message updates (edits: content / edited_timestamp present) replace
 *   those fields;
 * - slim worker hints ({id, channel_id} only) leave the cached message
 *   untouched so the caller can reconcile attachments via REST.
 * Unknown ids are ignored (message not in the current window).
 */
export function applyMessageUpdate(prev: Message[], payload: MessageUpdatePayload): Message[] {
  let changed = false
  const next = prev.map((m) => {
    if (m.id !== payload.id) return m
    let merged = m
    if (typeof payload.content === 'string' && payload.content !== m.content) {
      merged = { ...merged, content: payload.content }
      changed = true
    }
    if (
      payload.edited_timestamp !== undefined &&
      payload.edited_timestamp !== m.edited_timestamp
    ) {
      merged = { ...merged, edited_timestamp: payload.edited_timestamp }
      changed = true
    }
    if (payload.attachments && payload.attachments.length > 0) {
      merged = { ...merged, attachments: payload.attachments }
      changed = true
    }
    return merged
  })
  return changed ? next : prev
}
