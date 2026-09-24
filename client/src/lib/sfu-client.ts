// WebRTC client for communicating with the Pion SFU media server.
// Handles WebSocket signaling, SDP offer/answer exchange, ICE candidates,
// audio playout, microphone capture, speaking detection, and mute/deafen controls.

import { isBenignPlayAbort } from './spotlight'

export interface SfuClientOptions {
  endpoint: string
  token: string
  channelId: string
  guildId?: string
  rtcConfig?: RTCConfiguration
  onConnectionStateChange?: (state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void
  onSpeakingChange?: (userId: string, isSpeaking: boolean) => void
  onRemoteTrack?: (track: MediaStreamTrack, stream: MediaStream) => void
  onRemoteVideoChange?: (userId: string, stream: MediaStream | null) => void
  onLocalVideoChange?: (stream: MediaStream | null) => void
  onRemoteScreenShareChange?: (userId: string, stream: MediaStream | null) => void
  onLocalScreenChange?: (stream: MediaStream | null) => void
  /** Periodic inbound video stats (2s poll while connected). Keyed by receiver track id. */
  onStatsUpdate?: (stats: InboundVideoStats) => void
  userId?: string
  onError?: (error: Error) => void
  /** How long a transient `disconnected` is tolerated before recovery starts. Default 3000. */
  reconnectGraceMs?: number
  /** How long to wait for `connected` after an ICE restart before giving up. Default 5000. */
  reconnectTimeoutMs?: number
}

export function resolveSfuWsUrl(endpoint: string): string {
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    return endpoint.endsWith('/ws') ? endpoint : `${endpoint.replace(/\/$/, '')}/ws`
  }

  const isHttps = endpoint.startsWith('https://')
  const clean = endpoint.replace(/^(http:\/\/|https:\/\/)/, '').replace(/\/.*$/, '')
  const parts = clean.split(':')
  let host = parts[0]
  const port = parts[1] || '5000'

  if (typeof window !== 'undefined' && window.location) {
    const currentHost = window.location.hostname
    if (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === 'sfu' ||
      // Phase 7d pool members: compose service names, reachable in-container
      // for the gateway poller; browsers rewrite to the page hostname.
      host === 'sfu-2' ||
      host === 'sfu.kith.local' ||
      host === '0.0.0.0'
    ) {
      host = currentHost || '127.0.0.1'
    }
  }

  const protocol =
    isHttps || (typeof window !== 'undefined' && window.location?.protocol === 'https:')
      ? 'wss:'
      : 'ws:'
  return `${protocol}//${host}:${port}/ws`
}

/**
 * Extract inbound video stats from a getStats report, keyed by receiver
 * track id. Pure function over the report — unit testable with fakes.
 */
export function collectInboundVideoStats(report: RTCStatsReport): InboundVideoStats {
  const out: InboundVideoStats = new Map()
  const byId = new Map<string, Record<string, unknown>>()
  report.forEach((s: unknown) => {
    const r = s as Record<string, unknown>
    if (typeof r?.id === 'string') byId.set(r.id as string, r)
  })
  report.forEach((s: unknown) => {
    const r = s as Record<string, unknown>
    if (r?.type !== 'inbound-rtp') return
    const kind = (r.kind as string) ?? ((r.mediaType as string) ?? '')
    if (kind && kind !== 'video') return
    let trackId = r.trackId as string | undefined
    let trackStats: Record<string, unknown> | undefined
    if (trackId) trackStats = byId.get(trackId)
    // Fallback: some stacks omit trackId — match via trackIdentifier.
    if (!trackStats && typeof r.trackIdentifier === 'string') {
      const want = r.trackIdentifier as string
      for (const [, cand] of byId) {
        if (cand['trackIdentifier'] === want || cand['id'] === want) {
          trackStats = cand
          trackId = (cand['trackIdentifier'] as string) ?? (cand['id'] as string)
          break
        }
      }
    }
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    const jbd = num(r['jitterBufferDelay']);
    const jbe = num(r['jitterBufferEmittedCount']);
    out.set((trackId ?? r.ssrc ?? r.id) as string, {
      trackId: (trackId ?? r.ssrc ?? r.id) as string,
      width: num(r['frameWidth']) ?? num(trackStats?.['frameWidth']),
      height: num(r['frameHeight']) ?? num(trackStats?.['frameHeight']),
      framesPerSecond: num(r['framesPerSecond']),
      framesDropped: num(r['framesDropped']),
      jitterBufferDelayMs:
        jbd != null && jbe != null && jbe > 0 ? (jbd / jbe) * 1000 : null,
    })
  })
  return out
}

export type VideoSource = 'off' | 'camera' | 'screen'

export interface InboundVideoTrackStats {
  trackId: string
  width: number | null
  height: number | null
  framesPerSecond: number | null
  framesDropped: number | null
  jitterBufferDelayMs: number | null
}

export type InboundVideoStats = Map<string, InboundVideoTrackStats>

/** getStats poll interval while connected (ms). */
export const STATS_POLL_INTERVAL_MS = 2000

export interface SetVideoSourceOptions {
  deviceId?: string
}

export interface MidIndexEntry {
  uid: string
  kind: 'screen' | 'video' | 'audio'
}

/**
 * Parse an SDP offer from the SFU and return mid -> {uid, kind} for every
 * m-section carrying a Kith msid:
 *   screen: a=msid:kith-screen-<uid> kith-track-<uid>-screen
 *   cam:    a=msid:kith-stream-<uid> kith-track-<uid>-video  (stable, R9)
 *   audio:  a=msid:kith-stream-<uid> kith-track-<uid>
 * Sections without a Kith msid are skipped. UID comes from the stream id
 * (stable); kind comes from the stream prefix + m= kind, never from the
 * random browser track id.
 */
export function parseMidIndexFromSdp(sdp: string): Map<string, MidIndexEntry> {
  const result = new Map<string, MidIndexEntry>()
  // Split on CRLF or lone LF (stacks differ; Pion emits CRLF, be liberal).
  const sections = sdp.split(/\r?\nm=/)
  for (let i = 0; i < sections.length; i++) {
    const section = i === 0 ? sections[i] : 'm=' + sections[i]
    const mediaMatch = section.match(/^m=(audio|video)\b/m)
    if (!mediaMatch) continue
    const midMatch = section.match(/^a=mid:(.+)$/m)
    const msidMatch = section.match(/^a=msid:(\S+)\s+(\S+)/m)
    if (!midMatch || !msidMatch) continue
    const streamId = msidMatch[1]
    const mid = midMatch[1].trim()
    let uid = ''
    let kind: MidIndexEntry['kind'] = 'video'
    if (streamId.startsWith('kith-screen-')) {
      uid = streamId.replace('kith-screen-', '')
      kind = 'screen'
    } else if (streamId.startsWith('kith-stream-')) {
      uid = streamId.replace('kith-stream-', '')
      kind = mediaMatch[1] === 'audio' ? 'audio' : 'video'
    } else {
      continue
    }
    if (!uid) continue
    result.set(mid, { uid, kind })
  }
  return result
}

/**
 * Parse an SDP offer from the SFU and return mid -> screenshare publisher uid
 * for every m-section whose msid signals a screenshare downlink.
 * Kept for compatibility; new code uses parseMidIndexFromSdp.
 */
export function parseScreenMidsFromSdp(sdp: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const [mid, entry] of parseMidIndexFromSdp(sdp)) {
    if (entry.kind === 'screen') result.set(mid, entry.uid)
  }
  return result
}

