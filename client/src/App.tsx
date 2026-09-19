import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { AuthView } from './components/auth/AuthView'
import { ChatArea } from './components/chat/ChatArea'
import { ChannelSettingsModal } from './components/modals/ChannelSettingsModal'
import { CreateChannelModal } from './components/modals/CreateChannelModal'
import { CreateGuildModal } from './components/modals/CreateGuildModal'
import { InviteModal } from './components/modals/InviteModal'
import { ServerSettingsModal } from './components/modals/ServerSettingsModal'
import { ChannelSidebar } from './components/navigation/ChannelSidebar'
import { MemberSidebar } from './components/navigation/MemberSidebar'
import { ServerSidebar } from './components/navigation/ServerSidebar'
import { ConnectionBanner } from './components/common/ConnectionBanner'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'
import { VoiceProvider } from './context/VoiceContext'
import { VoiceChannelView } from './components/voice/VoiceChannelView'
import { GatewayProvider } from './gateway/GatewayContext'
import { useGateway } from './gateway/useGateway'
import type { Channel, Guild } from './types'

function getInviteCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  // 1. Path format: /join/:code or /invite/:code
  const pathMatch = window.location.pathname.match(/^\/(?:join|invite)\/([^/?#]+)/)
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[1])
  }
  // 2. Query param format: ?invite=:code or ?code=:code
  const urlParams = new URLSearchParams(window.location.search)
  const param = urlParams.get('invite') || urlParams.get('code')
  if (param) {
    return param.trim()
  }
  return null
}

// Preserve invite code immediately on load so it survives auth redirect
const initialInvite = getInviteCodeFromUrl()
if (initialInvite && typeof window !== 'undefined') {
  sessionStorage.setItem('kith_pending_invite', initialInvite)
}

