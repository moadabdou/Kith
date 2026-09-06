import { useEffect, useState } from 'react'
import { api } from './api'
import { AuthView } from './components/auth/AuthView'
import { ChatArea } from './components/chat/ChatArea'
import { CreateChannelModal } from './components/modals/CreateChannelModal'
import { CreateGuildModal } from './components/modals/CreateGuildModal'
import { InviteModal } from './components/modals/InviteModal'
import { ChannelSidebar } from './components/navigation/ChannelSidebar'
import { ServerSidebar } from './components/navigation/ServerSidebar'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'
import type { Channel, Guild } from './types'

function Dashboard() {
  const { user, loading } = useAuth()
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)

  const [isGuildModalOpen, setIsGuildModalOpen] = useState(false)
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false)
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)

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

  const handleCreateGuild = async (name: string) => {
    const newGuild = await api.createGuild(name)
    setGuilds((prev) => [...prev, newGuild])
    setSelectedGuildId(newGuild.id)
  }

  const handleJoinGuild = async (code: string) => {
    const joinedGuild = await api.joinInvite(code)
    setGuilds((prev) => {
      if (prev.some((g) => g.id === joinedGuild.id)) return prev
      return [...prev, joinedGuild]
    })
    setSelectedGuildId(joinedGuild.id)
  }

  // Detect ?invite=XYZ query param to auto-join
  useEffect(() => {
    if (!user) return
    const urlParams = new URLSearchParams(window.location.search)
    const inviteParam = urlParams.get('invite')
    if (!inviteParam) return

    let active = true
    api.joinInvite(inviteParam)
      .then((joinedGuild) => {
        if (!active) return
        setGuilds((prev) => {
          if (prev.some((g) => g.id === joinedGuild.id)) return prev
          return [...prev, joinedGuild]
        })
        setSelectedGuildId(joinedGuild.id)
        window.history.replaceState({}, document.title, window.location.pathname)
      })
      .catch((err) => {
        if (active) console.error('Failed to join via invite URL:', err)
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
    <div className="app-container">
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
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Dashboard />
    </AuthProvider>
  )
}
