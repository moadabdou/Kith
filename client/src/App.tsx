import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { AuthView } from './components/auth/AuthView'
import { ChatArea } from './components/chat/ChatArea'
import { ChannelSettingsModal } from './components/modals/ChannelSettingsModal'
import { CreateChannelModal } from './components/modals/CreateChannelModal'
import { CreateGuildModal } from './components/modals/CreateGuildModal'
import { InviteModal } from './components/modals/InviteModal'
import { ServerSettingsModal } from './components/modals/ServerSettingsModal'
import { UserSettingsModal } from './components/modals/UserSettingsModal'
import { ChannelSidebar } from './components/navigation/ChannelSidebar'
import { MemberSidebar } from './components/navigation/MemberSidebar'
import { ServerSidebar } from './components/navigation/ServerSidebar'
import { gatewayClient } from './gateway/client'
import { ConnectionBanner } from './components/common/ConnectionBanner'
import { UnverifiedEmailBanner } from './components/common/UnverifiedEmailBanner'
import { EmailVerificationModal } from './components/auth/EmailVerificationModal'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './context/useAuth'
import { VoiceProvider } from './context/VoiceContext'
import { useVoice } from './context/useVoice'
import { VoiceChannelView } from './components/voice/VoiceChannelView'
import { VoicePipMiniPlayer } from './components/voice/VoicePipMiniPlayer'
import { GatewayProvider } from './gateway/GatewayContext'
import { useGateway } from './gateway/useGateway'
import type { Channel, Guild } from './types'
import { EMPTY_MENTION_STATE, type MentionCountState } from './lib/mentionCounts'

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
  const { user, loading, logout, updateUser, verifyEmail } = useAuth()
  const { activeVoice } = useVoice()
  const {
    onSessionReset,
    subscribeToGuildUpdates,
    subscribeToChannelCreates,
    subscribeToChannelUpdates,
    subscribeToChannelDeletes,
  } = useGateway()
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  // Unread mention badges (Issue #122): single source of truth, written by
  // ChannelSidebar, aggregated here for the guild rail.
  const [mentionState, setMentionState] = useState<MentionCountState>(EMPTY_MENTION_STATE)
  // Pending jump-to-mention request from a sidebar badge click.
  const [mentionJump, setMentionJump] = useState<{ channelId: string; messageId: string } | null>(null)

  const handleReturnToVoice = useCallback((guildId: string, channelId: string) => {
    setSelectedGuildId(guildId)
    setSelectedChannelId(channelId)
  }, [])

  const [isGuildModalOpen, setIsGuildModalOpen] = useState(false)
  const [isChannelModalOpen, setIsChannelModalOpen] = useState(false)
  const [createChannelDefaultType, setCreateChannelDefaultType] = useState<number>(0)
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [isServerSettingsModalOpen, setIsServerSettingsModalOpen] = useState(false)
  const [isUserSettingsModalOpen, setIsUserSettingsModalOpen] = useState(false)
  const [isEmailVerificationModalOpen, setIsEmailVerificationModalOpen] = useState(false)
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<Channel | null>(null)
  const [inviteFeedback, setInviteFeedback] = useState<{ message: string; isError?: boolean } | null>(null)
  const [verificationFeedback, setVerificationFeedback] = useState<{ message: string; isError?: boolean } | null>(null)

  // Handle direct verification link from email: /verify?token=... or ?token=... or ?verify_token=...
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    const token = urlParams.get('token') || urlParams.get('verify_token')
    if (!token) return

    verifyEmail({ token })
      .then(() => {
        setVerificationFeedback({ message: '🎉 Email verified successfully! Welcome to Kith.' })
        const newUrl = window.location.pathname
        window.history.replaceState({}, document.title, newUrl)
        setTimeout(() => setVerificationFeedback(null), 5000)
      })
      .catch((err) => {
        setVerificationFeedback({
          message: err?.message || 'Verification link is invalid or expired.',
          isError: true,
        })
        setTimeout(() => setVerificationFeedback(null), 6000)
      })
  }, [verifyEmail])

  // Automatically prompt verification once for unverified users upon first load
  useEffect(() => {
    if (user && user.email_verified === false) {
      const alreadyPrompted = sessionStorage.getItem('kith_seen_verify_prompt')
      if (!alreadyPrompted) {
        setIsEmailVerificationModalOpen(true)
        sessionStorage.setItem('kith_seen_verify_prompt', 'true')
      }
    }
  }, [user])

  const [userPresence, setUserPresence] = useState<'online' | 'idle' | 'dnd' | 'invisible'>(() => {
    try {
      const saved = localStorage.getItem('kith_user_presence')
      if (saved === 'online' || saved === 'idle' || saved === 'dnd' || saved === 'invisible') {
        return saved
      }
    } catch {}
    return 'online'
  })

  const handlePresenceChange = useCallback((status: 'online' | 'idle' | 'dnd' | 'invisible') => {
    setUserPresence(status)
    try {
      localStorage.setItem('kith_user_presence', status)
    } catch {}
    gatewayClient.sendStatusUpdate(status)
  }, [])

  // Keep presence in sync with gateway on connection and page load
  useEffect(() => {
    const unsub = gatewayClient.onReady(() => {
      gatewayClient.sendStatusUpdate(userPresence)
    })
    if (gatewayClient.getStatus() === 'ready') {
      gatewayClient.sendStatusUpdate(userPresence)
    }
    return unsub
  }, [userPresence])

  const refreshChannels = useCallback(async () => {
    if (!selectedGuildId) return
    try {
      const list = await api.getChannels(selectedGuildId)
      setChannels(list)
    } catch (err) {
      console.error('Failed to reload channels:', err)
    }
  }, [selectedGuildId])

  // Badge click on a channel row: switch to the channel and jump to the
  // first unread mention once history loads (consumed by ChatArea).
  // NOTE: hooks must stay above the early returns below (Rules of Hooks).
  const handleJumpToMention = useCallback((channelId: string, messageId: string) => {
    setSelectedChannelId(channelId)
    setMentionJump({ channelId, messageId })
  }, [])

  const handleMentionJumpConsumed = useCallback(() => {
    setMentionJump(null)
  }, [])

  // Per-guild outstanding mention totals for the server rail, derived from
  // the channel-keyed badge state.
  const guildMentionCounts = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const ch of channels) {
      const n = mentionState.counts[ch.id] ?? 0
      if (n > 0 && ch.guild_id) {
        totals[ch.guild_id] = (totals[ch.guild_id] ?? 0) + n
      }
    }
    return totals
  }, [channels, mentionState.counts])

  // Fetch guilds when user is authenticated
  useEffect(() => {
    if (!user || loading) return
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
  }, [user, loading])

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

  // Real-time guild updates (icon, banner, name changes) via WebSocket
  useEffect(() => {
    return subscribeToGuildUpdates((updatedGuild) => {
      setGuilds((prev) =>
        prev.map((g) => (g.id === updatedGuild.id ? { ...g, ...updatedGuild } : g))
      )
    })
  }, [subscribeToGuildUpdates])

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
      <div className="app-loading-screen">
        <div className="app-loading-logo-wrap">
          <img src="/assets/logo.png" alt="Kith" className="app-loading-logo" />
        </div>
        <div className="app-loading-content">
          <div className="app-loading-title">Loading Kith…</div>
          <div className="app-loading-bar">
            <div className="app-loading-bar-fill" />
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return <AuthView />
  }

  const currentGuild = guilds.find((g) => g.id === selectedGuildId) ?? null
  const currentChannel = channels.find((c) => c.id === selectedChannelId) ?? null

  const isFloatingPipVisible =
    Boolean(activeVoice) &&
    (selectedChannelId !== activeVoice?.channelId ||
      selectedGuildId !== activeVoice?.guildId ||
      !currentChannel ||
      Number(currentChannel.type) !== 2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <ConnectionBanner />
      <UnverifiedEmailBanner onOpenVerifyModal={() => setIsEmailVerificationModalOpen(true)} />
      <div className="app-container" style={{ flex: 1, minHeight: 0 }}>
      {verificationFeedback && (
        <div
          role="status"
          style={{
            position: 'fixed',
            top: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: verificationFeedback.isError ? '#da373c' : '#23a55a',
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
          {verificationFeedback.message}
        </div>
      )}
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
        isCreateModalOpen={isGuildModalOpen}
        guildMentionCounts={guildMentionCounts}
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
        mentionState={mentionState}
        setMentionState={setMentionState}
        onJumpToMention={handleJumpToMention}
        onOpenUserSettings={() => setIsUserSettingsModalOpen(true)}
        presenceStatus={userPresence}
        onStatusChange={handlePresenceChange}
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
          guilds={guilds}
          onSelectChannel={(id) => setSelectedChannelId(id)}
          mentionJump={mentionJump}
          onMentionJumpConsumed={handleMentionJumpConsumed}
        />
      )}

      {/* 240px Member Sidebar (right of chat). Keyed by guild so switching
          guilds remounts it with fresh state instead of hand-rolled resets. */}
      <MemberSidebar key={selectedGuildId ?? 'none'} guildId={selectedGuildId} guild={currentGuild} />

      {/* Floating Picture-in-Picture Voice Mini-Player (#128) */}
      {isFloatingPipVisible && (
        <VoicePipMiniPlayer
          currentGuild={currentGuild}
          channels={channels}
          onReturnToVoice={handleReturnToVoice}
        />
      )}

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
        onGuildUpdated={(updatedGuild) => {
          setGuilds((prev) =>
            prev.map((g) => (g.id === updatedGuild.id ? { ...g, ...updatedGuild } : g))
          )
        }}
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

      <UserSettingsModal
        isOpen={isUserSettingsModalOpen}
        onClose={() => setIsUserSettingsModalOpen(false)}
        user={user}
        presenceStatus={userPresence}
        onStatusChange={handlePresenceChange}
        onLogout={logout}
        onUserUpdated={updateUser}
        onOpenVerifyModal={() => setIsEmailVerificationModalOpen(true)}
      />

      <EmailVerificationModal
        isOpen={isEmailVerificationModalOpen}
        onClose={() => setIsEmailVerificationModalOpen(false)}
        email={user?.email}
        onVerified={() => {
          setVerificationFeedback({ message: '🎉 Email verified successfully!' })
          setTimeout(() => setVerificationFeedback(null), 4000)
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
