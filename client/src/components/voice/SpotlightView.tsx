import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Maximize2, Minimize2, Monitor, StopCircle, Video } from 'lucide-react'
import { VideoTile, type VideoTileProps } from './VideoTile'
import {
  getVideoQualityLabel,
  isBenignPlayAbort,
  isTrackLive,
  type SpotlightKind,
} from '../../lib/spotlight'

export interface SpotlightTarget {
  userId: string
  displayName: string
  isSelf: boolean
  stream: MediaStream | null
  kind: SpotlightKind
  qualityLabel?: string | null
  qualityLayer?: 'f' | 'h' | 'q' | null
  qualityDetail?: string | null
}

export interface SpotlightViewProps {
  spotlight: SpotlightTarget
  participants: VideoTileProps[]
  onBackToGrid: () => void
  onStopScreenShare?: () => void
}

function getQualityLabel(
  stream: MediaStream | null,
  kind: SpotlightKind,
  fps?: number | null,
  override?: Pick<SpotlightTarget, 'qualityLabel' | 'qualityDetail'>,
): string {
  // Resolved upstream (per-participant, stats-enriched) wins; fall back to
  // a local computation so the badge never goes blank.
  if (override?.qualityLabel) return override.qualityDetail ?? override.qualityLabel
  const q = getVideoQualityLabel(stream, kind, fps)
  return q.detail ?? q.label
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
  const qualityFps = useRef<number | null>(null)
  const [qualityLabel, setQualityLabel] = useState(() =>
    getQualityLabel(spotlight.stream, spotlight.kind, null, spotlight),
  )
  // Liveness of the spotlighted track. A removed-but-not-ended downlink goes
  // mute (transceiver inactive) without firing ended — without this the
  // spotlight renders a frozen/black frame as if the stream were live.
  const [hasLiveTrack, setHasLiveTrack] = useState(!!spotlight.stream)

  // Refresh the quality badge as encoder resolution adapts mid-share.
  // Prefer the upstream-resolved label (stats-enriched, per-participant);
  // the local computation is the fallback. Fps comes from the same stats
  // via the resolved label — refresh when the resolved values change.
  useEffect(() => {
    setQualityLabel(getQualityLabel(spotlight.stream, spotlight.kind, qualityFps.current, spotlight))
    setHasLiveTrack(!!spotlight.stream)
    if (!spotlight.stream) return
    const id = setInterval(() => {
      setQualityLabel(getQualityLabel(spotlight.stream, spotlight.kind, qualityFps.current, spotlight))
    }, 2000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlight.stream, spotlight.kind, spotlight.qualityLabel, spotlight.qualityDetail])

  // Never render the spotlighted user as a filmstrip tile.
  const filmstripParticipants = participants.filter((p) => p.userId !== spotlight.userId)

  // Attach spotlight stream to video element. Same-stream re-renders must
  // not reassign srcObject (the reassignment aborts in-flight play()); the
  // shared liveness gate matches VideoTile so the two can't disagree.
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl || !spotlight.stream) return

    if (videoEl.srcObject !== spotlight.stream) {
      videoEl.srcObject = spotlight.stream
    }
    const playPromise = videoEl.play()
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        if (isBenignPlayAbort(err)) return
        console.warn('[SpotlightView] Autoplay error:', err)
      })
    }

    const track = spotlight.stream.getVideoTracks()[0]
    if (!track) {
      setHasLiveTrack(false)
      return
    }
    const checkTrack = () => {
      setHasLiveTrack(isTrackLive(track))
    }
    // Element-driven recovery: a muted-but-rendering track must never hide.
    const onPlaying = () => {
      setHasLiveTrack(true)
    }
    videoEl.addEventListener('playing', onPlaying)

    checkTrack()
    track.addEventListener('ended', checkTrack)
    track.addEventListener('mute', checkTrack)
    track.addEventListener('unmute', checkTrack)

    return () => {
      track.removeEventListener('ended', checkTrack)
      track.removeEventListener('mute', checkTrack)
      track.removeEventListener('unmute', checkTrack)
      videoEl.removeEventListener('playing', onPlaying)
      if (videoEl.srcObject !== spotlight.stream) {
        videoEl.srcObject = null
      }
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
            key={spotlight.stream.id}
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
            <span className="screenshare-quality-tag" title={spotlight.qualityDetail ?? qualityLabel}>
              {spotlight.qualityLayer && (
                <span className="screenshare-layer-pill">{spotlight.qualityLayer}</span>
              )}
              {qualityLabel}
            </span>
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
