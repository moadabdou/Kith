import type { Message } from '../types'

export type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export type GatewayEventCallback = (data: any) => void

export function getGatewayUrl(): string {
  if (import.meta.env.VITE_GATEWAY_WS) {
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

export class GatewayClient {
  private ws: WebSocket | null = null
  private token: string | null = null
  private status: GatewayStatus = 'disconnected'
  private heartbeatIntervalMs: number | null = null
  private heartbeatTimer: number | null = null
  private lastHeartbeatAck = true
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private listeners: Map<string, Set<GatewayEventCallback>> = new Map()
  private statusListeners: Set<(status: GatewayStatus) => void> = new Set()
  private explicitDisconnect = false

  public getStatus(): GatewayStatus {
    return this.status
  }

  public getSessionId(): string | null {
    return this.sessionId
  }

  public getLastSeq(): number | null {
    return this.lastSeq
  }

  public onStatusChange(callback: (status: GatewayStatus) => void): () => void {
    this.statusListeners.add(callback)
    callback(this.status)
    return () => {
      this.statusListeners.delete(callback)
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

  private emit(event: string, data: any) {
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

    // If already connected with the same token, do nothing
    if (this.ws && this.token === token && (this.status === 'connected' || this.status === 'ready')) {
      return
    }

    this.disconnect()
    this.explicitDisconnect = false
    this.token = token
    this.setStatus('connecting')

    const url = getGatewayUrl()
    console.log(`[Gateway] connecting to ${url}`)

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      console.error('[Gateway] failed to create WebSocket:', err)
      this.setStatus('disconnected')
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
      this.setStatus('disconnected')

      // Auto-reconnect if not explicit disconnect and not fatal auth error (4004)
      if (!this.explicitDisconnect && event.code !== 4004 && this.token) {
        window.setTimeout(() => {
          if (!this.explicitDisconnect && this.token) {
            this.connect(this.token)
          }
        }, 2000)
      }
    }
  }

  public disconnect() {
    this.explicitDisconnect = true
    this.cleanupHeartbeat()
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

  private handleMessage(raw: any) {
    let packet: any
    try {
      packet = JSON.parse(raw)
    } catch (err) {
      console.error('[Gateway] failed to parse incoming frame:', err, raw)
      return
    }

    const { op, d, s, t } = packet

    // Track sequence number if present on dispatch
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
        console.warn('[Gateway] received INVALID_SESSION (op 9)')
        this.sessionId = null
        this.lastSeq = null
        // Re-identify
        this.sendIdentify()
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

    // Send IDENTIFY (op 2)
    this.sendIdentify()
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
          device: 'kith-web'
        }
      }
    }
    this.ws.send(JSON.stringify(identifyPayload))
    this.setStatus('connected')
  }

  private startHeartbeat() {
    this.cleanupHeartbeat()
    if (!this.heartbeatIntervalMs) return

    // Jitter first heartbeat slightly per Discord gateway spec
    const initialDelay = Math.floor(Math.random() * (this.heartbeatIntervalMs * 0.5))
    this.heartbeatTimer = window.setTimeout(() => {
      this.sendHeartbeat()
      this.heartbeatTimer = window.setInterval(() => {
        this.sendHeartbeat()
      }, this.heartbeatIntervalMs!)
    }, initialDelay)
  }

  private sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    if (!this.lastHeartbeatAck) {
      console.warn('[Gateway] missed HEARTBEAT_ACK, connection may be zombie; closing...')
      this.ws.close(4009, 'Heartbeat timeout')
      return
    }

    this.lastHeartbeatAck = false
    this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }))
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
      console.log(`[Gateway] READY received! session_id=${this.sessionId}, user=${data.user?.username}`)
      this.setStatus('ready')
    }

    this.emit(type, data)
  }
}

// Global singleton instance for the browser session
export const gatewayClient = new GatewayClient()
