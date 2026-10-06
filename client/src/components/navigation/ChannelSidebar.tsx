import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Hash,
  Headphones,
  Lock,
  Mic,
  MicOff,
  Plus,
  Settings,
  UserPlus,
  Volume2,
} from 'lucide-react'
import { api } from '../../api'
import { gatewayClient } from '../../gateway/client'
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
import {
  applyIncomingMention,
  clearChannelMentions,
  hydrateMentionCounts,
  isIdNewer,
  messageMentionsUser,
  type MentionCountState,
} from '../../lib/mentionCounts'

interface ChannelSidebarProps {
  currentGuild: Guild | null
  channels: Channel[]
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
  onOpenCreateChannelModal: (defaultType?: number) => void
  onOpenInviteModal: () => void
  onOpenServerSettingsModal?: () => void
  onOpenChannelSettingsModal?: (channel: Channel) => void
  // Unread mention badges (Issue #122). State lives in App so the guild rail
  // can aggregate per-guild counts; this sidebar is the sole writer.
  mentionState: MentionCountState
  setMentionState: React.Dispatch<React.SetStateAction<MentionCountState>>
  onJumpToMention?: (channelId: string, messageId: string) => void
  onOpenUserSettings?: () => void
  presenceStatus?: 'online' | 'idle' | 'dnd' | 'invisible'
  onStatusChange?: (status: 'online' | 'idle' | 'dnd' | 'invisible') => void
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
  mentionState,
  setMentionState,
  onJumpToMention,
  onOpenUserSettings,
  presenceStatus: externalPresence,
  onStatusChange: externalStatusChange,
}: ChannelSidebarProps) {
  const { user } = useAuth()
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
  // Newest counted message per channel: replayed/resumed gateway events older
  // than this never double-count a badge.
  const lastCountedRef = useRef<Record<string, string>>({})

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
    setMentionState((prev) => hydrateMentionCounts(prev, states))
  }, [setMentionState])

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
      } else if (user && msg.channel_id) {
        // Background channel: feed the mention badge (Issue #122). The open
        // channel never badges — viewing it is reading it.
        const lastCounted = lastCountedRef.current[msg.channel_id]
        if (!lastCounted || isIdNewer(msg.id, lastCounted)) {
          const roles = guildMembers.get(user.id)?.roles ?? []
          if (messageMentionsUser(msg, { userId: user.id, roleIds: roles })) {
            lastCountedRef.current[msg.channel_id] = msg.id
            setMentionState((prev) => applyIncomingMention(prev, msg.channel_id, msg.id))
          }
        }
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
      // An ack (ours, or another tab's) marks the channel read: drop its badge.
      setMentionState((prev) => clearChannelMentions(prev, ack.channel_id))
    })

    return () => {
      unsubMsg()
      unsubAck()
    }
  }, [subscribeToMessages, subscribeToMessageAcks, selectedChannelId, user, guildMembers, setMentionState])

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
    // Selecting reads the channel: the badge clears (ack carries count 0).
    setMentionState((prev) => clearChannelMentions(prev, channelId))
  }

  const handleMentionBadgeClick = (channelId: string) => {
    // Capture the jump target before handleSelectChannel clears badge state.
    const targetId = mentionState.firstIds[channelId]
    handleSelectChannel(channelId)
    if (targetId) {
      onJumpToMention?.(channelId, targetId)
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

  // Collapsed category state persisted in localStorage per guild
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('kith_collapsed_categories')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  const isTextCollapsed = Boolean(currentGuild && collapsedCategories[`${currentGuild.id}:text`])
  const isVoiceCollapsed = Boolean(currentGuild && collapsedCategories[`${currentGuild.id}:voice`])

  const toggleCategory = useCallback(
    (type: 'text' | 'voice') => {
      if (!currentGuild) return
      const key = `${currentGuild.id}:${type}`
      setCollapsedCategories((prev) => {
        const next = { ...prev, [key]: !prev[key] }
        try {
          localStorage.setItem('kith_collapsed_categories', JSON.stringify(next))
        } catch {
          // ignore storage errors
        }
        return next
      })
    },
    [currentGuild]
  )

  const textMentionTotal = useMemo(() => {
    return textChannels.reduce((sum, ch) => sum + (mentionState.counts[ch.id] ?? 0), 0)
  }, [textChannels, mentionState.counts])

  const voiceMentionTotal = useMemo(() => {
    return voiceChannels.reduce((sum, ch) => sum + (mentionState.counts[ch.id] ?? 0), 0)
  }, [voiceChannels, mentionState.counts])

  // Presence state: sync with external prop or localStorage
  const [internalPresence, setInternalPresence] = useState<'online' | 'idle' | 'dnd' | 'invisible'>(() => {
    try {
      const saved = localStorage.getItem('kith_user_presence')
      if (saved === 'online' || saved === 'idle' || saved === 'dnd' || saved === 'invisible') {
        return saved
      }
    } catch {}
    return 'online'
  })

  // Sync internal presence when external prop updates
  useEffect(() => {
    if (externalPresence) {
      setInternalPresence(externalPresence)
    }
  }, [externalPresence])

  const presenceStatus = externalPresence ?? internalPresence
  const [isPresenceMenuOpen, setIsPresenceMenuOpen] = useState(false)
  const presenceMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isPresenceMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (presenceMenuRef.current && !presenceMenuRef.current.contains(e.target as Node)) {
        setIsPresenceMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isPresenceMenuOpen])

  const handleStatusSelect = (status: 'online' | 'idle' | 'dnd' | 'invisible') => {
    setInternalPresence(status)
    try {
      localStorage.setItem('kith_user_presence', status)
    } catch {}
    if (externalStatusChange) {
      externalStatusChange(status)
    } else {
      gatewayClient.sendStatusUpdate(status)
    }
    setIsPresenceMenuOpen(false)
  }

  const PRESENCE_OPTIONS = [
    { id: 'online' as const, label: 'Online', color: 'var(--presence-online, #23a55a)' },
    { id: 'idle' as const, label: 'Idle', color: 'var(--presence-idle, #f0b232)' },
    { id: 'dnd' as const, label: 'Do Not Disturb', color: 'var(--presence-dnd, #f23f43)' },
    { id: 'invisible' as const, label: 'Invisible', color: 'var(--presence-offline, #80848e)' },
  ]

  return (
    <div className="channel-sidebar">
      {/* Guild Header & Banner */}
      {currentGuild?.banner ? (
        <div className="guild-banner-header">
          <img src={currentGuild.banner} alt={currentGuild.name} className="guild-banner-header-img" />
          <div className="guild-banner-header-gradient" />
          <div className="guild-header banner-overlay-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
              {currentGuild.icon && (
                <img src={currentGuild.icon} alt="" className="guild-header-icon" />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentGuild.name}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {canManageServer && onOpenServerSettingsModal && (
                <button
                  type="button"
                  onClick={onOpenServerSettingsModal}
                  className="guild-header-btn"
                  title="Server Settings"
                >
                  <Settings size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={onOpenInviteModal}
                className="guild-header-btn"
                title="Invite People"
              >
                <UserPlus size={18} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="guild-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
            {currentGuild?.icon && (
              <img src={currentGuild.icon} alt="" className="guild-header-icon" />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentGuild?.name ?? 'Select a Server'}
            </span>
          </div>
          {currentGuild && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {canManageServer && onOpenServerSettingsModal && (
                <button
                  type="button"
                  onClick={onOpenServerSettingsModal}
                  className="guild-header-btn"
                  title="Server Settings"
                >
                  <Settings size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={onOpenInviteModal}
                className="guild-header-btn"
                title="Invite People"
              >
                <UserPlus size={18} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Channels List */}
      <div className="channels-scroll">
        {currentGuild && (
          <>
            {/* Text Channels Section */}
            <div className="channels-list-header">
              <button
                type="button"
                className="category-toggle-btn"
                onClick={() => toggleCategory('text')}
                aria-expanded={!isTextCollapsed}
                title={isTextCollapsed ? 'Expand Text Channels' : 'Collapse Text Channels'}
              >
                <ChevronDown
                  size={12}
                  className={`category-chevron ${isTextCollapsed ? 'collapsed' : ''}`}
                />
                <span className="category-title">Text Channels</span>
                {isTextCollapsed && textMentionTotal > 0 && (
                  <span
                    className="category-mention-pill"
                    title={`${textMentionTotal} unread mention${textMentionTotal === 1 ? '' : 's'}`}
                  >
                    {textMentionTotal > 99 ? '99+' : textMentionTotal}
                  </span>
                )}
              </button>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenCreateChannelModal(0)
                  }}
                  className="category-add-btn"
                  title="Create Text Channel"
                  aria-label="Create Text Channel"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>

            {!isTextCollapsed &&
              textChannels.map((channel) => {
                const isActive = selectedChannelId === channel.id
                const isPrivate = isPrivateChannel(channel, currentGuild.id)
                const isUnread = isChannelUnread(channel.id)
                const mentionCount = mentionState.counts[channel.id] ?? 0
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {mentionCount > 0 && (
                        <button
                          type="button"
                          className="channel-mention-badge"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleMentionBadgeClick(channel.id)
                          }}
                          title={`${mentionCount} unread mention${mentionCount === 1 ? '' : 's'} — jump to first`}
                        >
                          {mentionCount > 99 ? '99+' : mentionCount}
                        </button>
                      )}
                      {onOpenInviteModal && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenInviteModal()
                          }}
                          className="channel-action-btn channel-invite-btn"
                          title="Create Invite"
                          aria-label="Create Invite"
                        >
                          <UserPlus size={14} />
                        </button>
                      )}
                      {canManageChannels && onOpenChannelSettingsModal && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenChannelSettingsModal(channel)
                          }}
                          className="channel-action-btn channel-settings-btn"
                          title="Edit Channel"
                          aria-label="Edit Channel"
                        >
                          <Settings size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}

            {/* Voice Channels Section */}
            <div className="channels-list-header" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="category-toggle-btn"
                onClick={() => toggleCategory('voice')}
                aria-expanded={!isVoiceCollapsed}
                title={isVoiceCollapsed ? 'Expand Voice Channels' : 'Collapse Voice Channels'}
              >
                <ChevronDown
                  size={12}
                  className={`category-chevron ${isVoiceCollapsed ? 'collapsed' : ''}`}
                />
                <span className="category-title">Voice Channels</span>
                {isVoiceCollapsed && voiceMentionTotal > 0 && (
                  <span
                    className="category-mention-pill"
                    title={`${voiceMentionTotal} unread mention${voiceMentionTotal === 1 ? '' : 's'}`}
                  >
                    {voiceMentionTotal > 99 ? '99+' : voiceMentionTotal}
                  </span>
                )}
              </button>
              {canManageChannels && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenCreateChannelModal(2)
                  }}
                  className="category-add-btn"
                  title="Create Voice Channel"
                  aria-label="Create Voice Channel"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>

            {!isVoiceCollapsed &&
              voiceChannels.map((channel) => {
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

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {onOpenInviteModal && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpenInviteModal()
                            }}
                            className="channel-action-btn channel-invite-btn"
                            title="Create Invite"
                            aria-label="Create Invite"
                          >
                            <UserPlus size={14} />
                          </button>
                        )}
                        {canManageChannels && onOpenChannelSettingsModal && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpenChannelSettingsModal(channel)
                            }}
                            className="channel-action-btn channel-settings-btn"
                            title="Edit Voice Channel"
                            aria-label="Edit Voice Channel"
                          >
                            <Settings size={14} />
                          </button>
                        )}
                      </div>
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
      <div className="user-profile-bar" ref={presenceMenuRef}>
        {/* Presence Quick Popover */}
        {isPresenceMenuOpen && (
          <div className="user-presence-popover">
            <div
              style={{
                padding: '6px 8px 4px',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}
            >
              Set Status
            </div>
            {PRESENCE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`presence-option-btn ${presenceStatus === opt.id ? 'selected' : ''}`}
                onClick={() => handleStatusSelect(opt.id)}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: opt.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>{opt.label}</span>
                {presenceStatus === opt.id && <Check size={14} />}
              </button>
            ))}
          </div>
        )}

        <div
          className="user-info-area"
          title={`@${user?.username}#${user?.discriminator} (${presenceStatus})\nClick to change status`}
          onClick={() => setIsPresenceMenuOpen((prev) => !prev)}
        >
          <div className="user-avatar-wrap">
            <div className="user-avatar">
              {user?.username?.substring(0, 2).toUpperCase() ?? 'U'}
            </div>
            <span
              className="user-presence-dot"
              style={{
                backgroundColor:
                  PRESENCE_OPTIONS.find((p) => p.id === presenceStatus)?.color ||
                  'var(--presence-online, #23a55a)',
              }}
            />
          </div>
          <div className="user-text">
            <span className="user-username">{user?.username}</span>
            <span className="user-discriminator">#{user?.discriminator}</span>
          </div>
        </div>

        <div className="user-controls">
          {/* Quick Voice Controls: Mute & Deafen */}
          <button
            type="button"
            className={`user-control-btn ${selfMute ? 'active-danger' : ''}`}
            onClick={toggleMute}
            title={selfMute ? 'Unmute' : 'Mute'}
            aria-label={selfMute ? 'Unmute' : 'Mute'}
          >
            {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
          </button>

          <button
            type="button"
            className={`user-control-btn ${selfDeaf ? 'active-danger' : ''}`}
            onClick={toggleDeaf}
            title={selfDeaf ? 'Undeafen' : 'Deafen'}
            aria-label={selfDeaf ? 'Undeafen' : 'Deafen'}
          >
            <Headphones size={18} />
          </button>

          <button
            type="button"
            className="user-control-btn"
            onClick={onOpenUserSettings}
            title="User Settings"
            aria-label="User Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
