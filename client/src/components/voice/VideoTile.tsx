import { useEffect, useRef, useState } from 'react'
import { Headphones, Maximize2, MicOff, Monitor } from 'lucide-react'
import { isBenignPlayAbort, isTrackLive } from '../../lib/spotlight'

export interface VideoTileProps {
  userId: string
  displayName: string
  isSelf: boolean
  stream: MediaStream | null
  speaking: boolean
  selfMute?: boolean
  selfDeaf?: boolean
  /** True when this user currently shares their screen (badge only). */
  isSharingScreen?: boolean
  /** True when `stream` is screen content: disables the self-mirror. */
  isScreenContent?: boolean
  /** Explicit manual spotlight entry. Rendered only when provided. */
  onSpotlight?: () => void
  /** Compact quality badge, e.g. "720p". Layer pill + detail in tooltip. */
  qualityLabel?: string | null
  qualityLayer?: 'f' | 'h' | 'q' | null
  qualityDetail?: string | null
}

export function VideoTile({
  userId,
  displayName,
  isSelf,
  stream,
  speaking,
  selfMute,
  selfDeaf,
  isSharingScreen,
  isScreenContent,
  onSpotlight,
  qualityLabel,
  qualityLayer,
  qualityDetail,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [hasVideoTrack, setHasVideoTrack] = useState(false)

  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return

    if (stream && stream.getVideoTracks().length > 0) {
      // Same-stream re-render (parent churn, same MediaStream identity):
      // never reassign — the reassignment itself aborts in-flight play().
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream
      }
      setHasVideoTrack(true)
      const playPromise = videoEl.play()
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (isBenignPlayAbort(err)) return
          console.warn('[VideoTile] Autoplay failed:', err)
        })
      }

      const track = stream.getVideoTracks()[0]
      const checkTrack = () => {
        setHasVideoTrack(isTrackLive(track))
      }

      checkTrack()
      track.addEventListener('ended', checkTrack)
      track.addEventListener('mute', checkTrack)
      track.addEventListener('unmute', checkTrack)

      return () => {
        track.removeEventListener('ended', checkTrack)
        track.removeEventListener('mute', checkTrack)
        track.removeEventListener('unmute', checkTrack)
        // Only detach when the stream actually changed or went away;
        // clearing on every same-stream re-run aborts playback for nothing.
        if (videoEl.srcObject !== stream) {
          videoEl.srcObject = null
        }
      }
    } else {
      videoEl.srcObject = null
      setHasVideoTrack(false)
    }
  }, [stream])

  const initials = displayName.substring(0, 2).toUpperCase()

  return (
    <div
      className={`video-tile ${speaking ? 'speaking' : ''}`}
      data-user-id={userId}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted // Always mute video tile preview; remote voice audio is handled independently by SfuClient audio elements
        className={`video-tile-video ${isSelf && !isScreenContent ? 'video-tile-mirror' : ''} ${hasVideoTrack ? 'active' : 'hidden'}`}
      />

      {!hasVideoTrack && (
        <div className="video-tile-fallback">
          <div className={`voice-participant-avatar ${speaking ? 'speaking' : ''}`}>
            {initials}
          </div>
        </div>
      )}

      <div className="video-tile-overlay">
        <div className="video-tile-name" title={displayName}>
          <span>{displayName}</span>
          {isSelf && <span className="video-tile-self-tag">(You)</span>}
        </div>

        <div className="video-tile-badges">
          {qualityLabel && (
            <span
              className="voice-badge quality"
              title={qualityDetail ?? qualityLabel}
            >
              {qualityLayer && <span className="voice-badge-layer">{qualityLayer}</span>}
              {qualityLabel}
            </span>
          )}
          {isSharingScreen && (
            <span className="voice-badge sharing" title="Sharing screen">
              <Monitor size={14} />
            </span>
          )}
          {selfDeaf && (
            <span className="voice-badge deafened" title="Deafened">
              <Headphones size={14} />
            </span>
          )}
          {selfMute && (
            <span className="voice-badge muted" title="Muted">
              <MicOff size={14} />
            </span>
          )}
          {onSpotlight && (
            <button
              type="button"
              className="voice-badge spotlight-btn"
              title="Spotlight"
              onClick={(e) => {
                e.stopPropagation()
                onSpotlight()
              }}
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
