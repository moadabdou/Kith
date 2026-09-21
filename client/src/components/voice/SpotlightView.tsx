import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Maximize2, Minimize2, Monitor, StopCircle, Video } from 'lucide-react'
import { VideoTile, type VideoTileProps } from './VideoTile'
import type { SpotlightKind } from '../../lib/spotlight'

export interface SpotlightTarget {
  userId: string
  displayName: string
  isSelf: boolean
  stream: MediaStream | null
  kind: SpotlightKind
}

export interface SpotlightViewProps {
  spotlight: SpotlightTarget
  participants: VideoTileProps[]
  onBackToGrid: () => void
  onStopScreenShare?: () => void
}

function getQualityLabel(stream: MediaStream | null, kind: SpotlightKind): string {
  if (kind !== 'screen') return 'Live'
  const track = stream?.getVideoTracks()[0]
  const settings = track?.getSettings?.()
  const height = settings?.height
  const hint =
    (track as MediaStreamTrack & { contentHint?: string } | undefined)?.contentHint === 'detail'
      ? 'Detail'
      : null
  if (height && height >= 720) return `${Math.round(height)}p${hint ? ` • ${hint}` : ''}`
  if (height) return `${Math.round(height)}p${hint ? ` • ${hint}` : ''}`
  return hint ?? 'Live'
}

// Manual spotlight view. Entered ONLY via explicit user action (tile button
// or sharing banner) — never automatically on share start, for either the
// sharer or viewers. Reuses the presentation-mode CSS classes.
export function SpotlightView({
  spotlight,
  participants,
  onBackToGrid,
  onStopScreenShare,
}: SpotlightViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [qualityLabel, setQualityLabel] = useState(() => getQualityLabel(spotlight.stream, spotlight.kind))
  // Liveness of the spotlighted track. A removed-but-not-ended downlink goes
  // mute (transceiver inactive) without firing ended — without this the
  // spotlight renders a frozen/black frame as if the stream were live.
  const [hasLiveTrack, setHasLiveTrack] = useState(!!spotlight.stream)

  // Refresh the quality badge as encoder resolution adapts mid-share.
  useEffect(() => {
    setQualityLabel(getQualityLabel(spotlight.stream, spotlight.kind))
    setHasLiveTrack(!!spotlight.stream)
    if (!spotlight.stream) return
    const id = setInterval(() => {
      setQualityLabel(getQualityLabel(spotlight.stream, spotlight.kind))
    }, 2000)
    return () => clearInterval(id)
  }, [spotlight.stream, spotlight.kind])

  // Never render the spotlighted user as a filmstrip tile.
  const filmstripParticipants = participants.filter((p) => p.userId !== spotlight.userId)

  // Attach spotlight stream to video element
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl || !spotlight.stream) return

    videoEl.srcObject = spotlight.stream
    videoEl.play().catch((err) => {
      console.warn('[SpotlightView] Autoplay error:', err)
    })

    // Mirror VideoTile liveness: ended/mute → fallback, unmute → resume.
    const track = spotlight.stream.getVideoTracks()[0]
    if (!track) {
      setHasLiveTrack(false)
      return
    }
    const checkTrack = () => {
      setHasLiveTrack(track.readyState === 'live' && track.enabled && !track.muted)
    }

    checkTrack()
    track.addEventListener('ended', checkTrack)
    track.addEventListener('mute', checkTrack)
    track.addEventListener('unmute', checkTrack)

    return () => {
      track.removeEventListener('ended', checkTrack)
      track.removeEventListener('mute', checkTrack)
      track.removeEventListener('unmute', checkTrack)
      videoEl.srcObject = null
    }
  }, [spotlight.stream])

  // Track browser native fullscreen state changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  const toggleFullscreen = async () => {
    if (!containerRef.current) return
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('[SpotlightView] Fullscreen toggle error:', err)
    }
  }

  const isScreen = spotlight.kind === 'screen'
  const title = isScreen
    ? spotlight.isSelf
      ? 'You are sharing your screen'
      : `${spotlight.displayName}'s Screen`
    : spotlight.isSelf
      ? 'Your camera'
      : `${spotlight.displayName}'s Camera`

  return (
    <div className="screenshare-presentation-mode" ref={containerRef}>
      {/* Primary Spotlight View */}
      <div className="screenshare-spotlight">
        {spotlight.stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="screenshare-video-element"
            style={hasLiveTrack ? undefined : { display: 'none' }}
          />
        ) : null}

        {!hasLiveTrack && (
          <div className="screenshare-ended-fallback">
            <div className="voice-participant-avatar">
              {spotlight.displayName.substring(0, 2).toUpperCase()}
            </div>
            <span className="screenshare-ended-text">
              {spotlight.stream ? 'Stream ended' : 'No video'}
            </span>
          </div>
        )}

        {/* Top Floating Spotlight Controls & Info Overlay */}
        <div className="screenshare-top-overlay">
          <div className="screenshare-presenter-badge">
            {isScreen ? (
              <Monitor size={16} className="screenshare-badge-icon" />
            ) : (
              <Video size={16} className="screenshare-badge-icon" />
            )}
            <span className="screenshare-presenter-name">{title}</span>
            <span className="screenshare-quality-tag">{qualityLabel}</span>
          </div>

          <div className="screenshare-actions-group">
            <button
              type="button"
              className="screenshare-fullscreen-btn"
              onClick={onBackToGrid}
              title="Back to grid"
            >
              <ArrowLeft size={18} />
            </button>

            {spotlight.isSelf && isScreen && onStopScreenShare && (
              <button
                type="button"
                className="screenshare-stop-btn"
                onClick={onStopScreenShare}
                title="Stop Sharing Screen"
              >
                <StopCircle size={16} />
                <span>Stop Sharing</span>
              </button>
            )}

            <button
              type="button"
              className="screenshare-fullscreen-btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* Participant Thumbnail Filmstrip */}
      <div className="screenshare-filmstrip-wrapper">
        <div className="screenshare-filmstrip">
          {filmstripParticipants.map((p) => (
            <div key={p.userId} className="screenshare-filmstrip-item">
              <VideoTile {...p} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
