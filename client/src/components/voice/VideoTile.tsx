import { useEffect, useRef, useState } from 'react'
import { Headphones, Maximize2, MicOff, Monitor } from 'lucide-react'

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
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [hasVideoTrack, setHasVideoTrack] = useState(false)

  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return

    if (stream && stream.getVideoTracks().length > 0) {
      videoEl.srcObject = stream
      setHasVideoTrack(true)
      videoEl.play().catch((err) => console.warn('[VideoTile] Autoplay failed:', err))

      const track = stream.getVideoTracks()[0]
      const checkTrack = () => {
        setHasVideoTrack(track.readyState === 'live' && track.enabled)
      }

      checkTrack()
      track.addEventListener('ended', checkTrack)
      track.addEventListener('mute', checkTrack)
      track.addEventListener('unmute', checkTrack)

      return () => {
        track.removeEventListener('ended', checkTrack)
        track.removeEventListener('mute', checkTrack)
        track.removeEventListener('unmute', checkTrack)
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
