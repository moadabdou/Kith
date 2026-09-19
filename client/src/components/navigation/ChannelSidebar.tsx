import { useEffect, useState } from 'react'
import {
  Hash,
  Headphones,
  Lock,
  LogOut,
  Mic,
  MicOff,
  Plus,
  Settings,
  UserPlus,
  Volume2,
} from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useVoice } from '../../context/useVoice'
import { useGateway } from '../../gateway/useGateway'
import {
  ADMINISTRATOR,
  ALL_PERMISSIONS,
  hasPermission,
  MANAGE_CHANNELS,
  MANAGE_GUILD,
  MANAGE_ROLES,
  VIEW_CHANNEL,
} from '../../lib/permissions'
import type { Channel, Guild, Member } from '../../types'
import { VoiceStatusBar } from '../voice/VoiceStatusBar'

interface ChannelSidebarProps {
  currentGuild: Guild | null
  channels: Channel[]
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
  onOpenCreateChannelModal: (defaultType?: number) => void
  onOpenInviteModal: () => void
  onOpenServerSettingsModal?: () => void
  onOpenChannelSettingsModal?: (channel: Channel) => void
}

function isPrivateChannel(channel: Channel, guildId?: string): boolean {
  if (!channel.permission_overwrites || !guildId) return false
  const everyoneOw = channel.permission_overwrites.find(
    (ow) => Number(ow.type) === 0 && ow.target_id === guildId
  )
  if (!everyoneOw) return false
  return hasPermission(everyoneOw.deny, VIEW_CHANNEL)
}

