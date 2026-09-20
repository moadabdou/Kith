import { useEffect, useRef, useState } from 'react'
import {
  ChevronUp,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Users,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useVoice } from '../../context/useVoice'
import type { Channel, Guild, Member } from '../../types'
import { VideoGrid } from './VideoGrid'

interface VoiceChannelViewProps {
  currentGuild: Guild | null
  channel: Channel
}

export function VoiceChannelView({ currentGuild, channel }: VoiceChannelViewProps) {
  const { user } = useAuth()
  const {
    activeVoice,
    connectionStatus,
    selfMute,
    selfDeaf,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeaf,
    getChannelVoiceStates,
    speakingUsers,
    isCameraOn,
    selectedCameraId,
    videoDevices,
    localVideoStream,
    remoteVideoStreams,
    toggleCamera,
    setSelectedCameraId,
  } = useVoice()

  const [members, setMembers] = useState<Map<string, Member>>(new Map())
  const [showDeviceMenu, setShowDeviceMenu] = useState(false)
  const deviceMenuRef = useRef<HTMLDivElement | null>(null)

  // Load members for avatar and name resolution
  useEffect(() => {
    if (!currentGuild) return
    let active = true

    api
      .getMembers(currentGuild.id)
      .then((list) => {
        if (!active) return
        const map = new Map<string, Member>()
        for (const m of list) {
          if (m?.user?.id) map.set(m.user.id, m)
        }
        setMembers(map)
      })
      .catch((err) => console.error('Failed to load members for voice stage:', err))

    return () => {
      active = false
    }
  }, [currentGuild])

  // Close device menu when clicking outside
  useEffect(() => {
    if (!showDeviceMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(e.target as Node)) {
        setShowDeviceMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDeviceMenu])

  const channelMembers = currentGuild
    ? getChannelVoiceStates(currentGuild.id, channel.id)
    : []

  const isConnectedToThisChannel =
    Boolean(currentGuild) &&
    activeVoice?.guildId === currentGuild?.id &&
    activeVoice?.channelId === channel.id

  const handleJoin = () => {
    if (currentGuild) {
      joinVoice(currentGuild.id, channel.id)
    }
  }

  const participants = channelMembers.map((vs) => {
    const isSelf = user?.id === vs.user_id
    const member = members.get(vs.user_id)
    const displayName = isSelf
      ? member?.nick || user?.username || 'You'
      : member?.nick || member?.user?.username || `User #${vs.user_id.slice(-4)}`
    const speaking = speakingUsers.has(vs.user_id)
    const stream = isSelf ? localVideoStream : (remoteVideoStreams.get(vs.user_id) || null)

    return {
      userId: vs.user_id,
      displayName,
      isSelf,
      stream,
      speaking,
      selfMute: vs.self_mute,
      selfDeaf: vs.self_deaf,
    }
  })

  return (
    <div className="voice-channel-view">
      {/* Top Header */}
      <div className="voice-stage-header">
        <div className="voice-stage-title-area">
          <Volume2
            size={24}
            className={isConnectedToThisChannel ? 'voice-header-icon connected' : 'voice-header-icon'}
          />
          <span className="voice-stage-title">{channel.name}</span>
          {currentGuild && (
            <span className="voice-stage-guild-badge">{currentGuild.name}</span>
          )}
        </div>

        <div className="voice-stage-meta">
          {isConnectedToThisChannel && (
            <div className="voice-stage-status-badge">
              <Radio size={14} className="voice-stage-live-icon" />
              <span>
                {connectionStatus === 'connected' ? 'Connected' : 'Connecting…'}
              </span>
            </div>
          )}

          <div className="voice-stage-count-badge">
            <Users size={14} />
            <span>
              {channelMembers.length} {channelMembers.length === 1 ? 'Member' : 'Members'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Stage Grid or Empty Stage */}
      <div className="voice-stage-body">
        {channelMembers.length === 0 ? (
          <div className="voice-empty-stage">
            <div className="voice-empty-icon-circle">
              <Volume2 size={48} />
            </div>
            <h3 className="voice-empty-title">This Voice Channel is Empty</h3>
            <p className="voice-empty-desc">
              Nobody is hanging out in #{channel.name} right now.
            </p>
            {!isConnectedToThisChannel && (
              <button
                type="button"
                className="btn-primary voice-stage-join-btn"
                onClick={handleJoin}
              >
                <Volume2 size={18} />
                <span>Join Voice Channel</span>
              </button>
            )}
          </div>
        ) : (
          <VideoGrid participants={participants} />
        )}
      </div>

      {/* Floating Bottom Control Dock */}
      <div className="voice-stage-controls-bar">
        {isConnectedToThisChannel ? (
          <div className="voice-stage-dock">
            <button
              type="button"
              onClick={toggleMute}
              className={`voice-dock-btn ${selfMute ? 'active-danger' : ''}`}
              title={selfMute ? 'Unmute Microphone' : 'Mute Microphone'}
            >
              {selfMute ? <MicOff size={20} /> : <Mic size={20} />}
            </button>

            <button
              type="button"
              onClick={toggleDeaf}
              className={`voice-dock-btn ${selfDeaf ? 'active-danger' : ''}`}
              title={selfDeaf ? 'Undeafen Audio' : 'Deafen Audio'}
            >
              <Headphones size={20} />
            </button>

            {/* Video Camera Toggle & Device Selector */}
            <div className="voice-dock-device-group" ref={deviceMenuRef}>
              <button
                type="button"
                onClick={toggleCamera}
                className={`voice-dock-btn ${isCameraOn ? 'active-camera' : ''}`}
                title={isCameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
              >
                {isCameraOn ? <Video size={20} /> : <VideoOff size={20} />}
              </button>

              {videoDevices.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowDeviceMenu((prev) => !prev)}
                  className={`voice-dock-chevron-btn ${showDeviceMenu ? 'active' : ''}`}
                  title="Select Camera Device"
                >
                  <ChevronUp size={14} />
                </button>
              )}

              {showDeviceMenu && videoDevices.length > 0 && (
                <div className="camera-device-menu">
                  <div className="camera-device-menu-header">Select Camera</div>
                  {videoDevices.map((device, index) => {
                    const isSelected = selectedCameraId
                      ? selectedCameraId === device.deviceId
                      : index === 0
                    return (
                      <button
                        key={device.deviceId || index}
                        type="button"
                        className={`camera-device-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedCameraId(device.deviceId)
                          setShowDeviceMenu(false)
                        }}
                      >
                        <span className="camera-device-name">
                          {device.label || `Camera ${index + 1}`}
                        </span>
                        {isSelected && (
                          <span className="camera-device-check">✓</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={leaveVoice}
              className="voice-dock-btn disconnect"
              title="Disconnect from Voice"
            >
              <PhoneOff size={20} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>Disconnect</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-primary voice-stage-join-btn"
            onClick={handleJoin}
          >
            <Volume2 size={18} />
            <span>Join Voice</span>
          </button>
        )}
      </div>
    </div>
  )
}
