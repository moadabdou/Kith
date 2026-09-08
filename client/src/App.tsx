import { useEffect, useState } from 'react'
import { api } from './api'
import { AuthView } from './components/auth/AuthView'
import { ChatArea } from './components/chat/ChatArea'
import { CreateChannelModal } from './components/modals/CreateChannelModal'
import { CreateGuildModal } from './components/modals/CreateGuildModal'
import { InviteModal } from './components/modals/InviteModal'
import { ChannelSidebar } from './components/navigation/ChannelSidebar'
import { ServerSidebar } from './components/navigation/ServerSidebar'
import { ConnectionBanner } from './components/common/ConnectionBanner'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'
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
  const { onSessionReset } = useGateway()
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  const [isGuildModalOpen, setIsGuildModalOpen] = useState(false)
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false)
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [inviteFeedback, setInviteFeedback] = useState<{ message: string; isError?: boolean } | null>(null)

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

  const handleCreateChannel = async (name: string) => {
    if (!selectedGuildId) return
    const newChannel = await api.createChannel(selectedGuildId, name, 0)
    setChannels((prev) => [...prev, newChannel])
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
        onOpenCreateChannelModal={() => setIsChannelModalOpen(true)}
        onOpenInviteModal={() => setIsInviteModalOpen(true)}
      />

      {/* Main Chat Area */}
      <ChatArea
        currentGuild={currentGuild}
        currentChannel={currentChannel}
      />

      {/* Modals */}
      <CreateGuildModal
        isOpen={isGuildModalOpen}
        onClose={() => setIsGuildModalOpen(false)}
        onCreate={handleCreateGuild}
        onJoin={handleJoinGuild}
      />

      <CreateChannelModal
        isOpen={isChannelModalOpen}
        onClose={() => setIsChannelModalOpen(false)}
        onCreate={handleCreateChannel}
      />

      <InviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        guild={currentGuild}
        channel={currentChannel ?? channels[0] ?? null}
      />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <GatewayProvider>
        <Dashboard />
      </GatewayProvider>
    </AuthProvider>
  )
}
