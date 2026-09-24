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
import { SfuClient, type InboundVideoStats } from '../lib/sfu-client'
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

// ── Voice intent (Step 1, issue #87 Tier 2) ──────────────────────────────
// The gateway's guild actor owns voice state in RAM only, so after an actor
// restart the roster is empty until clients re-speak. This module keeps a
// local copy of the user's *acknowledged* voice intent (last successful
// Op 4 join/move) both in-memory (voiceIntentRef, works always) and in
// sessionStorage (survives reloads; tab-scoped). On SESSION_RESET the
// transport is torn down but the intent is preserved; the next READY either
// adopts the snapshot (authoritative) or volunteers the intent via Op 4.
const VOICE_INTENT_STORAGE_KEY = 'kith_active_voice'
// Sanity cap: a tab suspended for hours shouldn't auto-rejoin a call
// everyone else left. Fresh intents always fall well under this.
const VOICE_INTENT_MAX_AGE_MS = 10 * 60 * 1000

interface VoiceIntent {
  guildId: string
  channelId: string
  selfMute: boolean
  selfDeaf: boolean
  ts: number
}

function isIntentFresh(intent: VoiceIntent | null | undefined): intent is VoiceIntent {
  return !!intent && typeof intent.ts === 'number' && Date.now() - intent.ts <= VOICE_INTENT_MAX_AGE_MS
}

function readStoredIntent(): VoiceIntent | null {
  try {
    const raw = sessionStorage.getItem(VOICE_INTENT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.guildId !== 'string' || typeof parsed.channelId !== 'string') return null
    const intent: VoiceIntent = {
      guildId: parsed.guildId,
      channelId: parsed.channelId,
      selfMute: !!parsed.selfMute,
      selfDeaf: !!parsed.selfDeaf,
      // Migrate-on-read: intents stored before timestamps existed are
      // granted a fresh window from first read after upgrade.
      ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
    }
    if (!isIntentFresh(intent)) {
      try {
        sessionStorage.removeItem(VOICE_INTENT_STORAGE_KEY)
      } catch {}
      return null
    }
    return intent
  } catch {
    // sessionStorage unavailable (SSR/tests) — in-memory ref covers it.
    return null
  }
}

function writeStoredIntent(intent: VoiceIntent) {
  try {
    sessionStorage.setItem(VOICE_INTENT_STORAGE_KEY, JSON.stringify(intent))
  } catch {}
}

