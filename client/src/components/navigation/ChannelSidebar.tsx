import { Hash, LogOut, Plus, Volume2 } from 'lucide-react'
import { useAuth } from '../../context/useAuth'
import type { Channel, Guild } from '../../types'

interface ChannelSidebarProps {
  currentGuild: Guild | null
  channels: Channel[]
  selectedChannelId: string | null
  onSelectChannel: (channelId: string) => void
  onOpenCreateChannelModal: () => void
}

export function ChannelSidebar({
  currentGuild,
  channels,
  selectedChannelId,
  onSelectChannel,
  onOpenCreateChannelModal,
}: ChannelSidebarProps) {
  const { user, logout } = useAuth()

  const textChannels = channels.filter((c) => c.type === 0)
  const voiceChannels = channels.filter((c) => c.type === 2)

  return (
    <div className="channel-sidebar">
      {/* Guild Header */}
      <div className="guild-header">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentGuild?.name ?? 'Select a Server'}
        </span>
      </div>

      {/* Channels List */}
      <div className="channels-scroll">
        {currentGuild && (
          <>
            <div className="channels-list-header">
              <span>Text Channels</span>
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
            </div>

            {textChannels.map((channel) => {
              const isActive = selectedChannelId === channel.id
              return (
                <div
                  key={channel.id}
                  className={`channel-item ${isActive ? 'active' : ''}`}
                  onClick={() => onSelectChannel(channel.id)}
                >
                  <Hash size={18} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {channel.name}
                  </span>
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
