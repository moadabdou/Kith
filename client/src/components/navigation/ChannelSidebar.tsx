import { useCallback, useEffect, useState } from 'react'
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
import type { Channel, ChannelLatest, Guild, Member, ReadState } from '../../types'
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

// Snowflake-aware max comparison with lexicographic fallback for malformed ids.
function isSnowflakeNewer(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return a > b
  }
}

// Max-wins merge of [channel_id, message_id] pairs into a cursor map so a
// stale hydration response never clobbers a newer live event value.
function mergeMaxIds(
  prev: Record<string, string>,
  pairs: Array<readonly [string, string]>
): Record<string, string> {
  let changed = false
  const next = { ...prev }
  for (const [key, id] of pairs) {
    if (!key || !id) continue
    const cur = next[key]
    if (!cur || isSnowflakeNewer(id, cur)) {
      next[key] = id
      changed = true
    }
  }
  return changed ? next : prev
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
    subscribeToMessages,
    subscribeToMessageAcks,
    subscribeToReady,
    onSessionReset,
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
  const [readStates, setReadStates] = useState<Record<string, string>>({}) // channel_id -> last_read_message_id
  const [channelLatestMessage, setChannelLatestMessage] = useState<Record<string, string>>({}) // channel_id -> latest_message_id

  const guildId = currentGuild?.id

  // Applies a hydration payload with max-wins merges so stale responses never
  // regress cursor maps already advanced by live gateway events.
  const applyHydration = useCallback((states: ReadState[], latest: ChannelLatest[]) => {
    setReadStates((prev) =>
      mergeMaxIds(
        prev,
        states.map((s) => [s.channel_id, s.last_read_message_id] as const)
      )
    )
    setChannelLatestMessage((prev) =>
      mergeMaxIds(
        prev,
        latest.map((l) => [l.channel_id, l.last_message_id] as const)
      )
    )
  }, [])

  // Hydrate both halves of the unread comparison on login / guild switch:
  // read states (Scylla) + latest-message cursors (bulk endpoint). Without the
  // latest half, badges stay clear until the next live MESSAGE_CREATE (#105).
  useEffect(() => {
    if (!user || !guildId) return
    let active = true
    Promise.all([api.getReadStates(), api.getChannelsLatest(guildId)])
      .then(([states, latest]) => {
        if (!active) return
        applyHydration(states, latest)
      })
      .catch((err) => console.error('Failed to hydrate unread state:', err))

    return () => {
      active = false
    }
  }, [user, guildId, applyHydration])

  // Re-hydrate after gateway READY / session reset: replayed or missed events
  // may have moved cursors while the socket was down.
  useEffect(() => {
    if (!user || !guildId) return
    const rehydrate = () => {
      Promise.all([api.getReadStates(), api.getChannelsLatest(guildId)])
        .then(([states, latest]) => applyHydration(states, latest))
        .catch((err) => console.error('Failed to rehydrate unread state:', err))
    }
    const unsubReady = subscribeToReady(() => rehydrate())
    const unsubReset = onSessionReset(() => rehydrate())
    return () => {
      unsubReady()
      unsubReset()
    }
  }, [user, guildId, applyHydration, subscribeToReady, onSessionReset])

  // Track latest message snowflakes and message ack events in real time
  useEffect(() => {
    const unsubMsg = subscribeToMessages((msg) => {
      setChannelLatestMessage((prev) => {
        const cur = prev[msg.channel_id]
        if (!cur || isSnowflakeNewer(msg.id, cur)) {
          return { ...prev, [msg.channel_id]: msg.id }
        }
        return prev
      })
      if (selectedChannelId === msg.channel_id) {
        api.ackMessage(msg.channel_id, msg.id).catch(() => {})
        setReadStates((prev) => ({ ...prev, [msg.channel_id]: msg.id }))
      }
    })

    const unsubAck = subscribeToMessageAcks((ack) => {
      setReadStates((prev) => {
        const cur = prev[ack.channel_id]
        if (!cur || isSnowflakeNewer(ack.message_id, cur)) {
          return { ...prev, [ack.channel_id]: ack.message_id }
        }
        return prev
      })
    })

    return () => {
      unsubMsg()
      unsubAck()
    }
  }, [subscribeToMessages, subscribeToMessageAcks, selectedChannelId])

  const isChannelUnread = (channelId: string): boolean => {
    if (selectedChannelId === channelId) return false
    const latest = channelLatestMessage[channelId]
    if (!latest) return false
    const lastRead = readStates[channelId]
    if (!lastRead) return true
    return isSnowflakeNewer(latest, lastRead)
  }

  const handleSelectChannel = (channelId: string) => {
    onSelectChannel(channelId)
    const latestId = channelLatestMessage[channelId]
    if (latestId) {
      api.ackMessage(channelId, latestId).catch(() => {})
      setReadStates((prev) => ({ ...prev, [channelId]: latestId }))
    }
  }

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
              const isUnread = isChannelUnread(channel.id)
              return (
                <div
                  key={channel.id}
                  className={`channel-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}`}
                  onClick={() => handleSelectChannel(channel.id)}
                  title={isPrivate ? `${channel.name} (Private Channel)` : channel.name}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}
                >
                  {isUnread && <span className="channel-unread-pill" />}
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