function clearStoredIntent() {
  try {
    sessionStorage.removeItem(VOICE_INTENT_STORAGE_KEY)
  } catch {}
}

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
    const saved = readStoredIntent()
    if (saved) return { guildId: saved.guildId, channelId: saved.channelId }
    return null
  })
  const [connectionStatus, setConnectionStatus] = useState<VoiceConnectionStatus>(() => {
    const saved = readStoredIntent()
    if (saved) return 'connecting'
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
  const [videoStats, setVideoStats] = useState<InboundVideoStats>(new Map())

  // SFU failover attempts per channel session (Phase 7d Step 3c). On
  // `giveUp()` the client re-sends Op 4 for its current channel — a hint
  // ("I need fresh voice server info"), never a verdict. The gateway
  // re-answers from the live list; a dead SFU is excluded out-of-band.
  // Capped so one deaf client can't Op 4-storm its guild; reset on every
  // successful connect AND every fresh VOICE_SERVER_UPDATE (new transport
  // means the previous failure is no longer evidence).
  // Ref to track state in callbacks without stale closures
  const selfMuteRef = useRef(selfMute)
  const selfDeafRef = useRef(selfDeaf)
  const isCameraOnRef = useRef(isCameraOn)
  const selectedCameraIdRef = useRef(selectedCameraId)
  const isScreenSharingRef = useRef(isScreenSharing)
  const activeVoiceRef = useRef(activeVoice)
  const connectionStatusRef = useRef(connectionStatus)
  // Last volunteered voice intent (Tier 2 recovery). Kept in a ref alongside
  // sessionStorage: the ref works when storage is unavailable (SSR/tests)
  // and is the synchronous source of truth inside callbacks.
  const voiceIntentRef = useRef<VoiceIntent | null>(readStoredIntent())
  const sfuClientRef = useRef<SfuClient | null>(null)
  // Latest Op 4 sender, for use inside SfuClient callbacks (which outlive
  // any single render's closure).
  const sendVoiceStateUpdateRef = useRef(sendVoiceStateUpdate)
  useEffect(() => {
    sendVoiceStateUpdateRef.current = sendVoiceStateUpdate
  }, [sendVoiceStateUpdate])
  // Last VOICE_SERVER_UPDATE transport we built a session for. The gateway
  // may re-emit server updates for the same channel (token refresh, state
  // re-push) — rebuilding the SfuClient on each one swaps every remote
  // MediaStream identity and aborts in-flight <video> playback.
  const lastVoiceServerRef = useRef<{ guildId: string; channelId: string; endpoint: string } | null>(null)

  // SFU failover attempts per channel session (Phase 7d Step 3c). On
  // `giveUp()` the client re-sends Op 4 for its current channel — a hint
  // ("I need fresh voice server info"), never a verdict. The gateway
  // re-answers from the live list; a dead SFU is excluded out-of-band.
  // Capped so one deaf client can't Op 4-storm its guild; reset on every
  // successful connect AND every fresh VOICE_SERVER_UPDATE (new transport
  // means the previous failure is no longer evidence).
  const MAX_SFU_FAILOVER_ATTEMPTS = 5
  const sfuFailoverAttemptsRef = useRef(0)

  // Null-endpoint park (Phase 7d Step 4b): the gateway pushes endpoint=null
  // when our SFU dies ("tear down, don't reconnect yet"), followed by a
  // fresh allocation. While parked we ignore media-failure solicits (the
  // reallocation is already coming — an Op 4 now would just get the same
  // answer) and burn no failover budget. If the reallocation never arrives
  // within the window, surface disconnected and keep the Tier 2 intent (the
  // user didn't leave; the next READY volunteers it).
  const SFU_REALLOCATION_TIMEOUT_MS = 15_000
  const sfuParkedRef = useRef<{ guildId: string; channelId: string } | null>(null)
  const sfuParkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSfuPark = () => {
    sfuParkedRef.current = null
    if (sfuParkTimerRef.current) {
      clearTimeout(sfuParkTimerRef.current)
      sfuParkTimerRef.current = null
    }
  }

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
      clearSfuPark()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Records the user's voice intent (join/move) in-memory + storage so a
  // later SESSION_RESET / READY cycle can re-volunteer it. Called only for
  // locally initiated joins, moves, and mute/deaf updates — never for
  // leaves (leaveVoice clears instead) and never for inbound dispatches.
  const storeVoiceIntent = (guildId: string, channelId: string) => {
    const intent: VoiceIntent = {
      guildId,
      channelId,
      selfMute: selfMuteRef.current,
      selfDeaf: selfDeafRef.current,
      ts: Date.now(),
    }
    voiceIntentRef.current = intent
    writeStoredIntent(intent)
  }

  const dropVoiceIntent = () => {
    voiceIntentRef.current = null
    clearStoredIntent()
  }

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
        // Snapshot hit: the gateway knows us — authoritative. Adopt it and
        // record it as our intent going forward.
        const conn = { guildId: myConn.guildId, channelId: myConn.channelId }
        setActiveVoice(conn)
        activeVoiceRef.current = conn
        storeVoiceIntent(myConn.guildId, myConn.channelId)
        setConnectionStatus('connecting')
        setSelfMute(myConn.selfMute)
        setSelfDeaf(myConn.selfDeaf)
        console.log('[VoiceContext] Restoring voice on READY:', myConn)
        sendVoiceStateUpdate(myConn.guildId, myConn.channelId, myConn.selfMute, myConn.selfDeaf)
      } else {
        // Snapshot miss: after an actor restart the gateway forgot us. If we
        // still hold a fresh local intent (preserved across SESSION_RESET),
        // volunteer it — the actor treats it as a fresh join. An explicit
        // leave clears the intent, so there is nothing to resurrect then.
        const intent = voiceIntentRef.current ?? readStoredIntent()
        if (isIntentFresh(intent)) {
          const conn = { guildId: intent.guildId, channelId: intent.channelId }
          setActiveVoice(conn)
          activeVoiceRef.current = conn
          setConnectionStatus('connecting')
          setSelfMute(intent.selfMute)
          setSelfDeaf(intent.selfDeaf)
          console.log('[VoiceContext] Volunteering voice intent on READY:', intent)
          sendVoiceStateUpdate(intent.guildId, intent.channelId, intent.selfMute, intent.selfDeaf)
        } else {
          dropVoiceIntent()
          if (activeVoiceRef.current) {
            activeVoiceRef.current = null
            setActiveVoice(null)
            setConnectionStatus('disconnected')
          }
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
          // Authoritative leave (server-initiated or our own echoed back):
          // drop the intent so a later READY cannot resurrect it.
          dropVoiceIntent()
          if (sfuClientRef.current) {
            sfuClientRef.current.disconnect(false)
            sfuClientRef.current = null
          }
          lastVoiceServerRef.current = null
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
          // Inbound echo of our own join — not a new local intent, but keep
          // the stored copy aligned (mute/deaf may have been set server-side).
          storeVoiceIntent(payload.guild_id, payload.channel_id)
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

      // Null endpoint (Phase 7d Step 4): our SFU died and is being
      // reallocated. Tear down the transport, park, and wait for the fresh
      // allocation — do NOT reconnect, re-request, or burn failover budget.
      //
      // Stale-null guard: a null names its `dead_endpoint`. If we already
      // failed over via the confirm fast lane, our live transport is on a
      // DIFFERENT endpoint than the one that just died — the null is stale
      // (it raced our re-request) and must NOT tear down a healthy session.
      // A null with no dead_endpoint (legacy) always parks.
      if (payload.endpoint == null) {
        const liveEndpoint = lastVoiceServerRef.current?.endpoint
        const deadEndpoint =
          typeof payload.dead_endpoint === 'string' ? payload.dead_endpoint : null
        if (deadEndpoint && liveEndpoint && liveEndpoint !== deadEndpoint) {
          console.log(
            `[VoiceContext] Ignoring stale null for ${deadEndpoint} (live on ${liveEndpoint})`
          )
          return
        }
        console.log(
          `[VoiceContext] SFU reallocation in progress for ${payload.channel_id}, parking`
        )
        if (sfuClientRef.current) {
          sfuClientRef.current.disconnect(false)
          sfuClientRef.current = null
        }
        // Clear the transport record so the coming allocation always
        // rebuilds (even if it hashes back onto the same endpoint in a
        // fail-closed single-node pool — the old PC is gone either way).
        lastVoiceServerRef.current = null
        sfuParkedRef.current = { guildId: payload.guild_id, channelId: payload.channel_id }
        setActiveVoice({ guildId: payload.guild_id, channelId: payload.channel_id })
        activeVoiceRef.current = { guildId: payload.guild_id, channelId: payload.channel_id }
        setConnectionStatus('connecting')
        setRemoteVideoStreams(new Map())
        setRemoteScreenStreams(new Map())
        setVideoStats(new Map())
        if (sfuParkTimerRef.current) clearTimeout(sfuParkTimerRef.current)
        sfuParkTimerRef.current = setTimeout(() => {
          sfuParkTimerRef.current = null
          // Still parked: the reallocation never arrived (gateway wedged).
          // Surface disconnected but KEEP the Tier 2 intent — the user
          // didn't leave, and the next READY volunteers it.
          if (sfuParkedRef.current) {
            console.warn('[VoiceContext] SFU reallocation timed out, surfacing disconnected')
            sfuParkedRef.current = null
            setConnectionStatus('disconnected')
          }
        }, SFU_REALLOCATION_TIMEOUT_MS)
        return
      }

      // Fresh (re)allocation: leave the park. This also covers the normal
      // join path (never parked — clearSfuPark is a no-op there).
      clearSfuPark()

      // Confirm active voice state synchronously
      const isSameChannel =
        activeVoiceRef.current?.guildId === payload.guild_id &&
        activeVoiceRef.current?.channelId === payload.channel_id

      setActiveVoice({ guildId: payload.guild_id, channelId: payload.channel_id })
      activeVoiceRef.current = { guildId: payload.guild_id, channelId: payload.channel_id }

      // Dedupe: the gateway may re-emit the same server update (token
      // refresh, state re-push). Rebuilding the SfuClient on a duplicate
      // tears down a healthy session for nothing — every remote MediaStream
      // gets a new identity and in-flight <video> play() aborts. Only
      // rebuild when the transport actually changed or the session died.
      const last = lastVoiceServerRef.current
      const isDuplicateTransport =
        !!last &&
        last.guildId === payload.guild_id &&
        last.channelId === payload.channel_id &&
        last.endpoint === payload.endpoint
      if (
        sfuClientRef.current &&
        isSameChannel &&
        isDuplicateTransport &&
        connectionStatusRef.current !== 'disconnected'
      ) {
        return
      }

      // Disconnect existing client if switching channels or reconnecting
      if (sfuClientRef.current) {
        sfuClientRef.current.disconnect()
        sfuClientRef.current = null
      }

      lastVoiceServerRef.current = {
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        endpoint: payload.endpoint,
      }

      // New transport offered: any previous media failure is no longer
      // evidence against THIS endpoint. Reset the failover budget so a
      // fresh allocation gets its full retry allowance.
      sfuFailoverAttemptsRef.current = 0

      setConnectionStatus('connecting')

      const client = new SfuClient({
        endpoint: payload.endpoint,
        token: payload.token,
        channelId: payload.channel_id,
        guildId: payload.guild_id,
        onConnectionStateChange: (state) => {
          if (state === 'connected') {
            // Fresh media path: previous failures are no longer evidence.
            sfuFailoverAttemptsRef.current = 0
            setConnectionStatus('connected')
          } else if (state === 'connecting') {
            setConnectionStatus('connecting')
          } else if (state === 'failed') {
            // Parked for reallocation (Step 4): the fresh endpoint is
            // already coming — ignore media failures, burn no budget.
            if (sfuParkedRef.current) {
              return
            }
            // Media path dead (SfuClient exhausted ICE restarts). Solicit a
            // fresh VOICE_SERVER_UPDATE via Op 4 — the gateway answers from
            // the live SFU list. Capped: a client that is deaf for its own
            // reasons must surface `failed`, not loop forever.
            setConnectionStatus('connecting')
            setRemoteVideoStreams(new Map())
            setRemoteScreenStreams(new Map())
            setVideoStats(new Map())
            const active = activeVoiceRef.current
            if (active && sfuFailoverAttemptsRef.current < MAX_SFU_FAILOVER_ATTEMPTS) {
              sfuFailoverAttemptsRef.current += 1
              console.log(
                `[VoiceContext] SFU failed (attempt ${sfuFailoverAttemptsRef.current}/${MAX_SFU_FAILOVER_ATTEMPTS}), re-requesting voice server for ${active.channelId}`
              )
              sendVoiceStateUpdateRef.current?.(
                active.guildId,
                active.channelId,
                selfMuteRef.current,
                selfDeafRef.current
              )
            } else {
              console.warn('[VoiceContext] SFU failover attempts exhausted, surfacing failed')
              setConnectionStatus('disconnected')
            }
          } else if (state === 'disconnected') {
            setConnectionStatus('disconnected')
            // The PC is gone: receiver tracks are dead. Drop remote media
            // state so a rejoin starts clean instead of rendering ghosts of
            // the previous session. (Transient blips never reach here — the
            // client debounces them internally.)
            setRemoteVideoStreams(new Map())
            setRemoteScreenStreams(new Map())
            setVideoStats(new Map())
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
        onStatsUpdate: (stats) => {
          setVideoStats(new Map(stats))
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

  // 4. On Session Reset (Op 9): the gateway session is dead, so the SFU
  // transport built on its VOICE_SERVER_UPDATE is stale — tear it down.
  // But PRESERVE the voice intent (Tier 2): the fresh READY that follows
  // either adopts the snapshot or volunteers this intent via Op 4.
  // A pending reallocation park is meaningless across a session reset (the
  // gateway that promised it forgot us) — drop it; READY re-drives.
  useEffect(() => {
    return onSessionReset(() => {
      console.log('[VoiceContext] session reset received — parking voice, preserving intent')
      if (sfuClientRef.current) {
        sfuClientRef.current.disconnect(false)
        sfuClientRef.current = null
      }
      clearSfuPark()
      lastVoiceServerRef.current = null
      // Park, don't wipe: activeVoice + intent stay so READY can restore.
      // Re-sync the stored intent's timestamp — the reset itself is proof
      // the user was live just now, so the volunteer window restarts here.
      // With no intent (explicit leave earlier) there is nothing to park
      // for — stay disconnected.
      const intent = voiceIntentRef.current
      if (intent && activeVoiceRef.current) {
        const refreshed: VoiceIntent = { ...intent, ts: Date.now() }
        voiceIntentRef.current = refreshed
        writeStoredIntent(refreshed)
        setConnectionStatus('connecting')
      } else {
        activeVoiceRef.current = null
        setActiveVoice(null)
        setConnectionStatus('disconnected')
      }
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
      storeVoiceIntent(guildId, channelId)
      // Fresh local intent: previous failover budget is irrelevant.
      sfuFailoverAttemptsRef.current = 0
      clearSfuPark()
      setConnectionStatus('connecting')
      sendVoiceStateUpdate(guildId, channelId, selfMuteRef.current, selfDeafRef.current)
    },
    [sendVoiceStateUpdate]
  )

  const leaveVoice = useCallback(() => {
    // Explicit leave: drop the intent FIRST so no later READY can resurrect
    // it — Tier 2 volunteers only what the user still wants.
    dropVoiceIntent()
    sfuFailoverAttemptsRef.current = 0
    clearSfuPark()

    if (sfuClientRef.current) {
      sfuClientRef.current.disconnect(true)
      sfuClientRef.current = null
    }
    lastVoiceServerRef.current = null

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
        videoStats,
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