export interface VideoSendEncoding {
  rid?: string
  maxBitrate?: number
  scaleResolutionDownBy?: number
  active?: boolean
}

export class SfuClient {
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null

  // Simulcast send encodings (issue #80): cam publishes all three layers,
  // screen publishes f only (720p30 single layer). Specced bitrates.
  static readonly DEFAULT_VIDEO_ENCODINGS: VideoSendEncoding[] = [
    { rid: 'f', maxBitrate: 2_500_000 },
    { rid: 'h', maxBitrate: 500_000, scaleResolutionDownBy: 2 },
    { rid: 'q', maxBitrate: 150_000, scaleResolutionDownBy: 4 },
  ]
  /** Currently applied encoding set (observability; the sender owns truth). */
  public videoEncodings: VideoSendEncoding[] = SfuClient.DEFAULT_VIDEO_ENCODINGS
  private localStream: MediaStream | null = null
  // Single video slot (Step 1): at most ONE live video uplink. The active
  // track/stream/sender below holds whichever source is live; switching
  // sources stops the old device track first (bandwidth goal).
  private localVideoStream: MediaStream | null = null
  private localVideoTrack: MediaStreamTrack | null = null
  private videoSender: RTCRtpSender | null = null
  private videoSource: VideoSource = 'off'
  private selectedVideoDeviceId: string | null = null
  private remoteVideoStreams: Map<string, MediaStream> = new Map()

  private remoteScreenStreams: Map<string, MediaStream> = new Map()

  private audioElements: Map<string, HTMLAudioElement> = new Map()
  private userToTrackMap: Map<string, string> = new Map()
  // MID (from SFU offer SDP) -> {uid, kind} for every Kith m-section.
  // Authoritative source for track classification; survives synthetic
  // MediaStreams. Replaces the old screen-only index (R9).
  private midIndex: Map<string, MidIndexEntry> = new Map()
  // UIDs whose screen share ended (screen:false seen). Stale in-flight offers
  // for these uids must not re-index a mapping (ghost-screen tombstone, R3).
  // Cleared on screen:true (re-share) or peer_left.
  private screenRevoked: Set<string> = new Set()
  // Latest downstream offer SDP, stored regardless of tombstone skips. On
  // screen:true the tombstone lifts after the reshare's offer was already
  // consumed (server sends offer-before-signal), so the screen MID must be
  // re-indexed from here — otherwise the track orphans until the next offer.
  private lastDownstreamSdp: string | null = null
  // Latest downstream offer that couldn't be applied yet (PC mid-renegotiation).
  // Retried when signaling returns to stable; SFU offers are full-state so
  // latest wins (R2).
  private pendingOffer: string | null = null
  private pendingOfferAttempts = 0
  private static readonly MAX_OFFER_ATTEMPTS = 5
  // Bounded safety-net retries for a rejected join offer (glare). Toggles
  // never offer, so this counter should stay at 0 in practice.
  private offerRetryAttempts = 0
  private static readonly MAX_OFFER_RETRIES = 3
  // ICE/connection recovery (R10, S6). A transient `disconnected` is debounced
  // through a grace window; only a sustained outage triggers an ICE restart
  // with re-offer of the live tracks. Attempts are bounded; exhaustion
  // surfaces `failed` so the user can rejoin manually.
  private hasConnected = false
  // Server acknowledged our join ('joined' received). Publisher offers sent
  // before this are rejected by the SFU ("must join before sending offer").
  private joinAcked = false
  private restartAttempts = 0
  private recoveryInFlight = false
  private recoveryWaiter: { resolve: (ok: boolean) => void } | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly MAX_RESTARTS = 2
  // Receiver track.id -> {uid, kind}. Prevents double-registration of the
  // same track in both video and screen maps (ontrack + attachTransceiverTracks).
  private remoteTrackKind: Map<string, { uid: string; kind: 'screen' | 'video' }> = new Map()
  // Receiver track.id -> stable MediaStream wrapper. Identity is what the
  // UI keys on; the same physical track must never be re-wrapped.
  private remoteStreamByTrack: Map<string, MediaStream> = new Map()
  private vadCleanup: (() => void) | null = null
  private unlockAudioCleanup: (() => void) | null = null
  private visibilityCleanup: (() => void) | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null

  private options: SfuClientOptions
  private isMuted = false
  private isDeafened = false
  private isClosed = false
  private isListenOnly = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private queue: Array<() => Promise<void>> = []
  private processingQueue = false

  constructor(options: SfuClientOptions) {
    this.options = {
      rtcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      ...options,
    }
  }

  public async connect(): Promise<void> {
    if (this.isClosed) return

    const wsUrl = resolveSfuWsUrl(this.options.endpoint)
    this.options.onConnectionStateChange?.('connecting')

    return new Promise((resolve, reject) => {
      let resolved = false

      try {
        this.ws = new WebSocket(wsUrl)
      } catch (err) {
        this.options.onConnectionStateChange?.('failed')
        reject(err)
        return
      }

      this.ws.onopen = async () => {
        try {
          await this.initPeerConnection()

          // Send join message
          this.sendWsMessage({
            type: 'join',
            token: this.options.token,
            channel_id: this.options.channelId,
            guild_id: this.options.guildId,
            listen_only: this.isListenOnly,
          })

          if (!this.isListenOnly) {
            await this.publishLocalAudio()
          }

          if (!resolved) {
            resolved = true
            resolve()
          }
        } catch (err) {
          if (!resolved) {
            resolved = true
            reject(err)
          }
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          return this.enqueue(() => this.handleWsMessage(msg))
        } catch (err) {
          console.error('[SfuClient] Error parsing WS message:', err)
        }
      }

      this.ws.onerror = (event) => {
        console.error('[SfuClient] WebSocket error:', event)
        this.options.onError?.(new Error('SFU WebSocket error'))
        if (!resolved) {
          resolved = true
          reject(new Error('Failed to connect to SFU WebSocket'))
        }
      }

      this.ws.onclose = () => {
        if (!this.isClosed) {
          this.options.onConnectionStateChange?.('disconnected')
          this.cleanup()
        }
      }
    })
  }

