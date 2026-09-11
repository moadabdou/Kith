import { useEffect, useState } from 'react'
import { api } from '../../api'
import { gatewayClient } from '../../gateway/client'
import { useGateway } from '../../gateway/useGateway'
import { buildMemberGroups, displayName, initialsOf, memberNameColor } from '../../lib/members'
import type { Member, PresenceStatus, Role } from '../../types'

interface MemberSidebarProps {
  guildId: string | null
}

const DOT_COLORS: Record<string, string> = {
  online: 'var(--presence-online)',
  idle: 'var(--presence-idle)',
  dnd: 'var(--presence-dnd)',
  offline: 'var(--presence-offline)',
  invisible: 'var(--presence-offline)',
}

/**
 * Right-hand member sidebar (plan/11 Phase 2 gate & #38).
 * Self-contained data flow per house pattern:
 * - Roles via REST (GET /guilds/:id/roles) on guild selection — chunks carry
 *   role IDs only, metadata must come from elsewhere.
 * - Members + presence snapshot via Opcode 8 (presences: true) on guild
 *   selection / READY; chunks accumulate until chunk_index = chunk_count - 1.
 * - Live presence via PRESENCE_UPDATE (absence from snapshot = offline).
 */
export function MemberSidebar({ guildId }: MemberSidebarProps) {
  const {
    connected,
    requestGuildMembers,
    subscribeToMemberChunks,
    subscribeToPresenceUpdates,
    subscribeToMemberAdds,
    subscribeToMemberRemoves,
    onSessionReset,
  } = useGateway()

  const [roles, setRoles] = useState<Role[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [presences, setPresences] = useState<Map<string, PresenceStatus>>(new Map())
  const [streamDone, setStreamDone] = useState(false)

  // The parent keys this component by guild id: an instance is mounted for one
  // guild only, so guildId is stable for its lifetime and subscriptions can
  // capture it directly.

  // Role metadata via REST — chunks carry role IDs only
  useEffect(() => {
    if (!guildId) return
    let active = true

    api
      .getRoles(guildId)
      .then((list) => {
        if (active) setRoles(list)
      })
      .catch((err) => console.error('Failed to load roles:', err))

    return () => {
      active = false
    }
  }, [guildId])

  // Request the member stream once identified (op 8 requires IDENTIFY first).
  // Re-fires on reconnects so the sidebar heals after gateway drops.
  useEffect(() => {
    if (!guildId || !connected) return
    requestGuildMembers(guildId, { query: '', limit: 0, presences: true })
  }, [guildId, connected, requestGuildMembers])

  // Accumulate streamed chunks for the current guild; chunk_index 0 starts a
  // fresh stream (reset), later chunks merge — deduped by user id so RESUME
  // replays converge naturally.
  useEffect(() => {
    if (!guildId) return
    return subscribeToMemberChunks((chunk) => {
      if (chunk.guild_id !== guildId) return

      const freshStream = chunk.chunk_index === 0

      setMembers((prev) => {
        const map = new Map((freshStream ? [] : prev).map((m) => [m.user.id, m]))
        for (const m of chunk.members ?? []) map.set(m.user.id, m)
        return Array.from(map.values())
      })

      if (chunk.presences) {
        setPresences((prev) => {
          const map = freshStream ? new Map<string, PresenceStatus>() : new Map(prev)
          for (const p of chunk.presences ?? []) {
            if (p.status && p.status !== 'offline' && p.status !== 'invisible') {
              map.set(p.user.id, p.status)
            } else {
              map.delete(p.user.id)
            }
          }
          return map
        })
      }

      if (chunk.chunk_index >= chunk.chunk_count - 1) {
        setStreamDone(true)
      }
    })
  }, [guildId, subscribeToMemberChunks])

  // Live presence updates for the current guild (absence from map = offline)
  useEffect(() => {
    if (!guildId) return
    return subscribeToPresenceUpdates((update) => {
      if (update.guild_id !== guildId || !update.user?.id) return

      setPresences((prev) => {
        const map = new Map(prev)
        if (update.status && update.status !== 'offline' && update.status !== 'invisible') {
          map.set(update.user.id, update.status)
        } else {
          map.delete(update.user.id)
        }
        return map
      })
    })
  }, [guildId, subscribeToPresenceUpdates])

  // op 9 INVALID_SESSION: session is dead — clear and let the READY handler re-request
  useEffect(() => {
    return onSessionReset(() => {
      setMembers([])
      setPresences(new Map())
      setStreamDone(false)
    })
  }, [onSessionReset])

  // Live membership changes: the op 8 snapshot is point-in-time, so joins and
  // leaves arrive as GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE dispatches from the
  // REST side (published after commit). Without these, a member who joins after
  // the snapshot is invisible — their PRESENCE_UPDATE has no row to attach to.
  useEffect(() => {
    if (!guildId) return
    return subscribeToMemberAdds((payload) => {
      if (payload.guild_id !== guildId || !payload.user?.id) return
      setMembers((prev) => {
        if (prev.some((m) => m.user.id === payload.user.id)) return prev
        return [...prev, payload]
      })
    })
  }, [guildId, subscribeToMemberAdds])

  useEffect(() => {
    if (!guildId) return
    return subscribeToMemberRemoves((payload) => {
      if (payload.guild_id !== guildId || !payload.user?.id) return
      setMembers((prev) => prev.filter((m) => m.user.id !== payload.user.id))
      setPresences((prev) => {
        if (!prev.has(payload.user.id)) return prev
        const map = new Map(prev)
        map.delete(payload.user.id)
        return map
      })
    })
  }, [guildId, subscribeToMemberRemoves])

  // After a fresh IDENTIFY (READY), re-request this guild's members.
  // RESUME doesn't emit READY — missed chunks replay through the subscription.
  useEffect(() => {
    if (!guildId) return
    return gatewayClient.onReady(() => {
      requestGuildMembers(guildId, { query: '', limit: 0, presences: true })
    })
  }, [guildId, requestGuildMembers])

  const groups = buildMemberGroups(members, roles, presences)
  const onlineCount = groups.reduce((n, g) => (g.key === 'offline' ? n : n + g.members.length), 0)

  return (
    <div className="member-sidebar">
      <div className="member-scroll">
        {!guildId ? (
          <div className="member-empty">Select a server to see its members.</div>
        ) : !streamDone && members.length === 0 ? (
          <div className="member-empty">Loading members…</div>
        ) : groups.length === 0 ? (
          <div className="member-empty">No members</div>
        ) : (
          <>
            <div className="member-count-header">
              Online — {onlineCount}
            </div>
            {groups.map((group) => (
              <div key={group.key} className="member-group">
                <div
                  className="member-group-header"
                  style={group.color ? { color: group.color } : undefined}
                  title={group.label}
                >
                  {group.label} — {group.members.length}
                </div>
                {group.members.map((member) => {
                  const status = presences.get(member.user.id) ?? 'offline'
                  const nameColor = memberNameColor(member, roles)
                  const isOffline = status === 'offline' || status === 'invisible'
                  const name = displayName(member)
                  return (
                    <div
                      key={member.user.id}
                      className="member-item"
                      style={isOffline ? { opacity: 0.5 } : undefined}
                      title={`${name} (#${member.user.discriminator})`}
                    >
                      <div className="member-avatar-wrap">
                        <div className="member-avatar">{initialsOf(name)}</div>
                        <span className="presence-dot" style={{ backgroundColor: DOT_COLORS[status] }} />
                      </div>
                      <span
                        className="member-name"
                        style={nameColor && !isOffline ? { color: nameColor } : undefined}
                      >
                        {name}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