function Dashboard() {
  const { user, loading } = useAuth()
  const {
    onSessionReset,
    subscribeToChannelCreates,
    subscribeToChannelUpdates,
    subscribeToChannelDeletes,
  } = useGateway()
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  const [isGuildModalOpen, setIsGuildModalOpen] = useState(false)
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false)
  const [createChannelDefaultType, setCreateChannelDefaultType] = useState<number>(0)
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [isServerSettingsModalOpen, setIsServerSettingsModalOpen] = useState(false)
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<Channel | null>(null)
  const [inviteFeedback, setInviteFeedback] = useState<{ message: string; isError?: boolean } | null>(null)

  const refreshChannels = useCallback(async () => {
    if (!selectedGuildId) return
    try {
      const list = await api.getChannels(selectedGuildId)
      setChannels(list)
    } catch (err) {
      console.error('Failed to reload channels:', err)
    }
  }, [selectedGuildId])

  // Fetch guilds when user is authenticated
  useEffect(() => {
    if (!user) return
    let active = true

    api.getMyGuilds()
      .then((list) => {
        if (!active) return
        setGuilds(list)
        if (list.length > 0) {
          setSelectedGuildId((prev) => prev ?? list[0].id)
        }
      })
      .catch((err) => console.error('Failed to load guilds:', err))

    return () => {
      active = false
    }
  }, [user])

  // Fetch channels when selected guild changes
  useEffect(() => {
    if (!selectedGuildId) return
    let active = true

    api.getChannels(selectedGuildId)
      .then((list) => {
        if (!active) return
        setChannels(list)
        const firstText = list.find((c) => c.type === 0)
        setSelectedChannelId(firstText?.id ?? list[0]?.id ?? null)
      })
      .catch((err) => console.error('Failed to load channels:', err))

    return () => {
      active = false
    }
  }, [selectedGuildId])

  // On session reset (Op 9 INVALID_SESSION), refetch guilds and active channels
  useEffect(() => {
    return onSessionReset(() => {
      console.log('[Dashboard] session reset received (op 9) — refetching state...')
      api.getMyGuilds()
        .then((list) => {
          setGuilds(list)
        })
        .catch((err) => console.error('Failed to reload guilds on session reset:', err))

      if (selectedGuildId) {
        api.getChannels(selectedGuildId)
          .then((list) => {
            setChannels(list)
          })
          .catch((err) => console.error('Failed to reload channels on session reset:', err))
      }
    })
  }, [onSessionReset, selectedGuildId])

  // Real-time channel creates, updates, and deletes via WebSocket
  useEffect(() => {
    if (!selectedGuildId) return

    const uCreate = subscribeToChannelCreates((payload) => {
      const gid = payload.guild_id || (payload.channel as any)?.guild_id
      if (gid && String(gid) !== String(selectedGuildId)) return
      const rawChan: any = payload.channel || payload
      const chanId = rawChan?.id || payload.id
      if (!chanId) return
      const newChan: Channel = {
        ...rawChan,
        id: String(chanId),
        guild_id: String(rawChan.guild_id || gid || selectedGuildId),
      }
      setChannels((prev) => {
        if (prev.some((c) => String(c.id) === String(newChan.id))) return prev
        return [...prev, newChan]
      })
    })

    const uUpdate = subscribeToChannelUpdates((payload) => {
      const gid = payload.guild_id || (payload.channel as any)?.guild_id
      if (gid && String(gid) !== String(selectedGuildId)) return
      const rawChan: any = payload.channel || payload
      const chanId = rawChan?.id || payload.id
      if (!chanId) return
      setChannels((prev) =>
        prev.map((c) => {
          if (String(c.id) !== String(chanId)) return c
          return {
            ...c,
            ...rawChan,
            id: String(c.id),
            permission_overwrites:
              payload.permission_overwrites ??
              rawChan.permission_overwrites ??
              c.permission_overwrites,
          }
        })
      )
    })

    const uDelete = subscribeToChannelDeletes((payload) => {
      const gid = payload.guild_id
      if (gid && String(gid) !== String(selectedGuildId)) return
      const delId = payload.id || (payload.channel as any)?.id
      if (!delId) return
      setChannels((prev) => {
        const next = prev.filter((c) => String(c.id) !== String(delId))
        setSelectedChannelId((currentSelected) => {
          if (String(currentSelected) === String(delId)) {
            return next[0]?.id ?? null
          }
          return currentSelected
        })
        return next
      })
    })

    return () => {
      uCreate()
      uUpdate()
      uDelete()
    }
  }, [
    selectedGuildId,
    subscribeToChannelCreates,
    subscribeToChannelUpdates,
    subscribeToChannelDeletes,
  ])

  const handleCreateGuild = async (name: string) => {
    const newGuild = await api.createGuild(name)
    setGuilds((prev) => [...prev, newGuild])
    setSelectedGuildId(newGuild.id)
  }

  const handleJoinGuild = async (code: string) => {
    try {
      const joinedGuild = await api.joinInvite(code)
      setGuilds((prev) => {
        if (prev.some((g) => g.id === joinedGuild.id)) return prev
        return [...prev, joinedGuild]
      })
      setSelectedGuildId(joinedGuild.id)
      setInviteFeedback({ message: `Successfully joined ${joinedGuild.name}!` })
      setTimeout(() => setInviteFeedback(null), 4000)
    } catch (err: any) {
      setInviteFeedback({ message: err.message || 'Failed to join server', isError: true })
      setTimeout(() => setInviteFeedback(null), 5000)
      throw err
    }
  }

  // Auto-join if arriving via invite URL or pending invite in session
  useEffect(() => {
    if (!user) return

    const pendingCode = getInviteCodeFromUrl() || sessionStorage.getItem('kith_pending_invite')
    if (!pendingCode) return

    sessionStorage.removeItem('kith_pending_invite')
    window.history.replaceState({}, document.title, '/')

    let active = true
    api.joinInvite(pendingCode)
      .then((joinedGuild) => {
        if (!active) return
        setGuilds((prev) => {
          if (prev.some((g) => g.id === joinedGuild.id)) return prev
          return [...prev, joinedGuild]
        })
        setSelectedGuildId(joinedGuild.id)
        setInviteFeedback({ message: `Successfully joined ${joinedGuild.name}!` })
        setTimeout(() => setInviteFeedback(null), 4000)
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to join via invite URL:', err)
          setInviteFeedback({
            message: err.message || 'Failed to join server. Invite code may be invalid or expired.',
            isError: true,
          })
          setTimeout(() => setInviteFeedback(null), 5000)
        }
      })

    return () => {
      active = false
    }
  }, [user])

  const handleOpenCreateChannelModal = (defaultType = 0) => {
    setCreateChannelDefaultType(defaultType)
    setIsChannelModalOpen(true)
  }

  const handleCreateChannel = async (name: string, type = 0) => {
    if (!selectedGuildId) return
    const newChannel = await api.createChannel(selectedGuildId, name, type)
    setChannels((prev) => {
      if (prev.some((c) => String(c.id) === String(newChannel.id))) return prev
      return [...prev, newChannel]
    })
    setSelectedChannelId(newChannel.id)
  }

  if (loading) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--bg-chat)',
          color: 'var(--text-muted)',
          fontSize: 18,
          fontWeight: 600,
        }}
      >
        Loading Kith…
      </div>
    )
  }

  if (!user) {
    return <AuthView />
  }

  const currentGuild = guilds.find((g) => g.id === selectedGuildId) ?? null
  const currentChannel = channels.find((c) => c.id === selectedChannelId) ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <ConnectionBanner />
      <div className="app-container" style={{ flex: 1, minHeight: 0 }}>
      {inviteFeedback && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: inviteFeedback.isError ? '#da373c' : '#23a55a',
            color: 'white',
            padding: '10px 24px',
            borderRadius: 8,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            zIndex: 99999,
            fontWeight: 600,
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {inviteFeedback.message}
        </div>
      )}
      {/* 72px Left Rail */}
      <ServerSidebar
        guilds={guilds}
        selectedGuildId={selectedGuildId}
        onSelectGuild={(id) => setSelectedGuildId(id)}
        onOpenCreateModal={() => setIsGuildModalOpen(true)}
      />

      {/* 240px Channels Sidebar */}
      <ChannelSidebar
        currentGuild={currentGuild}
        channels={channels}
        selectedChannelId={selectedChannelId}
        onSelectChannel={(id) => setSelectedChannelId(id)}
        onOpenCreateChannelModal={handleOpenCreateChannelModal}
        onOpenInviteModal={() => setIsInviteModalOpen(true)}
        onOpenServerSettingsModal={() => setIsServerSettingsModalOpen(true)}
        onOpenChannelSettingsModal={(ch) => setChannelSettingsTarget(ch)}
      />

      {/* Main Content Area: Voice Stage if voice channel, ChatArea if text channel */}
      {currentChannel && Number(currentChannel.type) === 2 ? (
        <VoiceChannelView
          currentGuild={currentGuild}
          channel={currentChannel}
        />
      ) : (
        <ChatArea
          currentGuild={currentGuild}
          currentChannel={currentChannel}
          channels={channels}
          onSelectChannel={(id) => setSelectedChannelId(id)}
        />
      )}

      {/* 240px Member Sidebar (right of chat). Keyed by guild so switching
          guilds remounts it with fresh state instead of hand-rolled resets. */}
      <MemberSidebar key={selectedGuildId ?? 'none'} guildId={selectedGuildId} guild={currentGuild} />

      {/* Modals */}
      <CreateGuildModal
        isOpen={isGuildModalOpen}
        onClose={() => setIsGuildModalOpen(false)}
        onCreate={handleCreateGuild}
        onJoin={handleJoinGuild}
      />

      <CreateChannelModal
        isOpen={isChannelModalOpen}
        initialType={createChannelDefaultType}
        onClose={() => setIsChannelModalOpen(false)}
        onCreate={handleCreateChannel}
      />

      <InviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        guild={currentGuild}
        channel={currentChannel ?? channels[0] ?? null}
      />

      <ServerSettingsModal
        isOpen={isServerSettingsModalOpen}
        guild={currentGuild}
        onClose={() => setIsServerSettingsModalOpen(false)}
      />

      <ChannelSettingsModal
        isOpen={channelSettingsTarget != null}
        guild={currentGuild}
        channel={channelSettingsTarget}
        onClose={() => setChannelSettingsTarget(null)}
        onChannelUpdated={refreshChannels}
        onChannelDeleted={(deletedId) => {
          setChannels((prev) => prev.filter((c) => c.id !== deletedId))
          if (selectedChannelId === deletedId) {
            setSelectedChannelId(channels.find((c) => c.id !== deletedId)?.id ?? null)
          }
        }}
      />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <GatewayProvider>
        <VoiceProvider>
          <Dashboard />
        </VoiceProvider>
      </GatewayProvider>
    </AuthProvider>
  )
}