export function ChannelSidebar({
  currentGuild,
  channels,
  selectedChannelId,
  onSelectChannel,
  onOpenCreateChannelModal,
  onOpenInviteModal,
  onOpenServerSettingsModal,
  onOpenChannelSettingsModal,
}: ChannelSidebarProps) {
  const { user, logout } = useAuth()
  const {
    subscribeToMemberUpdates,
    subscribeToRoleUpdates,
    subscribeToRoleDeletes,
  } = useGateway()
  const {
    activeVoice,
    selfMute,
    selfDeaf,
    toggleMute,
    toggleDeaf,
    joinVoice,
    getChannelVoiceStates,
    speakingUsers,
  } = useVoice()

  const [userPermissions, setUserPermissions] = useState<bigint | null>(null)
  const [guildMembers, setGuildMembers] = useState<Map<string, Member>>(new Map())

  // Load guild members for voice avatar/display name resolution
  useEffect(() => {
    if (!currentGuild) {
      setGuildMembers(new Map())
      return
    }

    let active = true
    api
      .getMembers(currentGuild.id)
      .then((list) => {
        if (!active) return
        const map = new Map<string, Member>()
        for (const m of list) {
          if (m?.user?.id) map.set(m.user.id, m)
        }
        setGuildMembers(map)
      })
      .catch((err) => console.error('Failed to load members for voice sidebar:', err))

    return () => {
      active = false
    }
  }, [currentGuild])

  useEffect(() => {
    if (!currentGuild || !user) {
      setUserPermissions(null)
      return
    }

    if (currentGuild.owner_id === user.id) {
      setUserPermissions(ALL_PERMISSIONS)
      return
    }

    let active = true
    const fetchPerms = () => {
      api
        .getMyPermissions(currentGuild.id)
        .then((res) => {
          if (active) {
            setUserPermissions(BigInt(res.permissions))
          }
        })
        .catch((err) => {
          console.error('Failed to load user permissions:', err)
        })
    }

    fetchPerms()

    const uMember = subscribeToMemberUpdates((p) => {
      if (p.guild_id === currentGuild.id && p.user?.id === user.id) {
        fetchPerms()
      }
    })
    const uRoleUpdate = subscribeToRoleUpdates((p) => {
      if (p.guild_id === currentGuild.id) {
        fetchPerms()
      }
    })
    const uRoleDelete = subscribeToRoleDeletes((p) => {
      if (p.guild_id === currentGuild.id) {
        fetchPerms()
      }
    })

    return () => {
      active = false
      uMember()
      uRoleUpdate()
      uRoleDelete()
    }
  }, [currentGuild, user, subscribeToMemberUpdates, subscribeToRoleUpdates, subscribeToRoleDeletes])

  const isOwner = currentGuild && user && currentGuild.owner_id === user.id
  const canManageChannels =
    Boolean(isOwner) ||
    (userPermissions != null &&
      (hasPermission(userPermissions, ADMINISTRATOR) ||
        hasPermission(userPermissions, MANAGE_CHANNELS) ||
        hasPermission(userPermissions, MANAGE_GUILD)))

  const canManageServer =
    Boolean(isOwner) ||
    (userPermissions != null &&
      (hasPermission(userPermissions, ADMINISTRATOR) ||
        hasPermission(userPermissions, MANAGE_GUILD) ||
        hasPermission(userPermissions, MANAGE_ROLES)))

  const textChannels = channels.filter((c) => !c.type || Number(c.type) === 0)
  const voiceChannels = channels.filter((c) => Number(c.type) === 2)

  return (
    <div className="channel-sidebar">
      {/* Guild Header */}
      <div className="guild-header">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentGuild?.name ?? 'Select a Server'}
        </span>
        {currentGuild && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {canManageServer && onOpenServerSettingsModal && (
              <button
                type="button"
                onClick={onOpenServerSettingsModal}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 4,
                  borderRadius: 4,
                }}
                title="Server Settings"
              >
                <Settings size={18} />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenInviteModal}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: 4,
                borderRadius: 4,
              }}
              title="Invite People"
            >
              <UserPlus size={18} />
            </button>
          </div>
        )}
      </div>

      {/* Channels List */}
      <div className="channels-scroll">
        {currentGuild && (
          <>
            {/* Text Channels Section */}
            <div className="channels-list-header">
              <span>Text Channels</span>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={() => onOpenCreateChannelModal(0)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                  }}
                  title="Create Text Channel"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>

            {textChannels.map((channel) => {
              const isActive = selectedChannelId === channel.id
              const isPrivate = isPrivateChannel(channel, currentGuild.id)
              return (
                <div
                  key={channel.id}
                  className={`channel-item ${isActive ? 'active' : ''}`}
                  onClick={() => onSelectChannel(channel.id)}
                  title={isPrivate ? `${channel.name} (Private Channel)` : channel.name}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                    {isPrivate ? <Lock size={18} /> : <Hash size={18} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {channel.name}
                    </span>
                  </div>
                  {canManageChannels && onOpenChannelSettingsModal && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenChannelSettingsModal(channel)
                      }}
                      className="channel-settings-btn"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: 2,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Edit Channel"
                    >
                      <Settings size={14} />
                    </button>
                  )}
                </div>
              )
            })}

            {/* Voice Channels Section */}
            <div className="channels-list-header" style={{ marginTop: 12 }}>
              <span>Voice Channels</span>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={() => onOpenCreateChannelModal(2)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                  }}
                  title="Create Voice Channel"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>

            {voiceChannels.map((channel) => {
              const isSelected = selectedChannelId === channel.id
              const isConnected =
                activeVoice?.guildId === currentGuild.id && activeVoice?.channelId === channel.id
              const isPrivate = isPrivateChannel(channel, currentGuild.id)
              const channelMembers = getChannelVoiceStates(currentGuild.id, channel.id)

              return (
                <div key={channel.id} className="voice-channel-group">
                  <div
                    className={`channel-item voice ${isSelected ? 'active' : ''} ${
                      isConnected ? 'connected' : ''
                    }`}
                    onClick={() => {
                      onSelectChannel(channel.id)
                      joinVoice(currentGuild.id, channel.id)
                    }}
                    title={isPrivate ? `${channel.name} (Private Voice Channel)` : channel.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                      {isPrivate ? (
                        <Lock size={18} />
                      ) : (
                        <Volume2
                          size={18}
                          className={isConnected ? 'voice-icon-connected' : ''}
                          style={isConnected ? { color: 'var(--voice-connected, #23a55a)' } : undefined}
                        />
                      )}
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: isConnected ? 'var(--text-header)' : undefined,
                          fontWeight: isConnected ? 600 : undefined,
                        }}
                      >
                        {channel.name}
                      </span>
                    </div>

                    {canManageChannels && onOpenChannelSettingsModal && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenChannelSettingsModal(channel)
                        }}
                        className="channel-settings-btn"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                          padding: 2,
                          display: 'flex',
                          alignItems: 'center',
                        }}
                        title="Edit Voice Channel"
                      >
                        <Settings size={14} />
                      </button>
                    )}
                  </div>

                  {/* Nested Voice Members Tree */}
                  {channelMembers.length > 0 && (
                    <div className="voice-member-tree">
                      {channelMembers.map((vs) => {
                        const isSelf = user?.id === vs.user_id
                        const member = guildMembers.get(vs.user_id)
                        const displayName = isSelf
                          ? member?.nick || user?.username || 'You'
                          : member?.nick || member?.user?.username || `User #${vs.user_id.slice(-4)}`
                        const initials = displayName.substring(0, 2).toUpperCase()
                        const speaking = speakingUsers.has(vs.user_id)

                        return (
                          <div
                            key={vs.user_id}
                            className={`voice-member-row ${speaking ? 'speaking' : ''}`}
                          >
                            <div className="voice-member-left">
                              <div
                                className={`voice-member-avatar ${speaking ? 'speaking' : ''}`}
                                title={speaking ? `${displayName} is speaking` : displayName}
                              >
                                {initials}
                              </div>
                              <span
                                className="voice-member-name"
                                style={{
                                  color: speaking
                                    ? 'var(--text-header)'
                                    : isSelf
                                    ? 'var(--text-normal)'
                                    : 'var(--text-muted)',
                                }}
                              >
                                {displayName}
                              </span>
                            </div>

                            <div className="voice-member-badges">
                              {vs.self_deaf && (
                                <span className="voice-badge deafened" title="Deafened" style={{ display: 'inline-flex' }}>
                                  <Headphones size={13} />
                                </span>
                              )}
                              {vs.self_mute && (
                                <span className="voice-badge muted" title="Muted" style={{ display: 'inline-flex' }}>
                                  <MicOff size={13} />
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Voice Connection Status Bar (directly above profile bar) */}
      <VoiceStatusBar currentGuild={currentGuild} channels={channels} />

      {/* User profile bar at bottom */}
      <div className="user-profile-bar">
        <div className="user-info-area" title={`User ID: ${user?.id}`}>
          <div className="user-avatar">
            {user?.username?.substring(0, 2).toUpperCase() ?? 'U'}
          </div>
          <div className="user-text">
            <span className="user-username">{user?.username}</span>
            <span className="user-discriminator">#{user?.discriminator}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* Quick Voice Controls: Mute & Deafen */}
          <button
            type="button"
            onClick={toggleMute}
            style={{
              background: 'none',
              border: 'none',
              color: selfMute ? '#da373c' : 'var(--text-muted)',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
            }}
            title={selfMute ? 'Unmute' : 'Mute'}
          >
            {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
          </button>

          <button
            type="button"
            onClick={toggleDeaf}
            style={{
              background: 'none',
              border: 'none',
              color: selfDeaf ? '#da373c' : 'var(--text-muted)',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
            }}
            title={selfDeaf ? 'Undeafen' : 'Deafen'}
          >
            <Headphones size={18} />
          </button>

          <button
            onClick={logout}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
            }}
            title="Log Out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