  private async initPeerConnection(): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      return
    }

    this.pc = new RTCPeerConnection(this.options.rtcConfig)

    // Retry stashed downstream offers once our own renegotiation settles (R2).
    this.pc.addEventListener('signalingstatechange', () => {
      if (!this.isClosed && this.pc?.signalingState === 'stable') {
        this.flushPendingOffer()
      }
    })

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendWsMessage({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    this.pc.onconnectionstatechange = () => {
      if (!this.pc || this.isClosed) return
      const state = this.pc.connectionState
      if (state === 'connected') {
        this.hasConnected = true
        if (this.recoveryWaiter) {
          // A restart was awaiting this outcome — the recovery path emits.
          const waiter = this.recoveryWaiter
          this.recoveryWaiter = null
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
          }
          waiter.resolve(true)
          return
        }
        this.clearRecoveryTimers()
        this.restartAttempts = 0
        this.options.onConnectionStateChange?.('connected')
        this.startStatsPolling()
      } else if (state === 'disconnected') {
        // Pre-connect blips keep legacy behavior (no recovery basis yet).
        if (!this.hasConnected) {
          this.options.onConnectionStateChange?.('disconnected')
          return
        }
        if (this.recoveryWaiter) return // restart already awaiting an outcome
        if (!this.reconnectTimer) {
          // Debounce: brief ICE blips (common under renegotiation bursts)
          // self-heal without surfacing a channel leave (S6).
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            void this.attemptRecovery()
          }, this.options.reconnectGraceMs ?? 3000)
        }
      } else if (state === 'failed') {
        if (!this.hasConnected) {
          this.options.onConnectionStateChange?.('failed')
          return
        }
        if (this.recoveryWaiter) {
          const waiter = this.recoveryWaiter
          this.recoveryWaiter = null
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
          }
          waiter.resolve(false)
          return
        }
        void this.attemptRecovery()
      }
    }

    this.pc.ontrack = (event) => {
      const mid = (event as RTCTrackEvent & { transceiver?: { mid?: string | null } }).transceiver?.mid ?? null
      this.handleRemoteTrack(event.track, event.streams[0] || null, mid)
    }

    this.setupVisibilityKeyframe()

    // Negotiate-once video slot: a sendonly video m-section rides the join
    // offer even with no track yet, declaring the 3 simulcast send encodings
    // (f/h/q per issue #80). All later cam/screen toggles only replaceTrack
    // on this sender — never re-offer (glare-proof). If setup fails, the
    // publish path falls back to addTrack + one renegotiation.
    this.videoEncodings = [...SfuClient.DEFAULT_VIDEO_ENCODINGS]
    try {
      if (typeof this.pc.addTransceiver === 'function') {
        const tx = this.pc.addTransceiver('video', {
          direction: 'sendonly',
          sendEncodings: SfuClient.DEFAULT_VIDEO_ENCODINGS.map((e) => ({ ...e })),
        })
        if (tx && tx.sender) {
          this.videoSender = tx.sender
        }
      }
    } catch (err) {
      console.warn('[SfuClient] Video transceiver pre-negotiation failed, will renegotiate on first enable:', err)
      this.videoSender = null
    }

    // Try to acquire mic stream unless explicitly in listen-only mode
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })

        this.localStream.getAudioTracks().forEach((track) => {
          track.enabled = !this.isMuted
          if (this.pc && this.localStream) {
            this.pc.addTrack(track, this.localStream)
          }
        })

        this.initVoiceActivityDetector(this.localStream)
      }
    } catch (err) {
      console.warn('[SfuClient] Microphone access unavailable, falling back to listen-only:', err)
      this.isListenOnly = true
    }
  }

  /**
   * Poll pc.getStats() every STATS_POLL_INTERVAL_MS while the session is
   * alive, emitting inbound video stats keyed by receiver track id. Pure
   * observability — drives the per-tile quality badges. Idempotent; safe to
   * call on every connected transition.
   */
  public startStatsPolling(): void {
    if (this.statsTimer || this.isClosed || !this.pc || !this.options.onStatsUpdate) return
    if (typeof this.pc.getStats !== 'function') return
    const tick = () => {
      if (this.isClosed || !this.pc) return
      this.pc
        .getStats()
        .then((report) => {
          if (this.isClosed) return
          this.options.onStatsUpdate?.(collectInboundVideoStats(report))
        })
        .catch(() => {
          // Stats are best-effort; a failed poll must never disturb media.
        })
    }
    // Prime immediately so badges populate without waiting one interval.
    tick()
    this.statsTimer = setInterval(tick, STATS_POLL_INTERVAL_MS)
  }

  public stopStatsPolling(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  private async publishLocalAudio(): Promise<void> {
    if (!this.pc) return

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    this.sendWsMessage({
      type: 'offer',
      sdp: offer.sdp,
    })
  }

  private async handleWsMessage(msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case 'joined':
        this.joinAcked = true
        this.offerRetryAttempts = 0
        this.options.onConnectionStateChange?.('connected')
        this.startStatsPolling()
        break

      case 'answer':
        this.offerRetryAttempts = 0
        if (this.pc && msg.sdp) {
          await this.pc.setRemoteDescription({
            type: 'answer',
            sdp: msg.sdp,
          })
          await this.drainPendingCandidates()
        }
        break

      case 'offer':
        // Downstream renegotiation offer from SFU
        if (this.pc && msg.sdp) {
          // Remember the latest SDP even when tombstones skip entries: a
          // reshare's offer arrives before its screen:true (server order),
          // so the screen MID is skipped first and must be re-indexed when
          // the tombstone lifts below.
          this.lastDownstreamSdp = msg.sdp
          // Index every Kith m-section by MID before tracks arrive so
          // ontrack / attachTransceiverTracks can classify authoritatively.
          // Screen mappings for revoked uids (screen:false seen, no re-share
          // since) are skipped so stale offers can't resurrect ghosts (R3).
          for (const [mid, entry] of parseMidIndexFromSdp(msg.sdp)) {
            if (entry.kind === 'screen' && this.screenRevoked.has(entry.uid)) continue
            this.midIndex.set(mid, entry)
          }
          try {
            await this.applyDownstreamOffer(msg.sdp)
          } catch (err) {
            console.error('[SfuClient] Failed to apply downstream offer:', err)
            this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
          }
        }
        break

      case 'candidate':
        if (msg.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          } else {
            this.pendingCandidates.push(msg.candidate)
          }
        }
        break

      case 'speaking':
        if (msg.user_id && typeof msg.speaking === 'boolean') {
          this.options.onSpeakingChange?.(msg.user_id, msg.speaking)
        }
        break

      case 'video':
        if (msg.user_id && typeof msg.video === 'boolean') {
          if (!msg.video) {
            this.remoteVideoStreams.delete(msg.user_id)
            this.options.onRemoteVideoChange?.(msg.user_id, null)
            // Drop cam/audio MID entries for this uid — but never screen
            // entries (S3: stopping cam must not touch the screen index).
            for (const [mid, entry] of this.midIndex) {
              if (entry.uid === msg.user_id && entry.kind !== 'screen') this.midIndex.delete(mid)
            }
          }
        }
        break

      case 'screen':
        if (msg.user_id && typeof msg.screen === 'boolean') {
          if (msg.screen) {
            // Re-share: lift the tombstone so fresh offers index again.
            this.screenRevoked.delete(msg.user_id)
            // Heal the tombstone race: the reshare's offer was consumed
            // while tombstoned (offer-before-signal server order), so its
            // screen MID was skipped. Re-index this user's screen entries
            // from the latest downstream SDP, then classify any receiver
            // tracks that already arrived. No signaling involved.
            if (this.lastDownstreamSdp) {
              for (const [mid, entry] of parseMidIndexFromSdp(this.lastDownstreamSdp)) {
                if (entry.uid !== msg.user_id || entry.kind !== 'screen') continue
                if (this.screenRevoked.has(entry.uid)) continue
                this.midIndex.set(mid, entry)
              }
            }
            this.attachTransceiverTracks()
          } else {
            this.remoteScreenStreams.delete(msg.user_id)
            this.options.onRemoteScreenShareChange?.(msg.user_id, null)
            for (const [mid, entry] of this.midIndex) {
              if (entry.uid === msg.user_id && entry.kind === 'screen') this.midIndex.delete(mid)
            }
            this.screenRevoked.add(msg.user_id)
            for (const [trackId, info] of this.remoteTrackKind) {
              if (info.uid === msg.user_id && info.kind === 'screen') this.remoteTrackKind.delete(trackId)
            }
          }
        }
        break

      case 'peer_left':
        if (msg.user_id) {
          this.options.onSpeakingChange?.(msg.user_id, false)
          this.cleanupPeerAudio(msg.user_id)
          if (this.remoteVideoStreams.has(msg.user_id)) {
            this.remoteVideoStreams.delete(msg.user_id)
            this.options.onRemoteVideoChange?.(msg.user_id, null)
          }
          if (this.remoteScreenStreams.has(msg.user_id)) {
            this.remoteScreenStreams.delete(msg.user_id)
            this.options.onRemoteScreenShareChange?.(msg.user_id, null)
          }
          for (const [mid, entry] of this.midIndex) {
            if (entry.uid === msg.user_id) this.midIndex.delete(mid)
          }
          this.screenRevoked.delete(msg.user_id)
          for (const [trackId, info] of this.remoteTrackKind) {
            if (info.uid === msg.user_id) this.remoteTrackKind.delete(trackId)
          }
        }
        break

      case 'error':
        console.error('[SfuClient] SFU error:', msg.message)
        this.options.onError?.(new Error(msg.message || 'SFU error'))
        // The SFU rejected our offer (glare: it was mid downstream offer
        // when ours arrived — only possible for the join offer now, since
        // toggles never offer). Bounded retry with backoff, only while our
        // PC is stable: an unbounded immediate retry is how offer ping-pongs
        // wedge a session permanently. If the counter ever fires in logs,
        // something regressed back to offering post-join.
        if (!this.isClosed && typeof msg.message === 'string' && msg.message.includes('failed to process offer')) {
          if (this.offerRetryAttempts < SfuClient.MAX_OFFER_RETRIES && this.pc?.signalingState === 'stable') {
            this.offerRetryAttempts += 1
            const attempt = this.offerRetryAttempts
            setTimeout(() => {
              if (!this.isClosed) {
                this.renegotiate().catch((err) => {
                  console.warn(`[SfuClient] Retry ${attempt} after rejected offer failed:`, err)
                })
              }
            }, 500 * attempt)
          } else {
            console.warn('[SfuClient] Giving up re-offer after rejected offer (retries exhausted or PC unstable)')
          }
        }
        break

      default:
        break
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await task()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      this.processQueue()
    })
  }

  private async processQueue() {
    if (this.processingQueue) return
    this.processingQueue = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        try {
          await task()
        } catch (err) {
          console.error('[SfuClient] Error processing signaling task:', err)
        }
      }
    }
    this.processingQueue = false
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) return
    while (this.pendingCandidates.length > 0) {
      const c = this.pendingCandidates.shift()
      if (c) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(c))
        } catch (err) {
          console.warn('[SfuClient] Failed to add queued ICE candidate:', err)
        }
      }
    }
  }

  // Applies an SFU downstream offer. Never forces setRemoteDescription while
  // unstable: on glare the latest offer is stashed and retried when signaling
  // returns to stable (mirrors the SFU postpone pattern). Nothing is ever
  // silently dropped — the old 1s force-through wedged the PC here (R2).
  private async applyDownstreamOffer(sdp: string): Promise<void> {
    if (!this.pc || this.isClosed) return

    if (this.pc.signalingState && this.pc.signalingState !== 'stable') {
      this.stashDownstreamOffer(sdp)
      return
    }

    try {
      await this.pc.setRemoteDescription({
        type: 'offer',
        sdp,
      })
    } catch (err: any) {
      if (err?.name === 'InvalidStateError') {
        console.warn('[SfuClient] Downstream offer hit non-stable PC, queued for retry on stable')
        this.stashDownstreamOffer(sdp)
        return
      }
      throw err
    }
    await this.drainPendingCandidates()

    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)

    this.sendWsMessage({
      type: 'answer',
      sdp: answer.sdp,
    })

    this.attachTransceiverTracks()
    this.pendingOfferAttempts = 0
  }

  private stashDownstreamOffer(sdp: string): void {
    this.pendingOffer = sdp
    this.pendingOfferAttempts += 1
    if (this.pendingOfferAttempts > SfuClient.MAX_OFFER_ATTEMPTS) {
      this.pendingOffer = null
      this.pendingOfferAttempts = 0
      this.options.onError?.(
        new Error('[SfuClient] Dropping downstream offer: PC never returned to stable'),
      )
    }
  }

  private flushPendingOffer(): void {
    if (
      !this.pendingOffer ||
      this.isClosed ||
      !this.pc ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return
    }
    if (this.pc.signalingState && this.pc.signalingState !== 'stable') return
    const sdp = this.pendingOffer
    this.pendingOffer = null
    this.enqueue(() => this.applyDownstreamOffer(sdp)).catch((err) => {
      console.error('[SfuClient] Failed to apply queued downstream offer:', err)
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
    })
  }

  private attachTransceiverTracks(): void {
    if (!this.pc || typeof document === 'undefined') return
    for (const transceiver of this.pc.getTransceivers()) {
      const track = transceiver.receiver?.track
      if (track && track.readyState === 'live') {
        // Skip tracks already classified via ontrack (dedupe).
        if (this.remoteTrackKind.has(track.id)) continue
        this.handleRemoteTrack(track, null, transceiver.mid ?? null)
      }
    }
  }

  private handleRemoteTrack(track: MediaStreamTrack, initialStream: MediaStream | null, mid: string | null = null): void {
    // Stream-identity stability: the same receiver track re-announced
    // (ontrack + attachTransceiverTracks, re-offers) must keep ONE
    // MediaStream object. A fresh synthetic wrapper per event swaps the
    // identity every <video> effect depends on — srcObject reassignment
    // aborts in-flight play() and the UI flickers/latches "ended".
    // The browser-provided initialStream wins when present (it carries the
    // negotiated msid identity); the stable wrapper is only the fallback
    // for synthetic (track-only) announcements.
    let stream: MediaStream | null = null
    if (initialStream) {
      stream = initialStream
      this.remoteStreamByTrack.set(track.id, stream)
    } else {
      stream = this.remoteStreamByTrack.get(track.id) || null
    }
    if (!stream) {
      stream = new MediaStream([track])
      this.remoteStreamByTrack.set(track.id, stream)
    } else if (!stream.getTracks?.().some((t) => t.id === track.id)) {
      // Stable wrapper lost the track (ended + replaced at the source):
      // adopt the fresh track into the SAME stream identity so attached
      // elements keep playing without re-attach churn.
      try {
        stream.addTrack(track)
      } catch {}
      this.remoteStreamByTrack.set(track.id, stream)
    }
    this.options.onRemoteTrack?.(track, stream)

    const streamId = stream?.id || ''
    const trackId = track?.id || ''

    // 1. Authoritative: full MID index from the SFU offer SDP msid lines.
    // 2. Heuristic fallback: signaled stream/track ids (stable SFU ids).
    // 3. Stable: a receiver track.id keeps its first classification so a
    //    re-announced transceiver can't flip screen <-> camera.
    const midEntry = mid ? this.midIndex.get(mid) : undefined
    const seen = this.remoteTrackKind.get(trackId)

    let publisherUid: string
    let isScreen: boolean
    if (midEntry !== undefined) {
      // MID wins outright: it identifies both uid and kind (R9).
      publisherUid = midEntry.uid
      isScreen = track.kind === 'video' && midEntry.kind === 'screen'
    } else {
      isScreen =
        streamId.startsWith('kith-screen-') ||
        trackId.includes('-screen') ||
        seen?.kind === 'screen'

      if (isScreen) {
        publisherUid = streamId.startsWith('kith-screen-')
          ? streamId.replace('kith-screen-', '')
          : trackId.replace('kith-track-', '').replace('-screen', '')
        // Tombstoned screen (stale offer/track after screen:false): drop the
        // ghost instead of rendering a frozen frame (R3).
        if (publisherUid && this.screenRevoked.has(publisherUid)) return
      } else {
        publisherUid = streamId.startsWith('kith-stream-')
          ? streamId.replace('kith-stream-', '')
          : trackId.startsWith('kith-track-')
          ? trackId.replace('kith-track-', '').replace('-video', '').replace('-audio', '')
          : ''
      }
    }

    if (track.kind === 'video') {
      if (isScreen) {
        const screenKey = publisherUid || track.id
        // Same physical track previously misfiled as camera → move it to the
        // screen map. A DIFFERENT live track under the same uid is a
        // legitimate camera (cam+screen coexistence) → keep both.
        const misfiled = this.remoteVideoStreams.get(screenKey)
        if (
          misfiled &&
          (misfiled.getVideoTracks?.() ?? misfiled.getTracks?.() ?? []).some(
            (t: MediaStreamTrack) => t.id === trackId,
          )
        ) {
          this.remoteVideoStreams.delete(screenKey)
          this.options.onRemoteVideoChange?.(screenKey, null)
        }
        // Same receiver track re-announced: keep the original stream object
        // so attached <video> elements don't flicker.
        const existing = this.remoteScreenStreams.get(screenKey)
        if (existing && seen && (existing.getVideoTracks?.() ?? existing.getTracks?.() ?? []).some((t: MediaStreamTrack) => t.id === trackId)) {
          return
        }
        this.remoteTrackKind.set(trackId, { uid: screenKey, kind: 'screen' })
        this.remoteScreenStreams.set(screenKey, stream)
        this.options.onRemoteScreenShareChange?.(screenKey, stream)

        track.onended = () => {
          if (this.remoteScreenStreams.get(screenKey) === stream) {
            this.remoteScreenStreams.delete(screenKey)
            this.options.onRemoteScreenShareChange?.(screenKey, null)
          }
          this.remoteTrackKind.delete(trackId)
          this.remoteStreamByTrack.delete(trackId)
        }
        return
      }

      const videoKey = publisherUid || track.id
      const knownScreen = this.remoteScreenStreams.get(videoKey)
      if (
        knownScreen &&
        (knownScreen.getVideoTracks?.() ?? knownScreen.getTracks?.() ?? []).some(
          (t: MediaStreamTrack) => t.id === trackId,
        )
      ) {
        // Same physical track already shown as screen: don't mirror it into
        // the camera map. A different track under the same uid is a
        // legitimate camera alongside the screen → keep both.
        return
      }
      const existing = this.remoteVideoStreams.get(videoKey)
      if (existing && seen && (existing.getVideoTracks?.() ?? existing.getTracks?.() ?? []).some((t: MediaStreamTrack) => t.id === trackId)) {
        return
      }
      this.remoteTrackKind.set(trackId, { uid: videoKey, kind: 'video' })
      this.remoteVideoStreams.set(videoKey, stream)
      this.options.onRemoteVideoChange?.(videoKey, stream)

      track.onended = () => {
        if (this.remoteVideoStreams.get(videoKey) === stream) {
          this.remoteVideoStreams.delete(videoKey)
          this.options.onRemoteVideoChange?.(videoKey, null)
        }
        this.remoteTrackKind.delete(trackId)
        this.remoteStreamByTrack.delete(trackId)
      }
      return
    }

    const audioKey = publisherUid || track.id
    if (publisherUid) {
      this.userToTrackMap.set(publisherUid, track.id)
    }

    if (typeof document !== 'undefined') {
      let audioEl = this.audioElements.get(audioKey)
      if (!audioEl || !document.body.contains(audioEl)) {
        audioEl = document.createElement('audio')
        audioEl.autoplay = true
        audioEl.setAttribute?.('playsinline', 'true')
        audioEl.muted = this.isDeafened
        audioEl.style.position = 'fixed'
        audioEl.style.opacity = '0'
        audioEl.style.pointerEvents = 'none'
        audioEl.style.width = '1px'
        audioEl.style.height = '1px'
        audioEl.style.bottom = '0'
        document.body.appendChild(audioEl)
        this.audioElements.set(audioKey, audioEl)
      }

      audioEl.srcObject = stream

      track.onended = () => {
        if (this.audioElements.get(audioKey) === audioEl) {
          audioEl.srcObject = null
          audioEl.remove()
          this.audioElements.delete(audioKey)
        }
      }

      const playPromise = audioEl.play()
      if (playPromise !== undefined) {
        playPromise.catch((err: unknown) => {
          // A play() aborted by a newer load is churn, not a block — the new
          // attach owns playback. Only a real NotAllowedError earns the
          // gesture unlock (registering it on every churn leaks listeners).
          if (isBenignPlayAbort(err)) return
          console.warn('[SfuClient] Autoplay prevented, registering user gesture unlock:', err)
          this.ensureGlobalAudioUnlock()
        })
      }
    }
  }

  private cleanupPeerAudio(userId: string): void {
    const directEl = this.audioElements.get(userId)
    if (directEl) {
      directEl.srcObject = null
      directEl.remove()
      this.audioElements.delete(userId)
    }
    const trackId = this.userToTrackMap.get(userId)
    if (trackId) {
      const el = this.audioElements.get(trackId)
      if (el) {
        el.srcObject = null
        el.remove()
        this.audioElements.delete(trackId)
      }
      this.userToTrackMap.delete(userId)
    }
  }

  private ensureGlobalAudioUnlock(): void {
    if (typeof window === 'undefined' || this.unlockAudioCleanup) return

    const unlock = () => {
      for (const el of this.audioElements.values()) {
        if (el.paused) {
          el.play().catch(() => {})
        }
      }
    }

    const events = ['click', 'keydown', 'pointerdown', 'touchstart']
    const handler = () => {
      unlock()
    }

    for (const ev of events) {
      window.addEventListener(ev, handler)
    }

    this.unlockAudioCleanup = () => {
      for (const ev of events) {
        window.removeEventListener(ev, handler)
      }
      this.unlockAudioCleanup = null
    }
  }

  private initVoiceActivityDetector(stream: MediaStream): void {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
      return
    }

    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
      const resumeAudioCtx = () => {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {})
        }
      }
      const resumeEvents = ['click', 'keydown', 'pointerdown', 'touchstart']
      resumeEvents.forEach((ev) => window.addEventListener(ev, resumeAudioCtx))

      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      const buffer = new Uint8Array(analyser.frequencyBinCount)
      let isSpeaking = false
      let silenceCounter = 0

      const intervalId = window.setInterval(() => {
        if (this.isClosed || this.isMuted) {
          if (isSpeaking) {
            isSpeaking = false
            this.sendWsMessage({ type: 'speaking', speaking: false })
          }
          return
        }

        analyser.getByteFrequencyData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i]
        }
        const avg = sum / buffer.length

        // Speaking threshold: volume above threshold
        if (avg > 18) {
          silenceCounter = 0
          if (!isSpeaking) {
            isSpeaking = true
            this.sendWsMessage({ type: 'speaking', speaking: true })
          }
        } else {
          silenceCounter++
          if (isSpeaking && silenceCounter > 8) {
            // ~400ms silence
            isSpeaking = false
            this.sendWsMessage({ type: 'speaking', speaking: false })
          }
        }
      }, 50)

      this.vadCleanup = () => {
        window.clearInterval(intervalId)
        resumeEvents.forEach((ev) => window.removeEventListener(ev, resumeAudioCtx))
        source.disconnect()
        analyser.disconnect()
        audioCtx.close().catch(() => {})
      }
    } catch (err) {
      console.warn('[SfuClient] Voice activity detector initialization skipped:', err)
    }
  }

  public setMute(mute: boolean): void {
    this.isMuted = mute
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !mute
      })
    }
    if (mute) {
      this.sendWsMessage({ type: 'speaking', speaking: false })
    }
  }

  public setDeaf(deaf: boolean): void {
    this.isDeafened = deaf
    for (const audioEl of this.audioElements.values()) {
      audioEl.muted = deaf
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this.isClosed
  }

  public getVideoSource(): VideoSource {
    return this.videoSource
  }

  // Ask the encoder for a keyframe on the live video uplink (best-effort).
  // Used when returning from a backgrounded tab while screen sharing:
  // static screen content emits keyframes rarely, so a decoder that lost
  // sync during the stall would otherwise wait indefinitely. Returns true
  // when a request was issued.
  public requestKeyframe(): boolean {
    if (this.isClosed || !this.pc || !this.videoSender) return false
    try {
      const keyframer = this.videoSender as unknown as {
        generateKeyFrame?: () => Promise<void>
      }
      const p = keyframer.generateKeyFrame?.()
      if (!p) return false
      p.catch(() => {})
      return true
    } catch {
      return false
    }
  }

  public isCameraActive(): boolean {
    return this.videoSource === 'camera'
  }

  public getLocalVideoStream(): MediaStream | null {
    return this.videoSource === 'camera' ? this.localVideoStream : null
  }

  public getRemoteVideoStreams(): Map<string, MediaStream> {
    return new Map(this.remoteVideoStreams)
  }

  // Serializes all local camera/screen publish operations (R1). Concurrent
  // toggles queue instead of overlapping getUserMedia/addTrack/createOffer,
  // so rapid cam->screen sequences can't spawn duplicate senders or clobber
  // each other's offers. The chain never breaks on failure; the task promise
  // itself still rejects so callers can roll back (R6).
  private mediaOpChain: Promise<unknown> = Promise.resolve()

  private runMediaOp<T>(op: () => Promise<T>): Promise<T> {
    const task = this.mediaOpChain.then(() => op())
    this.mediaOpChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  // Single video slot (Step 1): exactly one of 'camera' | 'screen' | 'off'
  // is ever live. Switching sources stops the old device track first, so the
  // uplink stays at 1 video stream max (bandwidth goal). Serialized through
  // mediaOpChain (R1); failures roll back to the previous live state (R6).
  public setVideoSource(source: VideoSource, opts?: SetVideoSourceOptions): Promise<MediaStream | null> {
    return this.runMediaOp(() => this.doSetVideoSource(source, opts))
  }

  private async doSetVideoSource(source: VideoSource, opts?: SetVideoSourceOptions): Promise<MediaStream | null> {
    if (this.isClosed) return null

    if (opts?.deviceId) {
      this.selectedVideoDeviceId = opts.deviceId
    }

    // Idempotent fast paths: plain re-enable reuses the live track, 'off'
    // when already off is a no-op (no phantom video:false / screen:false).
    if (source === this.videoSource) {
      if (source === 'off') return null
      if (this.localVideoStream && this.localVideoTrack) {
        if (source === 'camera' && opts?.deviceId) {
          // Explicit device switch: fall through to re-acquire.
        } else {
          return this.localVideoStream
        }
      }
    }

    if (source === 'off') {
      return this.teardownVideoSlot()
    }

    // 1. Acquire the new device track FIRST — acquisition failure leaves the
    // currently-live source untouched (R6).
    const stream = source === 'camera' ? await this.acquireCameraTrack() : await this.acquireScreenTrack()

    const track = stream.getVideoTracks()[0]
    if (!track) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop()
        } catch {}
      })
      const err = new Error(
        source === 'camera' ? 'No video track found in acquired media stream' : 'No video track found in screen capture',
      )
      this.options.onError?.(err)
      throw err
    }

    // Hint the encoder: faces favor framerate, screens favor sharpness.
    try {
      ;(track as MediaStreamTrack & { contentHint?: string }).contentHint = source === 'screen' ? 'detail' : 'face'
    } catch {}

    // Snapshot for rollback (R6). The old track stays live until the new one
    // is successfully published.
    const prevTrack = this.localVideoTrack
    const prevStream = this.localVideoStream
    const prevSource = this.videoSource

    try {
      if (prevTrack) (prevTrack as MediaStreamTrack & { onended?: unknown }).onended = null
    } catch {}
    // Native browser "Stop sharing" / device unplug ends the track
    // out-of-band → drop the whole slot.
    track.onended = () => {
      if (this.localVideoTrack === track) {
        this.setVideoSource('off').catch((err) => {
          console.warn('[SfuClient] Error stopping video on track end:', err)
        })
      }
    }

    this.localVideoTrack = track
    this.localVideoStream = stream
    this.videoSource = source

    // Negotiate-once publish: the video m-section already exists from the
    // join offer, so every enable/switch is a replaceTrack on the
    // pre-negotiated sender — never an offer (glare-proof). Only when the
    // pre-negotiated sender is missing do we fall back to addTrack + one
    // renegotiation.
    let didAdd = false
    try {
      if (this.pc) {
        if (this.videoSender) {
          await this.videoSender.replaceTrack(track)
        } else {
          this.videoSender = this.pc.addTrack(track, stream)
          didAdd = true
          await this.renegotiate()
        }
      }

      // Clear the old kind BEFORE announcing the new one so viewers never
      // observe both live for this user.
      if (prevSource !== 'off' && prevSource !== source) {
        if (prevSource === 'camera') {
          this.sendWsMessage({ type: 'video', video: false })
          this.options.onLocalVideoChange?.(null)
        } else {
          this.sendWsMessage({ type: 'screen', screen: false })
          this.options.onLocalScreenChange?.(null)
        }
      }

      // Simulcast layers follow the source: cam publishes all three
      // encodings, screen publishes f only (720p30 single layer). Local
      // parameter change only — never an offer.
      await this.applyVideoEncodings(source === 'camera' ? 'cam' : 'screen')

      if (source === 'camera') {
        this.sendWsMessage({ type: 'video', video: true })
        this.options.onLocalVideoChange?.(this.localVideoStream)
      } else {
        // Kind identity is signaled, never renegotiated: the SFU labels the
        // publisher from this message (last-writer-wins per user). trackId
        // is carried for observability only.
        this.sendWsMessage({ type: 'screen', screen: true, trackId: track.id })
        this.options.onLocalScreenChange?.(this.localVideoStream)
      }

      if (prevTrack && prevTrack !== track) {
        try {
          prevTrack.stop()
        } catch {}
      }
      return this.localVideoStream
    } catch (err: any) {
      // Publish failed (R6). Two cases:
      // - Fallback addTrack path (previous source was off): detach the
      //   half-built sender and clear to off; nothing was live before.
      // - replaceTrack on the pre-negotiated sender: the old device is
      //   still held, so put it back and keep the previous source live.
      try {
        track.onended = null
      } catch {}
      try {
        track.stop()
      } catch {}
      if (didAdd) {
        if (this.pc && this.videoSender) {
          try {
            this.pc.removeTrack(this.videoSender)
          } catch {}
        }
        this.videoSender = null
        this.localVideoTrack = null
        this.localVideoStream = null
        this.videoSource = 'off'
        this.emitLocalVideoState()
      } else {
        let restored = false
        if (this.pc && this.videoSender && prevTrack && prevTrack !== track) {
          try {
            await this.videoSender.replaceTrack(prevTrack)
            restored = true
          } catch {}
        }
        if (restored) {
          this.localVideoTrack = prevTrack
          this.localVideoStream = prevStream
          this.videoSource = prevSource
          this.emitLocalVideoState()
        } else {
          if (prevTrack && prevTrack !== track) {
            try {
              ;(prevTrack as MediaStreamTrack & { onended?: unknown }).onended = null
            } catch {}
            try {
              prevTrack.stop()
            } catch {}
          }
          this.localVideoTrack = null
          this.localVideoStream = null
          this.videoSource = 'off'
          if (prevSource !== 'off') {
            this.sendWsMessage(
              prevSource === 'camera' ? { type: 'video', video: false } : { type: 'screen', screen: false },
            )
          }
          // The pre-negotiated sender survives (m-section intact) for retry.
          this.emitLocalVideoState()
        }
      }
      if (source === 'screen' && err?.name !== 'NotAllowedError') {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      throw err
    }
  }

  // Best-effort, idempotent slot teardown. Local cleanup always runs and the
  // matching kind:false is always sent when anything was live (R4). The
  // pre-negotiated sender is retained with a null track — no renegotiation,
  // so teardown can never wedge signaling.
  private async teardownVideoSlot(): Promise<null> {
    const hadVideo =
      this.videoSource !== 'off' ||
      this.localVideoTrack !== null ||
      this.localVideoStream !== null ||
      this.videoSender !== null
    if (!hadVideo) return null

    const prevSource = this.videoSource

    if (this.localVideoTrack) {
      try {
        this.localVideoTrack.onended = null
      } catch {}
      try {
        this.localVideoTrack.stop()
      } catch {}
      this.localVideoTrack = null
    }
    this.localVideoStream = null
    this.videoSource = 'off'

    if (this.pc && this.videoSender) {
      // Detach the track but keep the sender/m-section: re-enable is a
      // plain replaceTrack with no offer. Best-effort; kind:false below is
      // what the SFU acts on regardless (R4).
      try {
        await this.videoSender.replaceTrack(null)
      } catch (err) {
        console.warn('[SfuClient] Failed to detach video track:', err)
      }
    }

    if (prevSource === 'screen') {
      this.sendWsMessage({ type: 'screen', screen: false })
      this.options.onLocalScreenChange?.(null)
    } else if (prevSource === 'camera') {
      this.sendWsMessage({ type: 'video', video: false })
      this.options.onLocalVideoChange?.(null)
    } else {
      // Unknown prior kind (e.g. recovered state) — clear both so no ghost
      // publisher survives server-side.
      this.sendWsMessage({ type: 'video', video: false })
      this.sendWsMessage({ type: 'screen', screen: false })
      this.options.onLocalVideoChange?.(null)
      this.options.onLocalScreenChange?.(null)
    }
    return null
  }

  private emitLocalVideoState(): void {
    if (this.videoSource === 'camera') {
      this.options.onLocalVideoChange?.(this.localVideoStream)
    } else if (this.videoSource === 'screen') {
      this.options.onLocalScreenChange?.(this.localVideoStream)
    } else {
      this.options.onLocalVideoChange?.(null)
      this.options.onLocalScreenChange?.(null)
    }
  }

  // P1 experiment: activate/deactivate simulcast send encodings on the live
  // video sender (cam: f+h+q, screen: f only) AND pin degradationPreference
  // per source — screen gets 'maintain-resolution' (sharpness over
  // smoothness: a dropped frame beats an unreadable one), cam resets to the
  // browser default (Chrome 'balanced': smoothness over sharpness, right for
  // faces). Best-effort: rejection keeps the previous set (bandwidth impact
  // only, never a session error). Never renegotiates.
  private async applyVideoEncodings(source: 'cam' | 'screen'): Promise<void> {
    const sender = this.videoSender as unknown as {
      getParameters?: () => {
        encodings?: Array<{ rid?: string; active?: boolean }>
        degradationPreference?: string
      }
      setParameters?: (p: unknown) => Promise<void>
    } | null
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
      return
    }
    try {
      const params = sender.getParameters()
      const encodings = params.encodings
      if (!encodings || encodings.length === 0) return
      const wantActive = source === 'cam' ? null : new Set(['f'])
      let changed = false
      for (const enc of encodings) {
        const active = wantActive === null ? true : wantActive.has(enc.rid ?? 'f')
        if ((enc.active ?? true) !== active) {
          enc.active = active
          changed = true
        }
      }
      // Screen-only degradation pin: 'maintain-resolution' on screen,
      // explicit reset to default ('') on cam so the preference can't leak
      // across switches on the shared sender.
      const wantDegradation = source === 'screen' ? 'maintain-resolution' : ''
      if ((params.degradationPreference ?? '') !== wantDegradation) {
        params.degradationPreference = wantDegradation
        changed = true
      }
      if (changed) {
        await sender.setParameters({ ...params, encodings })
      }
      this.videoEncodings =
        source === 'cam'
          ? SfuClient.DEFAULT_VIDEO_ENCODINGS
          : SfuClient.DEFAULT_VIDEO_ENCODINGS.map((e) => ({ ...e, active: e.rid === 'f' }))
    } catch (err) {
      console.warn('[SfuClient] Simulcast encoding switch failed, keeping previous set:', err)
    }
  }

  // Background tabs stall the (expensive) screen encoder; on return, open
  // with a keyframe so viewers resync immediately instead of waiting out
  // the sparse static-content keyframe cadence. Camera needs nothing: its
  // constant motion self-heals via frequent keyframes.
  private setupVisibilityKeyframe(): void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    if (this.visibilityCleanup) return
    const handler = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState !== 'visible') return
      if (this.videoSource !== 'screen') return
      this.requestKeyframe()
    }
    document.addEventListener('visibilitychange', handler)
    this.visibilityCleanup = () => {
      document.removeEventListener('visibilitychange', handler)
      this.visibilityCleanup = null
    }
  }

  private async acquireCameraTrack(): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access not supported in this environment')
    }

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: this.selectedVideoDeviceId ? { exact: this.selectedVideoDeviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    }

    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err: any) {
      // Acquisition failed: live state untouched (R6) — a failed device
      // switch must not kill the running source.
      console.error('[SfuClient] Failed to enable camera:', err)
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  private async acquireScreenTrack(): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing not supported in this environment')
    }

    try {
      // 720p30 single-layer screen: half the bandwidth of 1080p, text stays
      // readable, one encode. The f-only encoding activation happens in
      // applyVideoEncodings after publish.
      return await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      })
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        console.log('[SfuClient] Screen share permission was denied or dismissed by user')
      } else {
        console.error('[SfuClient] Failed to start screen share:', err)
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      throw err
    }
  }

  // Legacy camera toggle — now routed through the single video slot, so
  // enabling the camera while sharing stops the screen first (and vice
  // versa via startScreenShare). Disabling only clears the camera kind: a
  // live screen share is left untouched.
  public setCameraEnabled(enabled: boolean, deviceId?: string): Promise<MediaStream | null> {
    if (!enabled) {
      if (this.videoSource !== 'camera') return Promise.resolve(null)
      return this.setVideoSource('off')
    }
    return this.setVideoSource('camera', deviceId ? { deviceId } : undefined)
  }

  public async setCameraDevice(deviceId: string): Promise<void> {
    this.selectedVideoDeviceId = deviceId
    if (this.videoSource === 'camera') {
      await this.setVideoSource('camera', { deviceId })
    }
  }

  public isScreenSharing(): boolean {
    return this.videoSource === 'screen'
  }

  public getLocalScreenStream(): MediaStream | null {
    return this.videoSource === 'screen' ? this.localVideoStream : null
  }

  public getRemoteScreenStreams(): Map<string, MediaStream> {
    return new Map(this.remoteScreenStreams)
  }

  // Screen share now routes through the single video slot: starting a share
  // while the camera is live stops the camera first (1 uplink max).
  // Stopping only clears the screen kind: a live camera is left untouched.
  public startScreenShare(): Promise<MediaStream | null> {
    return this.setVideoSource('screen')
  }

  public stopScreenShare(): Promise<void> {
    return this.runMediaOp(async () => {
      if (this.videoSource !== 'screen') return
      await this.teardownVideoSlot()
    })
  }

  // Serialized renegotiation (R1). Every addTrack/removeTrack path funnels
  // through this chain so exactly one createOffer→setLocalDescription is in
  // flight at a time. The chain survives failures; each task still settles
  // for its own caller so enable paths can roll back (R6).
  private renegotiateChain: Promise<void> = Promise.resolve()

  private renegotiate(): Promise<void> {
    const task = this.renegotiateChain.then(() => this.doRenegotiate())
    this.renegotiateChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doRenegotiate(): Promise<void> {
    if (!this.pc || this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[SfuClient] renegotiate: peer connection or signaling not ready')
    }

    if (!this.joinAcked) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(timer)
          reject(new Error('[SfuClient] renegotiate: timed out waiting for join acknowledgement'))
        }, 5000)
        const timer = setInterval(() => {
          if (this.isClosed || !this.pc) {
            clearInterval(timer)
            clearTimeout(deadline)
            reject(new Error('[SfuClient] renegotiate: closed while waiting for join acknowledgement'))
          } else if (this.joinAcked) {
            clearInterval(timer)
            clearTimeout(deadline)
            resolve()
          }
        }, 50)
      })
    }

    const pc = this.pc
    if (pc.signalingState && pc.signalingState !== 'stable') {
      // Bounded wait for the in-flight exchange to settle. On timeout fail
      // CLEANLY (caller rolls back) — never createOffer in a non-stable
      // state and corrupt the session. This explicitly INCLUDES
      // have-remote-offer: answering is applyDownstreamOffer's independent
      // job (message queue, not this chain), so it settles on its own and
      // unblocks us. Refusing here stranded toggles and killed recoverable
      // sessions instead.
      await new Promise<void>((resolve, reject) => {
        const onStable = () => {
          if (!this.pc || pc.signalingState === 'stable') {
            clearTimeout(timer)
            pc.removeEventListener('signalingstatechange', onStable)
            resolve()
          }
        }
        const timer = setTimeout(() => {
          pc.removeEventListener('signalingstatechange', onStable)
          reject(
            new Error(`[SfuClient] renegotiate timed out waiting for stable state (still ${pc.signalingState})`),
          )
        }, 3000)
        pc.addEventListener('signalingstatechange', onStable)
        onStable()
      })
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // No SDP rewriting: offers now only ever carry the pre-negotiated
    // m-sections (join offer, ICE-restart re-offers). Publisher kind is
    // signaled out-of-band via video/screen messages, never via msid.
    this.sendWsMessage({
      type: 'offer',
      sdp: offer.sdp,
    })
  }

  public disconnect(isExplicitLeave = true): void {
    if (this.isClosed) return
    this.isClosed = true

    if (isExplicitLeave && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.sendWsMessage({ type: 'leave' })
      } catch {}
    }

    this.cleanup()
    this.options.onConnectionStateChange?.('disconnected')
  }

  private cleanup(): void {
    this.queue = []
    this.stopStatsPolling()
    this.clearRecoveryTimers()
    if (this.recoveryWaiter) {
      const waiter = this.recoveryWaiter
      this.recoveryWaiter = null
      waiter.resolve(false)
    }
    this.recoveryInFlight = false
    this.restartAttempts = 0
    this.hasConnected = false
    this.joinAcked = false
    this.offerRetryAttempts = 0
    if (this.vadCleanup) {
      this.vadCleanup()
      this.vadCleanup = null
    }

    if (this.unlockAudioCleanup) {
      this.unlockAudioCleanup()
    }
    if (this.visibilityCleanup) {
      this.visibilityCleanup()
    }
    this.userToTrackMap.clear()

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop())
      this.localStream = null
    }

    if (this.localVideoTrack) {
      try {
        this.localVideoTrack.onended = null
      } catch {}
      this.localVideoTrack.stop()
      this.localVideoTrack = null
    }
    this.localVideoStream = null
    this.videoSender = null
    this.videoSource = 'off'
    this.remoteVideoStreams.clear()

    this.remoteScreenStreams.clear()
    this.midIndex.clear()
    this.screenRevoked.clear()
    this.lastDownstreamSdp = null
    this.remoteTrackKind.clear()
    this.remoteStreamByTrack.clear()

    for (const audioEl of this.audioElements.values()) {
      audioEl.srcObject = null
      audioEl.remove()
    }
    this.audioElements.clear()

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }

  // ICE restart + re-offer recovery (R10). restartIce() makes the next
  // offer carry fresh ICE credentials; renegotiate() re-offers every live
  // sender, so cam/screen tracks are re-announced to the SFU in one step.
  private async attemptRecovery(): Promise<void> {
    if (this.isClosed || !this.pc || this.recoveryInFlight || !this.hasConnected) return
    if (this.restartAttempts >= SfuClient.MAX_RESTARTS) {
      this.giveUp()
      return
    }
    this.recoveryInFlight = true
    this.restartAttempts += 1
    // Surfaced as connecting: the UI shows "reconnecting" instead of a leave.
    this.options.onConnectionStateChange?.('connecting')
    try {
      this.pc.restartIce()
      await this.renegotiate()
      if (this.isClosed) return
      const recovered = await this.waitForRecovery()
      if (this.isClosed) return
      if (recovered) {
        this.clearRecovery()
        this.options.onConnectionStateChange?.('connected')
      } else {
        this.giveUp()
      }
    } catch {
      this.giveUp()
    } finally {
      this.recoveryInFlight = false
    }
  }

  private waitForRecovery(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.recoveryWaiter = { resolve }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        const waiter = this.recoveryWaiter
        this.recoveryWaiter = null
        waiter?.resolve(false)
      }, this.options.reconnectTimeoutMs ?? 5000)
    })
  }

  private giveUp(): void {
    this.clearRecoveryTimers()
    this.recoveryWaiter = null
    if (!this.isClosed) {
      this.options.onConnectionStateChange?.('failed')
    }
  }

  private clearRecovery(): void {
    this.clearRecoveryTimers()
    this.recoveryWaiter = null
    this.restartAttempts = 0
  }

  private clearRecoveryTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private sendWsMessage(msg: Record<string, any>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}
