import { useEffect, useRef, useState, useMemo } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Headphones,
  Maximize2,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Radio,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import { useVoice } from '../../context/useVoice'
import { useAuth } from '../../context/useAuth'
import type { Channel, Guild } from '../../types'
import { isBenignPlayAbort } from '../../lib/spotlight'

export interface VoicePipMiniPlayerProps {
  currentGuild: Guild | null
  channels: Channel[]
  onReturnToVoice: (guildId: string, channelId: string) => void
}

export function VoicePipMiniPlayer({
  currentGuild,
  channels,
  onReturnToVoice,
}: VoicePipMiniPlayerProps) {
  const { user } = useAuth()
  const {
    activeVoice,
    connectionStatus,
    selfMute,
    selfDeaf,
    toggleMute,
    toggleDeaf,
    isCameraOn,
    toggleCamera,
    isScreenSharing,
    toggleScreenShare,
    leaveVoice,
    localVideoStream,
    remoteVideoStreams,
    localScreenStream,
    remoteScreenStreams,
    speakingUsers,
    getChannelVoiceStates,
  } = useVoice()

  const [isMinimized, setIsMinimized] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Find active channel & guild details
  const activeChannel = useMemo(
    () => (activeVoice ? channels.find((c) => c.id === activeVoice.channelId) : null),
    [channels, activeVoice]
  )

  const activeGuildName = useMemo(() => {
    if (!activeVoice) return 'Server'
    if (currentGuild?.id === activeVoice.guildId) return currentGuild.name
    return 'Voice Server'
  }, [currentGuild, activeVoice])

  const channelMembers = useMemo(() => {
    if (!activeVoice) return []
    return getChannelVoiceStates(activeVoice.guildId, activeVoice.channelId)
  }, [activeVoice, getChannelVoiceStates])

  // Select stream to display: screenshare first, then camera, or null (audio fallback)
  const activeDisplay = useMemo(() => {
    // 1. Screenshare
    if (isScreenSharing && localScreenStream) {
      return {
        stream: localScreenStream,
        label: 'Your Screenshare',
        isSelf: true,
        isScreen: true,
      }
    }
    for (const [userId, stream] of remoteScreenStreams.entries()) {
      if (stream && stream.getVideoTracks().length > 0) {
        return {
          stream,
          label: 'Screenshare',
          userId,
          isSelf: false,
          isScreen: true,
        }
      }
    }

    // 2. Camera (prefer active speaker)
    for (const speakerId of speakingUsers) {
      const stream = remoteVideoStreams.get(speakerId)
      if (stream && stream.getVideoTracks().length > 0) {
        return {
          stream,
          label: 'Speaker Video',
          userId: speakerId,
          isSelf: false,
          isScreen: false,
        }
      }
    }

    for (const [userId, stream] of remoteVideoStreams.entries()) {
      if (stream && stream.getVideoTracks().length > 0) {
        return {
          stream,
          label: 'Video',
          userId,
          isSelf: false,
          isScreen: false,
        }
      }
    }

    if (isCameraOn && localVideoStream) {
      return {
        stream: localVideoStream,
        label: 'Your Camera',
        isSelf: true,
        isScreen: false,
      }
    }

    return null
  }, [
    isScreenSharing,
    localScreenStream,
    remoteScreenStreams,
    speakingUsers,
    remoteVideoStreams,
    isCameraOn,
    localVideoStream,
  ])

  // Attach active video stream to video element
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl) return

    const stream = activeDisplay?.stream
    if (stream && stream.getVideoTracks().length > 0) {
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream
      }
      const playPromise = videoEl.play()
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (isBenignPlayAbort(err)) return
          console.warn('[VoicePip] Playback interrupted:', err)
        })
      }
    } else {
      videoEl.srcObject = null
    }
  }, [activeDisplay?.stream])

  if (!activeVoice) return null

  const channelName = activeChannel?.name ?? 'Voice Channel'
  const isAnySpeaking = speakingUsers.size > 0 || (Boolean(user) && speakingUsers.has(user!.id))

  const handleReturn = () => {
    onReturnToVoice(activeVoice.guildId, activeVoice.channelId)
  }

  return (
    <aside
      className={`voice-pip-container ${isMinimized ? 'minimized' : ''}`}
      aria-label="Picture in picture voice call"
    >
      {/* PiP Header */}
      <div className="voice-pip-header">
        <div className="voice-pip-title-info" onClick={handleReturn} title="Click to return to call">
          <Radio
            size={14}
            className={`voice-pip-status-dot ${connectionStatus === 'connected' ? 'connected' : 'connecting'}`}
          />
          <div className="voice-pip-names">
            <span className="voice-pip-channel-name">{channelName}</span>
            <span className="voice-pip-guild-name">/ {activeGuildName}</span>
          </div>
        </div>

        <div className="voice-pip-header-actions">
          <button
            type="button"
            className="voice-pip-header-btn"
            onClick={() => setIsMinimized((prev) => !prev)}
            title={isMinimized ? 'Expand Mini-Player' : 'Minimize Mini-Player'}
          >
            {isMinimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button
            type="button"
            className="voice-pip-header-btn return-btn"
            onClick={handleReturn}
            title="Return to Voice Channel"
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </div>

      {/* PiP Video or Fallback Stage (hidden when minimized) */}
      {!isMinimized && (
        <div className="voice-pip-stage" onClick={handleReturn} title="Click to return to call">
          {activeDisplay ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`voice-pip-video ${activeDisplay.isSelf && !activeDisplay.isScreen ? 'mirrored' : ''}`}
              />
              <div className="voice-pip-stage-badge">
                {activeDisplay.isScreen && <Monitor size={12} />}
                <span>{activeDisplay.label}</span>
              </div>
            </>
          ) : (
            <div className="voice-pip-fallback-stage">
              <div className={`voice-pip-avatar-circle ${isAnySpeaking ? 'speaking' : ''}`}>
                {user?.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.username}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
                  />
                ) : (
                  <Users size={28} />
                )}
              </div>
              <span className="voice-pip-stage-subtext">
                {channelMembers.length} in voice • {isAnySpeaking ? 'Someone is speaking' : 'Connected'}
              </span>
            </div>
          )}

          <div className="voice-pip-hover-overlay">
            <Maximize2 size={24} />
            <span>Return to Call</span>
          </div>
        </div>
      )}

      {/* Floating Call Controls Dock */}
      <div className="voice-pip-controls">
        <button
          type="button"
          onClick={toggleMute}
          className={`voice-pip-btn ${selfMute ? 'active-danger' : ''}`}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff size={16} /> : <Mic size={16} />}
        </button>

        <button
          type="button"
          onClick={toggleDeaf}
          className={`voice-pip-btn ${selfDeaf ? 'active-danger' : ''}`}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          <Headphones size={16} />
        </button>

        <button
          type="button"
          onClick={toggleCamera}
          className={`voice-pip-btn ${isCameraOn ? 'active-accent' : ''}`}
          title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraOn ? <Video size={16} /> : <VideoOff size={16} />}
        </button>

        <button
          type="button"
          onClick={toggleScreenShare}
          className={`voice-pip-btn ${isScreenSharing ? 'active-accent' : ''}`}
          title={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
        >
          {isScreenSharing ? <MonitorOff size={16} /> : <Monitor size={16} />}
        </button>

        <button
          type="button"
          onClick={leaveVoice}
          className="voice-pip-btn disconnect"
          title="Disconnect from call"
        >
          <PhoneOff size={16} />
        </button>
      </div>
    </aside>
  )
}
