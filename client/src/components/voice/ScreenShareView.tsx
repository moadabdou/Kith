import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Monitor, StopCircle } from 'lucide-react'
import { VideoTile, type VideoTileProps } from './VideoTile'

export interface ScreenSharePresenter {
  userId: string
  displayName: string
  isSelf: boolean
  stream: MediaStream
}

export interface ScreenShareViewProps {
  presenter: ScreenSharePresenter
  participants: VideoTileProps[]
  onStopScreenShare?: () => void
}

export function ScreenShareView({
  presenter,
  participants,
  onStopScreenShare,
}: ScreenShareViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Attach presenter screenshare stream to video element
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl || !presenter.stream) return

    videoEl.srcObject = presenter.stream
    videoEl.play().catch((err) => {
      console.warn('[ScreenShareView] Autoplay error for screenshare:', err)
    })

    return () => {
      videoEl.srcObject = null
    }
  }, [presenter.stream])

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
      console.error('[ScreenShareView] Fullscreen toggle error:', err)
    }
  }

  return (
    <div className="screenshare-presentation-mode" ref={containerRef}>
      {/* Primary Spotlight View */}
      <div className="screenshare-spotlight">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="screenshare-video-element"
        />

        {/* Top Floating Spotlight Controls & Info Overlay */}
        <div className="screenshare-top-overlay">
          <div className="screenshare-presenter-badge">
            <Monitor size={16} className="screenshare-badge-icon" />
            <span className="screenshare-presenter-name">
              {presenter.isSelf ? 'You are sharing your screen' : `${presenter.displayName}'s Screen`}
            </span>
            <span className="screenshare-quality-tag">1080p • Detail</span>
          </div>

          <div className="screenshare-actions-group">
            {presenter.isSelf && onStopScreenShare && (
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
          {participants.map((p) => (
            <div key={p.userId} className="screenshare-filmstrip-item">
              <VideoTile {...p} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
