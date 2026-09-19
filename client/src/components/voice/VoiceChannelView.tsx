import { useEffect, useState } from 'react'
import {
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Users,
  Volume2,
} from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useVoice } from '../../context/useVoice'
import type { Channel, Guild, Member } from '../../types'

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
  } = useVoice()

  const [members, setMembers] = useState<Map<string, Member>>(new Map())

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
          <div className="voice-stage-grid">
            {channelMembers.map((vs) => {
              const isSelf = user?.id === vs.user_id
              const member = members.get(vs.user_id)
              const displayName = isSelf
                ? member?.nick || user?.username || 'You'
                : member?.nick || member?.user?.username || `User #${vs.user_id.slice(-4)}`
              const initials = displayName.substring(0, 2).toUpperCase()
              const speaking = speakingUsers.has(vs.user_id)

              return (
                <div
                  key={vs.user_id}
                  className={`voice-participant-card ${speaking ? 'speaking' : ''}`}
                >
                  <div className="voice-participant-avatar-container">
                    <div
                      className={`voice-participant-avatar ${speaking ? 'speaking' : ''}`}
                    >
                      {initials}
                    </div>
                  </div>

                  <div className="voice-participant-footer">
                    <span className="voice-participant-name" title={displayName}>
                      {displayName}
                    </span>

                    <div className="voice-participant-badges">
                      {vs.self_deaf && (
                        <span className="voice-badge deafened" title="Deafened">
                          <Headphones size={15} />
                        </span>
                      )}
                      {vs.self_mute && (
                        <span className="voice-badge muted" title="Muted">
                          <MicOff size={15} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
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
