/**
 * Manual spotlight helpers (no automatic presentation anywhere).
 *
 * The spotlight is a per-channel, viewer-local choice persisted in
 * localStorage. This module holds the pure pieces so they are unit
 * testable without mounting providers.
 */

export type SpotlightKind = 'screen' | 'camera'

export function spotlightStorageKey(guildId: string, channelId: string): string {
  return `kith_spotlight:${guildId}:${channelId}`
}

export interface SpotlightStreams {
  isSelf: boolean
  userId: string
  localVideoStream: MediaStream | null
  localScreenStream: MediaStream | null
  remoteVideoStreams: Map<string, MediaStream>
  remoteScreenStreams: Map<string, MediaStream>
}

export interface ResolvedSpotlight {
  stream: MediaStream | null
  kind: SpotlightKind
}

/**
 * Resolve which stream (and kind) to show for a spotlighted user.
 * Screen wins over camera; null stream means avatar fallback.
 * Pure function of the current maps — call every render, never snapshot.
 */
export function resolveSpotlightStream(s: SpotlightStreams): ResolvedSpotlight {
  const screenStream = s.isSelf ? s.localScreenStream : s.remoteScreenStreams.get(s.userId) || null
  if (screenStream) {
    return { stream: screenStream, kind: 'screen' }
  }
  const camStream = s.isSelf ? s.localVideoStream : s.remoteVideoStreams.get(s.userId) || null
  return { stream: camStream, kind: 'camera' }
}

/** A persisted spotlight target is valid only while that user is in the channel. */
export function isSpotlightTargetValid(targetUserId: string | null, memberUserIds: Set<string>): boolean {
  if (!targetUserId) return false
  return memberUserIds.has(targetUserId)
}
