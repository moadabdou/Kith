import { useEffect, useState } from 'react'
import { Hash, Lock, LogOut, Plus, Settings, UserPlus, Volume2 } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useGateway } from '../../gateway/useGateway'
import { ADMINISTRATOR, ALL_PERMISSIONS, hasPermission, MANAGE_CHANNELS, MANAGE_GUILD, MANAGE_ROLES, VIEW_CHANNEL } from '../../lib/permissions'
import type { Channel, Guild } from '../../types'

interface ChannelSidebarProps {
  currentGuild: Guild | null
  channels: Channel[]
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
  onOpenCreateChannelModal: () => void
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
  const { subscribeToMemberUpdates, subscribeToRoleUpdates, subscribeToRoleDeletes } = useGateway()
  const [userPermissions, setUserPermissions] = useState<bigint | null>(null)

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
      api.getMyPermissions(currentGuild.id)
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

  const textChannels = channels.filter((c) => c.type === 0)
  const voiceChannels = channels.filter((c) => c.type === 2)

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
            <div className="channels-list-header">
              <span>Text Channels</span>
              {canManageChannels && (
                <button
                  onClick={onOpenCreateChannelModal}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                  }}
                  title="Create Channel"
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

            {voiceChannels.length > 0 && (
              <>
                <div className="channels-list-header" style={{ marginTop: 12 }}>
                  <span>Voice Channels</span>
                </div>
                {voiceChannels.map((channel) => (
                  <div
                    key={channel.id}
                    className="channel-item"
                    style={{ opacity: 0.6, cursor: 'default' }}
                    title="Voice channels are part of Phase 5"
                  >
                    <Volume2 size={18} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {channel.name}
                    </span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

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
  )
}
