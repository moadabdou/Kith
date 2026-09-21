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
import { SfuClient } from '../lib/sfu-client'
import { getVideoInputDevices, onDeviceChange } from '../lib/video-devices'
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
  const [activeVoice, setActiveVoice] = useState<ActiveVoiceConnection | null>(() => {
    try {
      const saved = sessionStorage.getItem('kith_active_voice')
      if (saved) return JSON.parse(saved)
    } catch {}
    return null
  })
  const [connectionStatus, setConnectionStatus] = useState<VoiceConnectionStatus>(() => {
    try {
      const saved = sessionStorage.getItem('kith_active_voice')
      if (saved) return 'connecting'
    } catch {}
    return 'disconnected'
  })
  const [selfMute, setSelfMute] = useState(false)
  const [selfDeaf, setSelfDeaf] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set())
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [selectedCameraId, setSelectedCameraIdState] = useState<string | null>(null)
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null)
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Map<string, MediaStream>>(new Map())
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null)
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Map<string, MediaStream>>(new Map())

  // Ref to track state in callbacks without stale closures
  const selfMuteRef = useRef(selfMute)
  const selfDeafRef = useRef(selfDeaf)
  const isCameraOnRef = useRef(isCameraOn)
  const selectedCameraIdRef = useRef(selectedCameraId)
  const isScreenSharingRef = useRef(isScreenSharing)
  const activeVoiceRef = useRef(activeVoice)
  const connectionStatusRef = useRef(connectionStatus)
  const sfuClientRef = useRef<SfuClient | null>(null)

  useEffect(() => {
    selfMuteRef.current = selfMute
    selfDeafRef.current = selfDeaf
    isCameraOnRef.current = isCameraOn
    selectedCameraIdRef.current = selectedCameraId
    isScreenSharingRef.current = isScreenSharing
    activeVoiceRef.current = activeVoice
    connectionStatusRef.current = connectionStatus
  }, [selfMute, selfDeaf, isCameraOn, selectedCameraId, isScreenSharing, activeVoice, connectionStatus])

  // Video devices enumeration and devicechange listener
  useEffect(() => {
    let mounted = true
    getVideoInputDevices().then((devices) => {
      if (mounted) setVideoDevices(devices)
    })
    const unsubscribe = onDeviceChange((devices) => {
      if (mounted) setVideoDevices(devices)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  // Cleanup SFU client on unmount (graceful close without explicit leave message to preserve grace period on reload)
  useEffect(() => {
    return () => {
      if (sfuClientRef.current) {
        sfuClientRef.current.disconnect(false)
        sfuClientRef.current = null
      }
    }
  }, [])

  // 1. Initial hydration via READY dispatch
  useEffect(() => {
    return subscribeToReady((data) => {
      if (!data || !Array.isArray(data.guilds)) return

      const currentUserId = user?.id || data.user?.id

      setVoiceStates((prev) => hydrateGuildVoiceStates(prev, data.guilds))

      // Find if current user has an active voice channel in any guild from READY
      let myConn: { guildId: string; channelId: string; selfMute: boolean; selfDeaf: boolean } | null = null

      if (currentUserId) {
        for (const guild of data.guilds) {
          if (!guild || !guild.id || !guild.voice_states) continue
          const gid = String(guild.id)
          const states = Array.isArray(guild.voice_states)
            ? guild.voice_states
            : Object.values(guild.voice_states)

          for (const vs of states as any[]) {
            if (vs && String(vs.user_id) === String(currentUserId) && vs.channel_id) {
              myConn = {
                guildId: gid,
                channelId: vs.channel_id,
                selfMute: !!vs.self_mute,
                selfDeaf: !!vs.self_deaf,
              }
              break
            }
          }
          if (myConn) break
        }
      }

      if (myConn) {
        const conn = { guildId: myConn.guildId, channelId: myConn.channelId }
        setActiveVoice(conn)
        activeVoiceRef.current = conn
        try {
          sessionStorage.setItem('kith_active_voice', JSON.stringify(conn))
        } catch {}
        setConnectionStatus('connecting')
        setSelfMute(myConn.selfMute)
        setSelfDeaf(myConn.selfDeaf)
        console.log('[VoiceContext] Restoring voice on READY:', myConn)
        sendVoiceStateUpdate(myConn.guildId, myConn.channelId, myConn.selfMute, myConn.selfDeaf)
      } else {
        try {
          sessionStorage.removeItem('kith_active_voice')
        } catch {}
        if (activeVoiceRef.current) {
          activeVoiceRef.current = null
          setActiveVoice(null)
          setConnectionStatus('disconnected')
        }
      }
    })
  }, [subscribeToReady, user, sendVoiceStateUpdate])

  // 2. Gateway VOICE_STATE_UPDATE dispatch fan-out
  useEffect(() => {
    return subscribeToVoiceStateUpdates((payload) => {
      setVoiceStates((prev) => applyVoiceStateUpdate(prev, payload))

      if (!payload.channel_id) {
        setSpeakingUsers((prev) => {
          if (prev.has(payload.user_id)) {
            const next = new Set(prev)
            next.delete(payload.user_id)
            return next
          }
          return prev
        })
      }

      if (user && payload.user_id === user.id) {
        if (!payload.channel_id) {
          try {
            sessionStorage.removeItem('kith_active_voice')
          } catch {}
          if (sfuClientRef.current) {
            sfuClientRef.current.disconnect(false)
            sfuClientRef.current = null
          }
          activeVoiceRef.current = null
          setActiveVoice(null)
          setConnectionStatus('disconnected')
          setIsSpeaking(false)
          setIsCameraOn(false)
          setLocalVideoStream(null)
          setRemoteVideoStreams(new Map())
        } else {
          const conn = { guildId: payload.guild_id, channelId: payload.channel_id }
          setActiveVoice(conn)
          activeVoiceRef.current = conn
          try {
            sessionStorage.setItem('kith_active_voice', JSON.stringify(conn))
          } catch {}
          setSelfMute(payload.self_mute)
          setSelfDeaf(payload.self_deaf)
        }
      }
    })
  }, [subscribeToVoiceStateUpdates, user])

  // 3. Gateway VOICE_SERVER_UPDATE dispatch confirmation & SFU connection
  useEffect(() => {
    return subscribeToVoiceServerUpdates((payload) => {
      console.log('[VoiceContext] Received VOICE_SERVER_UPDATE:', payload)

      // Confirm active voice state synchronously
      const isSameChannel =
        activeVoiceRef.current?.guildId === payload.guild_id &&
        activeVoiceRef.current?.channelId === payload.channel_id

      setActiveVoice({ guildId: payload.guild_id, channelId: payload.channel_id })
      activeVoiceRef.current = { guildId: payload.guild_id, channelId: payload.channel_id }

      // If already connected or connecting to this channel with an active SFU client, do not disconnect
      if (
        sfuClientRef.current &&
        isSameChannel &&
        (connectionStatusRef.current === 'connected' || connectionStatusRef.current === 'connecting')
      ) {
        return
      }

      // Disconnect existing client if switching channels or reconnecting
      if (sfuClientRef.current) {
        sfuClientRef.current.disconnect()
        sfuClientRef.current = null
      }

      setConnectionStatus('connecting')

      const client = new SfuClient({
        endpoint: payload.endpoint,
        token: payload.token,
        channelId: payload.channel_id,
        guildId: payload.guild_id,
        onConnectionStateChange: (state) => {
          if (state === 'connected') {
            setConnectionStatus('connected')
          } else if (state === 'connecting') {
            setConnectionStatus('connecting')
          } else if (state === 'disconnected' || state === 'failed') {
            setConnectionStatus('disconnected')
            // The PC is gone: receiver tracks are dead. Drop remote media
            // state so a rejoin starts clean instead of rendering ghosts of
            // the previous session. (Transient blips never reach here — the
            // client debounces them internally.)
            setRemoteVideoStreams(new Map())
            setRemoteScreenStreams(new Map())
          }
        },
        onSpeakingChange: (speakingUid, speaking) => {
          setSpeakingUsers((prev) => {
            const next = new Set(prev)
            if (speaking) {
              next.add(speakingUid)
            } else {
              next.delete(speakingUid)
            }
            return next
          })

          if (user && speakingUid === user.id) {
            setIsSpeaking(speaking)
          }
        },
        userId: user?.id,
        onLocalVideoChange: (stream) => {
          setLocalVideoStream(stream)
          setIsCameraOn(!!stream)
        },
        onRemoteVideoChange: (userId, stream) => {
          setRemoteVideoStreams((prev) => {
            const next = new Map(prev)
            if (stream) {
              next.set(userId, stream)
            } else {
              next.delete(userId)
            }
            return next
          })
        },
        onLocalScreenChange: (stream) => {
          setLocalScreenStream(stream)
          setIsScreenSharing(!!stream)
        },
        onRemoteScreenShareChange: (userId, stream) => {
          setRemoteScreenStreams((prev) => {
            const next = new Map(prev)
            if (stream) {
              next.set(userId, stream)
            } else {
              next.delete(userId)
            }
            return next
          })
        },
        onError: (err) => {
          console.error('[VoiceContext] SFU error:', err)
        },
      })

      client.setMute(selfMuteRef.current)
      client.setDeaf(selfDeafRef.current)

      sfuClientRef.current = client
      client.connect().catch((err) => {
        console.error('[VoiceContext] Failed to connect to SFU:', err)
        setConnectionStatus('disconnected')
      })
    })
  }, [subscribeToVoiceServerUpdates, user])

  // 4. On Session Reset (Op 9), clean active state if disconnected
  useEffect(() => {
    return onSessionReset(() => {
      console.log('[VoiceContext] session reset received — resetting voice connection')
      try {
        sessionStorage.removeItem('kith_active_voice')
      } catch {}
      if (sfuClientRef.current) {
        sfuClientRef.current.disconnect(false)
        sfuClientRef.current = null
      }
      activeVoiceRef.current = null
      setActiveVoice(null)
      setConnectionStatus('disconnected')
      setIsSpeaking(false)
      setSpeakingUsers(new Set())
      setIsCameraOn(false)
      setLocalVideoStream(null)
      setRemoteVideoStreams(new Map())
      setIsScreenSharing(false)
      setLocalScreenStream(null)
      setRemoteScreenStreams(new Map())
    })
  }, [onSessionReset])

  // 5. Actions
  const joinVoice = useCallback(
    (guildId: string, channelId: string) => {
      if (
        activeVoiceRef.current?.guildId === guildId &&
        activeVoiceRef.current?.channelId === channelId &&
        sfuClientRef.current?.isConnected()
      ) {
        return
      }

      const conn = { guildId, channelId }
      activeVoiceRef.current = conn
      setActiveVoice(conn)
      try {
        sessionStorage.setItem('kith_active_voice', JSON.stringify(conn))
      } catch {}
      setConnectionStatus('connecting')
      sendVoiceStateUpdate(guildId, channelId, selfMuteRef.current, selfDeafRef.current)
    },
    [sendVoiceStateUpdate]
  )

  const leaveVoice = useCallback(() => {
    try {
      sessionStorage.removeItem('kith_active_voice')
    } catch {}

    if (sfuClientRef.current) {
      sfuClientRef.current.disconnect(true)
      sfuClientRef.current = null
    }

    if (activeVoiceRef.current) {
      const gid = activeVoiceRef.current.guildId
      activeVoiceRef.current = null
      sendVoiceStateUpdate(
        gid,
        null,
        selfMuteRef.current,
        selfDeafRef.current
      )
    }
    setActiveVoice(null)
    setConnectionStatus('disconnected')
    setIsSpeaking(false)
    setIsCameraOn(false)
    setLocalVideoStream(null)
    setRemoteVideoStreams(new Map())
    setIsScreenSharing(false)
    setLocalScreenStream(null)
    setRemoteScreenStreams(new Map())
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

    if (sfuClientRef.current) {
      sfuClientRef.current.setMute(nextMute)
    }

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

    if (sfuClientRef.current) {
      sfuClientRef.current.setDeaf(nextDeaf)
      sfuClientRef.current.setMute(nextMute)
    }

    if (activeVoiceRef.current) {
      sendVoiceStateUpdate(
        activeVoiceRef.current.guildId,
        activeVoiceRef.current.channelId,
        nextMute,
        nextDeaf
      )
    }
  }, [sendVoiceStateUpdate])

  const toggleCamera = useCallback(async () => {
    if (!sfuClientRef.current) return
    const next = !isCameraOnRef.current
    try {
      const stream = await sfuClientRef.current.setCameraEnabled(
        next,
        selectedCameraIdRef.current || undefined
      )
      setIsCameraOn(next)
      setLocalVideoStream(stream)
    } catch (err) {
      console.error('[VoiceContext] Failed to toggle camera:', err)
    }
  }, [])

  const setSelectedCameraId = useCallback(async (deviceId: string) => {
    setSelectedCameraIdState(deviceId)
    selectedCameraIdRef.current = deviceId
    if (sfuClientRef.current && isCameraOnRef.current) {
      try {
        await sfuClientRef.current.setCameraDevice(deviceId)
      } catch (err) {
        console.error('[VoiceContext] Failed to switch camera device:', err)
      }
    }
  }, [])

  const toggleScreenShare = useCallback(async () => {
    if (!sfuClientRef.current) return
    const next = !isScreenSharingRef.current
    try {
      if (next) {
        const stream = await sfuClientRef.current.startScreenShare()
        setIsScreenSharing(true)
        setLocalScreenStream(stream)
      } else {
        await sfuClientRef.current.stopScreenShare()
        setIsScreenSharing(false)
        setLocalScreenStream(null)
      }
    } catch (err: any) {
      if (err?.name !== 'NotAllowedError') {
        console.error('[VoiceContext] Failed to toggle screen share:', err)
      }
      // Sync from the client instead of assuming off: a failed stop may have
      // rolled back to a still-live share.
      const stillSharing = sfuClientRef.current?.isScreenSharing() ?? false
      setIsScreenSharing(stillSharing)
      setLocalScreenStream(stillSharing ? sfuClientRef.current?.getLocalScreenStream() ?? null : null)
    }
  }, [])

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
        isCameraOn,
        selectedCameraId,
        videoDevices,
        localVideoStream,
        remoteVideoStreams,
        isScreenSharing,
        localScreenStream,
        remoteScreenStreams,
        joinVoice,
        leaveVoice,
        toggleMute,
        toggleDeaf,
        toggleCamera,
        setSelectedCameraId,
        toggleScreenShare,
        getChannelVoiceStates: getChannelVoiceStatesCb,
      }}
    >
      {children}
    </VoiceContext.Provider>
  )
}
