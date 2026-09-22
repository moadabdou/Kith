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

/** Simulcast layer pill derived from received frame height bands. */
export type VideoLayer = 'f' | 'h' | 'q' | null

export function layerForHeight(height: number | null | undefined): VideoLayer {
  if (height == null || !Number.isFinite(height) || height <= 0) return null
  if (height >= 540) return 'f'
  if (height >= 270) return 'h'
  return 'q'
}

export interface VideoQuality {
  /** Compact badge text, e.g. "720p", "360p", "No video". */
  label: string
  /** Simulcast layer pill, null when unknown (e.g. audio-only). */
  layer: VideoLayer
  /** Full detail for tooltips, e.g. "720p • 30fps". Null parts omitted. */
  detail: string | null
}

function contentHintDetail(track: MediaStreamTrack | null | undefined): boolean {
  return (
    (track as (MediaStreamTrack & { contentHint?: string }) | null | undefined)?.contentHint ===
    'detail'
  )
}

/**
 * Quality label for any video content (cam or screen, local or remote).
 * Resolution-first: height from track settings; layer pill from height
 * bands; fps/detail appended when provided (from getStats polling).
 */
export function getVideoQualityLabel(
  stream: MediaStream | null | undefined,
  kind: SpotlightKind,
  fps?: number | null,
): VideoQuality {
  const track = stream?.getVideoTracks?.()[0] ?? null
  const height = track?.getSettings?.()?.height ?? null
  const detailSuffix = contentHintDetail(track) ? 'Detail' : null
  if (height == null || !Number.isFinite(height) || height <= 0) {
    return { label: kind === 'screen' ? (detailSuffix ?? 'Live') : 'Live', layer: null, detail: null }
  }
  const rounded = Math.round(height)
  const parts = [`${rounded}p`]
  if (fps != null && Number.isFinite(fps) && fps > 0) parts.push(`${Math.round(fps)}fps`)
  if (detailSuffix) parts.push(detailSuffix)
  const detail = parts.length > 1 ? parts.join(' • ') : null
  return { label: `${rounded}p`, layer: layerForHeight(rounded), detail }
}

/**
 * Shared track-liveness gate for grid tiles and spotlight.
 * A track is live when it hasn't ended and isn't disabled. `muted` is
 * deliberately NOT consulted: remote receiver tracks signal mute around
 * transient RTP gaps (stalls, keyframe waits) while frames still render or
 * resume momentarily — treating mute as dead is what latched spotlight
 * into a false "Stream ended".
 */
export function isTrackLive(track: MediaStreamTrack | null | undefined): boolean {
  if (!track) return false
  return track.readyState === 'live' && track.enabled !== false
}

/** Convenience: liveness of the first video track of a stream (or null stream). */
export function isStreamLive(stream: MediaStream | null | undefined): boolean {
  if (!stream) return false
  const tracks = stream.getVideoTracks?.() ?? []
  return tracks.length > 0 && isTrackLive(tracks[0])
}

/**
 * True only for the benign play() AbortError browsers raise when srcObject
 * is reassigned while a previous play() is in flight. Those must be
 * swallowed (a newer attach owns playback now) — everything else (notably
 * NotAllowedError) is a real autoplay block needing user gesture.
 */
export function isBenignPlayAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { name?: string }).name === 'AbortError' &&
    /interrupted by a new load request/i.test((err as { message?: string }).message ?? '')
  )
}
