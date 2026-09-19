import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './useAuth'
import { useGateway } from '../gateway/useGateway'
import {
  applyVoiceStateUpdate,
  hydrateGuildVoiceStates,
  getUsersInVoiceChannel,
  type GuildVoiceStates,
} from '../lib/voice'
import {
  VoiceContext,
  type ActiveVoiceConnection,
  type VoiceConnectionStatus,
} from './voice-context-def'

export {
  type ActiveVoiceConnection,
  type VoiceConnectionStatus,
  type VoiceContextValue,
} from './voice-context-def'

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const {
    sendVoiceStateUpdate,
    subscribeToVoiceStateUpdates,
    subscribeToVoiceServerUpdates,
    subscribeToReady,
    onSessionReset,
  } = useGateway()

  const [voiceStates, setVoiceStates] = useState<GuildVoiceStates>({})
  const [activeVoice, setActiveVoice] = useState<ActiveVoiceConnection | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<VoiceConnectionStatus>('disconnected')
  const [selfMute, setSelfMute] = useState(false)
  const [selfDeaf, setSelfDeaf] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set())

  // Ref to track selfMute and selfDeaf in callbacks without stale closures
  const selfMuteRef = useRef(selfMute)
  const selfDeafRef = useRef(selfDeaf)
  const activeVoiceRef = useRef(activeVoice)

  useEffect(() => {
    selfMuteRef.current = selfMute
    selfDeafRef.current = selfDeaf
    activeVoiceRef.current = activeVoice
  }, [selfMute, selfDeaf, activeVoice])

  // 1. Initial hydration via READY dispatch
  useEffect(() => {
    return subscribeToReady((data) => {
      if (!data || !Array.isArray(data.guilds)) return

      setVoiceStates((prev) => {
        const next = hydrateGuildVoiceStates(prev, data.guilds)

        // Check if current user is already in a voice channel
        if (user) {
          for (const [gid, userMap] of Object.entries(next)) {
            const myVs = userMap[user.id]
            if (myVs && myVs.channel_id) {
              setActiveVoice({ guildId: gid, channelId: myVs.channel_id })
              setConnectionStatus('connected')
              setSelfMute(myVs.self_mute)
              setSelfDeaf(myVs.self_deaf)
              break
            }
          }
        }

        return next
      })
    })
  }, [subscribeToReady, user])

  // 2. Gateway VOICE_STATE_UPDATE dispatch fan-out
  useEffect(() => {
    return subscribeToVoiceStateUpdates((payload) => {
      setVoiceStates((prev) => applyVoiceStateUpdate(prev, payload))

      if (user && payload.user_id === user.id) {
        if (!payload.channel_id) {
          setActiveVoice(null)
          setConnectionStatus('disconnected')
        } else {
          setActiveVoice({ guildId: payload.guild_id, channelId: payload.channel_id })
          setConnectionStatus('connected')
          setSelfMute(payload.self_mute)
          setSelfDeaf(payload.self_deaf)
        }
      }
    })
  }, [subscribeToVoiceStateUpdates, user])

  // 3. Gateway VOICE_SERVER_UPDATE dispatch confirmation
  useEffect(() => {
    return subscribeToVoiceServerUpdates((payload) => {
      if (
        activeVoiceRef.current &&
        activeVoiceRef.current.guildId === payload.guild_id &&
        activeVoiceRef.current.channelId === payload.channel_id
      ) {
        setConnectionStatus('connected')
      }
    })
  }, [subscribeToVoiceServerUpdates])

  // 4. On Session Reset (Op 9), clean active state if disconnected
  useEffect(() => {
    return onSessionReset(() => {
      console.log('[VoiceContext] session reset received — resetting voice connection')
      setActiveVoice(null)
      setConnectionStatus('disconnected')
    })
  }, [onSessionReset])

  // 5. Actions
  const joinVoice = useCallback(
    (guildId: string, channelId: string) => {
      if (
        activeVoiceRef.current?.guildId === guildId &&
        activeVoiceRef.current?.channelId === channelId
      ) {
        return
      }

      setActiveVoice({ guildId, channelId })
      setConnectionStatus('connecting')
      sendVoiceStateUpdate(guildId, channelId, selfMuteRef.current, selfDeafRef.current)
    },
    [sendVoiceStateUpdate]
  )

  const leaveVoice = useCallback(() => {
    if (activeVoiceRef.current) {
      sendVoiceStateUpdate(
        activeVoiceRef.current.guildId,
        null,
        selfMuteRef.current,
        selfDeafRef.current
      )
    }
    setActiveVoice(null)
    setConnectionStatus('disconnected')
    setIsSpeaking(false)
    if (user) {
      setSpeakingUsers((prev) => {
        const next = new Set(prev)
        next.delete(user.id)
        return next
      })
    }
  }, [sendVoiceStateUpdate, user])

  const toggleMute = useCallback(() => {
    const nextMute = !selfMuteRef.current
    setSelfMute(nextMute)

    if (activeVoiceRef.current) {
      sendVoiceStateUpdate(
        activeVoiceRef.current.guildId,
        activeVoiceRef.current.channelId,
        nextMute,
        selfDeafRef.current
      )
    }
  }, [sendVoiceStateUpdate])

  const toggleDeaf = useCallback(() => {
    const nextDeaf = !selfDeafRef.current
    const nextMute = nextDeaf ? true : selfMuteRef.current

    setSelfDeaf(nextDeaf)
    setSelfMute(nextMute)

    if (activeVoiceRef.current) {
      sendVoiceStateUpdate(
        activeVoiceRef.current.guildId,
        activeVoiceRef.current.channelId,
        nextMute,
        nextDeaf
      )
    }
  }, [sendVoiceStateUpdate])

  // 6. Speaking detection placeholder (active voice signaling to be integrated later)
  // No getUserMedia or Web Audio API calls to keep connection smooth, lightweight, and non-blocking.

  const getChannelVoiceStatesCb = useCallback(
    (guildId: string, channelId: string) => {
      return getUsersInVoiceChannel(voiceStates, guildId, channelId)
    },
    [voiceStates]
  )

  return (
    <VoiceContext.Provider
      value={{
        voiceStates,
        activeVoice,
        connectionStatus,
        selfMute,
        selfDeaf,
        isSpeaking,
        speakingUsers,
        joinVoice,
        leaveVoice,
        toggleMute,
        toggleDeaf,
        getChannelVoiceStates: getChannelVoiceStatesCb,
      }}
    >
      {children}
    </VoiceContext.Provider>
  )
}
