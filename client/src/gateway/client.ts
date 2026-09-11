import type {
  MemberAddPayload,
  MemberChunkPayload,
  MemberRemovePayload,
  Message,
  PresenceUpdatePayload,
  TypingStartPayload,
} from '../types'

export type GatewayStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'resuming'
  | 'reconnecting'

export type GatewayEventCallback = (data: any) => void

export const BASE_BACKOFF_MS = 2000
export const MAX_BACKOFF_MS = 30000

/**
 * Calculates exponential backoff with jitter.
 * delay = min(30000, 2000 * 2^attempt) + jitter(0, 1000)
 */
export function calculateBackoff(attempt: number, randomFn = Math.random): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt))
  const jitter = Math.floor(randomFn() * 1000)
  return Math.min(MAX_BACKOFF_MS, exp + jitter)
}

export function getGatewayUrl(): string {
  if (import.meta.env?.VITE_GATEWAY_WS) {
    return import.meta.env.VITE_GATEWAY_WS
  }
  if (typeof window === 'undefined') {
    return 'ws://localhost:4000/ws'
  }
  // If running directly on Vite dev server (port 5173), gateway is at port 4000
  if (window.location.port === '5173') {
    return `ws://${window.location.hostname}:4000/ws`
  }
  // If accessed through Caddy (port 80) or production reverse proxy
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

export interface ReconnectState {
  attempt: number
  countdownMs: number
}

/**
 * Idle threshold for the instant-wake heuristic: input after a gap of at least
 * this length sends op 3 online immediately. Must match the gateway's idle
 * sweeper threshold (plan/05 §1: 10 min default; VITE_IDLE_THRESHOLD_MS
 * overrides it — compose sets 120000 so idle is observable in ~2 min).
 */
const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000
const envIdleMs = Number(import.meta.env?.VITE_IDLE_THRESHOLD_MS)
export const IDLE_THRESHOLD_MS = Number.isFinite(envIdleMs) && envIdleMs > 0 ? envIdleMs : DEFAULT_IDLE_THRESHOLD_MS

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

/** Client-side typing trigger throttle — matches the gateway's 8s cooldown. */
export const TYPING_THROTTLE_MS = 8_000

export class GatewayClient {
  public ws: WebSocket | null = null
  private token: string | null = null
  private status: GatewayStatus = 'disconnected'
  private heartbeatIntervalMs: number | null = null
  private heartbeatTimer: any = null
  private lastHeartbeatAck = true
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private listeners: Map<string, Set<GatewayEventCallback>> = new Map()
  private statusListeners: Set<(status: GatewayStatus) => void> = new Set()
  private reconnectListeners: Set<(state: ReconnectState | null) => void> = new Set()
  private explicitDisconnect = false

  // Reconnect backoff state
  private reconnectAttempt = 0
  private reconnectTimeoutId: any = null
  private countdownIntervalId: any = null
  private targetReconnectTime: number | null = null

  // User activity tracking (plan/05 §1 idle detection): the heartbeat carries
  // last_activity so the gateway can mark the user idle after 10 min of no
  // input. Heartbeats alone (connection liveness) must not count as activity.
  private lastActivityAt: number = Date.now()
  private activityBound = false

  // Typing throttle state: channel_id -> last sent timestamp (ms)
  private typingLastSentAt: Map<string, number> = new Map()

  public getStatus(): GatewayStatus {
    return this.status
  }

  public getSessionId(): string | null {
    return this.sessionId
  }

  public getLastSeq(): number | null {
    return this.lastSeq
  }

  public getReconnectAttempt(): number {
    return this.reconnectAttempt
  }

  public onStatusChange(callback: (status: GatewayStatus) => void): () => void {
    this.statusListeners.add(callback)
    callback(this.status)
    return () => {
      this.statusListeners.delete(callback)
    }
  }

  public onReconnectChange(callback: (state: ReconnectState | null) => void): () => void {
    this.reconnectListeners.add(callback)
    callback(this.getReconnectState())
    return () => {
      this.reconnectListeners.delete(callback)
    }
  }

  private getReconnectState(): ReconnectState | null {
    if (this.status !== 'reconnecting' || !this.targetReconnectTime) {
      return null
    }
    const remaining = Math.max(0, this.targetReconnectTime - Date.now())
    return {
      attempt: this.reconnectAttempt,
      countdownMs: remaining,
    }
  }

  private notifyReconnectListeners() {
    const state = this.getReconnectState()
    for (const cb of this.reconnectListeners) {
      try {
        cb(state)
      } catch (err) {
        console.error('[Gateway] reconnect listener error:', err)
      }
    }
  }

  private setStatus(status: GatewayStatus) {
    if (this.status === status) return
    this.status = status
    for (const cb of this.statusListeners) {
      try {
        cb(status)
      } catch (err) {
        console.error('[Gateway] status listener error:', err)
      }
    }
    this.notifyReconnectListeners()
  }

  public on(event: string, callback: GatewayEventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)
    return () => {
      this.listeners.get(event)?.delete(callback)
    }
  }

  public onMessage(callback: (msg: Message) => void): () => void {
    return this.on('MESSAGE_CREATE', callback)
  }

  public onSessionReset(callback: () => void): () => void {
    return this.on('SESSION_RESET', callback)
  }

  public onReady(callback: () => void): () => void {
    return this.on('READY', callback)
  }

  public onMemberChunk(callback: (chunk: MemberChunkPayload) => void): () => void {
    return this.on('GUILD_MEMBERS_CHUNK', callback)
  }

  public onPresenceUpdate(callback: (update: PresenceUpdatePayload) => void): () => void {
    return this.on('PRESENCE_UPDATE', callback)
  }

  public onTypingStart(callback: (typing: TypingStartPayload) => void): () => void {
    return this.on('TYPING_START', callback)
  }

  public onGuildMemberAdd(callback: (payload: MemberAddPayload) => void): () => void {
    return this.on('GUILD_MEMBER_ADD', callback)
  }

  public onGuildMemberRemove(callback: (payload: MemberRemovePayload) => void): () => void {
    return this.on('GUILD_MEMBER_REMOVE', callback)
  }

  /**
   * Sends a TYPING_START trigger for a channel, client-throttled to one per
   * 8s per channel (matching the server-side (user, channel) cooldown —
   * excess frames are silently dropped there anyway). The frame intentionally
   * carries no `op` field: the gateway routes typing frames by `t`.
   * Returns true when sent, false when throttled.
   */
  public sendTyping(channelId: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false

    const now = Date.now()
    const last = this.typingLastSentAt.get(channelId)
    if (last !== undefined && now - last < TYPING_THROTTLE_MS) return false

    this.typingLastSentAt.set(channelId, now)
    this.ws.send(JSON.stringify({ t: 'TYPING_START', d: { channel_id: channelId } }))
    return true
  }

  /**
   * Sends Opcode 8 REQUEST_GUILD_MEMBERS. The server streams GUILD_MEMBERS_CHUNK
   * dispatches back; zero matches still emit one empty chunk (chunk_count 1) as
   * the done-signal. Only one in-flight request per connection — the server
   * silently ignores op 8 while a stream is still running.
   */
  public requestGuildMembers(
    guildId: string,
    opts?: { query?: string; limit?: number; presences?: boolean },
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gateway] requestGuildMembers skipped: socket not open')
      return
    }
    const payload = {
      op: 8,
      d: {
        guild_id: guildId,
        query: opts?.query ?? '',
        limit: opts?.limit ?? 0, // 0 = all
        presences: opts?.presences ?? true,
      },
    }
    this.ws.send(JSON.stringify(payload))
  }

  private emit(event: string, data?: any) {
    const callbacks = this.listeners.get(event)
    if (!callbacks) return
    for (const cb of callbacks) {
      try {
        cb(data)
      } catch (err) {
        console.error(`[Gateway] error in listener for ${event}:`, err)
      }
    }
  }

  public connect(token: string) {
    if (!token) {
      console.warn('[Gateway] cannot connect without token')
      return
    }

    // If already connecting, connected, or ready with the same token, do nothing
    if (
      this.ws &&
      this.token === token &&
      (this.status === 'connected' ||
        this.status === 'ready' ||
        this.status === 'resuming' ||
        this.status === 'connecting')
    ) {
      return
    }

    this.clearReconnectTimers()
    this.explicitDisconnect = false
    this.token = token
    this.bindActivityListeners()

    // Clean up previous socket if any before creating a new one
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }

    this.setStatus('connecting')

    const url = getGatewayUrl()
    console.log(`[Gateway] connecting to ${url} (hasSession=${!!this.sessionId}, lastSeq=${this.lastSeq})`)

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error('[Gateway] failed to create WebSocket:', err)
      this.handleConnectionFailure()
      return
    }

    this.ws.onopen = () => {
      console.log('[Gateway] socket open, awaiting HELLO (op 10)...')
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data)
    }

    this.ws.onerror = (err) => {
      console.error('[Gateway] socket error:', err)
    }

    this.ws.onclose = (event) => {
      console.log(`[Gateway] socket closed (code=${event.code}, reason=${event.reason})`)
      this.cleanupHeartbeat()

      // Fatal authentication error (4004) -> stop reconnecting
      if (event.code === 4004) {
        console.warn('[Gateway] fatal auth failure (4004), clearing session and stopping reconnect')
        this.sessionId = null
        this.lastSeq = null
        this.token = null
        this.setStatus('disconnected')
        return
      }

      // If close was explicitly requested by user/logout, don't reconnect
      if (this.explicitDisconnect) {
        this.setStatus('disconnected')
        return
      }

      // Start exponential backoff reconnect
      this.scheduleReconnect()
    }
  }

  /**
   * Immediately retries connection without waiting for the backoff timer.
   */
  public reconnectNow() {
    if (!this.token) return
    console.log('[Gateway] manual reconnectNow triggered')
    this.clearReconnectTimers()
    this.connect(this.token)
  }

  public disconnect() {
    this.explicitDisconnect = true
    this.clearReconnectTimers()
    this.cleanupHeartbeat()
    this.sessionId = null
    this.lastSeq = null
    this.reconnectAttempt = 0

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  private scheduleReconnect() {
    this.clearReconnectTimers()

    const delay = calculateBackoff(this.reconnectAttempt)
    this.reconnectAttempt++
    this.targetReconnectTime = Date.now() + delay

    console.log(`[Gateway] scheduling reconnect attempt #${this.reconnectAttempt} in ${delay}ms`)
    this.setStatus('reconnecting')

    // Periodic countdown tick (every 200ms) for UI countdown
    this.countdownIntervalId = setInterval(() => {
      this.notifyReconnectListeners()
    }, 200)

    this.reconnectTimeoutId = setTimeout(() => {
      this.clearReconnectTimers()
      if (!this.explicitDisconnect && this.token) {
        this.connect(this.token)
      }
    }, delay)
  }

  private clearReconnectTimers() {
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
    if (this.countdownIntervalId !== null) {
      clearInterval(this.countdownIntervalId)
      this.countdownIntervalId = null
    }
    this.targetReconnectTime = null
    this.notifyReconnectListeners()
  }

  private handleConnectionFailure() {
    this.cleanupHeartbeat()
    if (!this.explicitDisconnect && this.token) {
      this.scheduleReconnect()
    } else {
      this.setStatus('disconnected')
    }
  }

  private handleMessage(raw: any) {
    let packet: any
    try {
      packet = JSON.parse(raw)
    } catch (err) {
      console.error('[Gateway] failed to parse incoming frame:', err, raw)
      return
    }

    const { op, d, s, t } = packet

    // Track sequence number if present on dispatch frame
    if (typeof s === 'number') {
      this.lastSeq = s
    }

    switch (op) {
      case 10: // HELLO
        this.handleHello(d)
        break

      case 11: // HEARTBEAT_ACK
        this.lastHeartbeatAck = true
        break

      case 1: // Heartbeat requested by server
        this.sendHeartbeat()
        break

      case 0: // DISPATCH
        this.handleDispatch(t, d)
        break

      case 9: // INVALID_SESSION
        this.handleInvalidSession()
        break

      default:
        console.log(`[Gateway] unhandled opcode ${op}:`, packet)
    }
  }

  private handleHello(data: { heartbeat_interval: number }) {
    console.log(`[Gateway] received HELLO: heartbeat_interval=${data.heartbeat_interval}ms`)
    this.heartbeatIntervalMs = data.heartbeat_interval
    this.lastHeartbeatAck = true

    // Start periodic heartbeat
    this.startHeartbeat()

    // If we have an active session and lastSeq, attempt RESUME (op 6)
    if (this.sessionId && this.lastSeq !== null) {
      this.sendResume()
    } else {
      // Otherwise perform fresh IDENTIFY (op 2)
      this.sendIdentify()
    }
  }

  private sendResume() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.token || !this.sessionId) return

    console.log(`[Gateway] sending RESUME (op 6): session_id=${this.sessionId}, seq=${this.lastSeq}`)
    this.setStatus('resuming')

    const resumePayload = {
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    }
    this.ws.send(JSON.stringify(resumePayload))
  }

  private sendIdentify() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.token) return

    console.log('[Gateway] sending IDENTIFY (op 2)...')
    const identifyPayload = {
      op: 2,
      d: {
        token: this.token,
        properties: {
          os: 'browser',
          browser: 'kith-web',
          device: 'kith-web',
        },
      },
    }
    this.ws.send(JSON.stringify(identifyPayload))
    this.setStatus('connected')
  }

  private handleInvalidSession() {
    console.warn('[Gateway] received INVALID_SESSION (op 9) — session cannot be resumed')
    // Clear dead session
    this.sessionId = null
    this.lastSeq = null

    // Notify listeners so UI can trigger full state refetch
    this.emit('SESSION_RESET')

    // Perform fresh IDENTIFY
    this.sendIdentify()
  }

  private startHeartbeat() {
    this.cleanupHeartbeat()
    if (!this.heartbeatIntervalMs) return

    // Jitter first heartbeat slightly per Discord gateway spec
    const initialDelay = Math.floor(Math.random() * (this.heartbeatIntervalMs * 0.5))
    this.heartbeatTimer = setTimeout(() => {
      this.sendHeartbeat()
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat()
      }, this.heartbeatIntervalMs!)
    }, initialDelay)
  }

  private sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    if (!this.lastHeartbeatAck) {
      console.warn('[Gateway] missed HEARTBEAT_ACK from previous interval')
    }

    this.lastHeartbeatAck = false
    // d carries the user's last real input time — the gateway refreshes
    // presence activity from it and sweeps to idle when it goes stale.
    this.ws.send(JSON.stringify({ op: 1, d: { seq: this.lastSeq, last_activity: this.lastActivityAt } }))
  }

  /**
   * Declares a presence status (op 3). Used to wake from idle instantly on
   * user input instead of waiting for the next heartbeat to carry activity.
   */
  public sendStatusUpdate(status: 'online' | 'idle' | 'dnd' | 'invisible', opts?: { since?: number; afk?: boolean }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const d: Record<string, unknown> = { status }
    if (opts?.since !== undefined) d.since = opts.since
    if (opts?.afk !== undefined) d.afk = opts.afk
    this.ws.send(JSON.stringify({ op: 3, d }))
  }

  /**
   * Records a user input event. Exposed for tests. When input arrives after
   * an idle-length gap, immediately declares online (op 3) so other clients
   * see the wake without waiting for the next heartbeat.
   */
  public noteUserActivity(at: number = Date.now()) {
    const wasIdle = at - this.lastActivityAt >= IDLE_THRESHOLD_MS
    this.lastActivityAt = at
    if (wasIdle) {
      this.sendStatusUpdate('online', { since: at, afk: false })
    }
  }

  private bindActivityListeners() {
    if (this.activityBound || typeof window === 'undefined') return
    this.activityBound = true
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, () => this.noteUserActivity(), { passive: true })
    }
  }

  private cleanupHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleDispatch(type: string, data: any) {
    if (type === 'READY') {
      this.sessionId = data.session_id
      this.reconnectAttempt = 0
      console.log(`[Gateway] READY received! session_id=${this.sessionId}, user=${data.user?.username}`)
      this.setStatus('ready')
    } else if (this.status === 'resuming') {
      // Replayed dispatch on successful resume
      this.reconnectAttempt = 0
      this.setStatus('ready')
    }

    this.emit(type, data)
  }
}

// Global singleton instance for the browser session
export const gatewayClient = new GatewayClient()

// Development testing helpers on window
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  ;(window as any).gatewayClient = gatewayClient
}
