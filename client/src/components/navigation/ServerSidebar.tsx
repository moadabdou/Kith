import { useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import type { Guild } from '../../types'

interface ServerSidebarProps {
  guilds: Guild[]
  selectedGuildId: string | null
  onSelectGuild: (guildId: string) => void
  onOpenCreateModal: () => void
}

export function ServerSidebar({
  guilds,
  selectedGuildId,
  onSelectGuild,
  onOpenCreateModal,
}: ServerSidebarProps) {
  const [hoveredGuildId, setHoveredGuildId] = useState<string | null>(null)

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .substring(0, 3)
      .toUpperCase()
  }

  return (
    <div className="server-rail">
      {/* Home / Discord icon */}
      <div className="server-icon-wrapper">
        <button
          className="server-icon-btn active"
          title="Direct Messages"
          style={{ backgroundColor: 'var(--brand)' }}
        >
          <MessageSquare size={24} />
        </button>
      </div>

      <div className="server-separator" />

      {/* Guild list */}
      {guilds.map((guild) => {
        const isActive = selectedGuildId === guild.id
        const isHovered = hoveredGuildId === guild.id

        return (
          <div
            key={guild.id}
            className="server-icon-wrapper"
            onMouseEnter={() => setHoveredGuildId(guild.id)}
            onMouseLeave={() => setHoveredGuildId(null)}
          >
            <div
              className={`pill-indicator ${isActive ? 'active' : ''} ${
                isHovered ? 'hover' : ''
              }`}
            />
            <button
              className={`server-icon-btn ${isActive ? 'active' : ''}`}
              onClick={() => onSelectGuild(guild.id)}
              title={guild.name}
            >
              {getInitials(guild.name)}
            </button>
          </div>
        )
      })}

      {/* Add Server button */}
      <div className="server-icon-wrapper">
        <button
          className="server-icon-btn"
          onClick={onOpenCreateModal}
          title="Add a Server"
          style={{ color: 'var(--success)' }}
        >
          <Plus size={24} />
        </button>
      </div>
    </div>
  )
}
