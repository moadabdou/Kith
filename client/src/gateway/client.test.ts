import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GatewayClient, calculateBackoff, BASE_BACKOFF_MS, MAX_BACKOFF_MS } from './client'

class MockWebSocket {
  public static instances: MockWebSocket[] = []
  public url: string
  public readyState: number = WebSocket.OPEN
  public sentData: string[] = []

  public onopen: (() => void) | null = null
  public onmessage: ((event: { data: any }) => void) | null = null
  public onerror: ((err: any) => void) | null = null
  public onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  public send(data: string) {
    this.sentData.push(data)
  }

  public close(code = 1000, reason = '') {
    this.readyState = WebSocket.CLOSED
    if (this.onclose) {
      this.onclose({ code, reason })
    }
  }

  // Helper to simulate incoming server message
  public receiveJson(payload: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(payload) })
    }
  }
}

describe('Gateway Client Reconnection & RESUME (#26)', () => {
  let originalWebSocket: any

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as any
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  describe('calculateBackoff', () => {
    it('calculates exponential doubling with jitter', () => {
      const fixedRandom = () => 0.5 // 500ms jitter

      // Attempt 0: 2000 + 500 = 2500ms
      expect(calculateBackoff(0, fixedRandom)).toBe(2500)

      // Attempt 1: 4000 + 500 = 4500ms
      expect(calculateBackoff(1, fixedRandom)).toBe(4500)

      // Attempt 2: 8000 + 500 = 8500ms
      expect(calculateBackoff(2, fixedRandom)).toBe(8500)

      // Attempt 3: 16000 + 500 = 16500ms
      expect(calculateBackoff(3, fixedRandom)).toBe(16500)

      // Attempt 4: capped at 30000ms
      expect(calculateBackoff(4, fixedRandom)).toBe(30000)

      // Attempt 10: stays capped at 30000ms
      expect(calculateBackoff(10, fixedRandom)).toBe(30000)
    })

    it('stays within [base, max] bounds across any jitter', () => {
      for (let i = 0; i < 20; i++) {
        const delay0 = calculateBackoff(0)
        expect(delay0).toBeGreaterThanOrEqual(BASE_BACKOFF_MS)
        expect(delay0).toBeLessThanOrEqual(BASE_BACKOFF_MS + 1000)

        const delayMax = calculateBackoff(10)
        expect(delayMax).toBe(MAX_BACKOFF_MS)
      }
    })
  })

  describe('Session Lifecycle & Sequence Tracking', () => {
    it('sends IDENTIFY (op 2) on initial connection', () => {
      const client = new GatewayClient()
      client.connect('mock-jwt-token')

      expect(MockWebSocket.instances.length).toBe(1)
      const ws = MockWebSocket.instances[0]

      // Server sends HELLO (op 10)
      ws.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })

      // Client should send IDENTIFY (op 2)
      expect(ws.sentData.length).toBe(1)
      const identify = JSON.parse(ws.sentData[0])
      expect(identify.op).toBe(2)
      expect(identify.d.token).toBe('mock-jwt-token')
      expect(client.getStatus()).toBe('connected')
    })

    it('tracks lastSeq on incoming dispatch packets and sets session_id on READY', () => {
      const client = new GatewayClient()
      client.connect('mock-jwt-token')
      const ws = MockWebSocket.instances[0]

      ws.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })

      // Server sends READY dispatch with session_id
      ws.receiveJson({
        op: 0,
        s: 1,
        t: 'READY',
        d: { session_id: 'sess_12345', user: { username: 'alice' }, guilds: [] },
      })

      expect(client.getSessionId()).toBe('sess_12345')
      expect(client.getLastSeq()).toBe(1)
      expect(client.getStatus()).toBe('ready')

      // Server sends message dispatch with s = 5
      ws.receiveJson({
        op: 0,
        s: 5,
        t: 'MESSAGE_CREATE',
        d: { id: 'm1', content: 'hello' },
      })

      expect(client.getLastSeq()).toBe(5)
    })
  })

  describe('Reconnection & RESUME (op 6)', () => {
    it('sends RESUME (op 6) with session_id and seq on unexpected disconnect', () => {
      const client = new GatewayClient()
      client.connect('mock-jwt-token')
      const ws1 = MockWebSocket.instances[0]

      // Initial identify and ready
      ws1.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })
      ws1.receiveJson({
        op: 0,
        s: 7,
        t: 'READY',
        d: { session_id: 'sess_reconnect', user: { username: 'bob' }, guilds: [] },
      })

      expect(client.getSessionId()).toBe('sess_reconnect')
      expect(client.getLastSeq()).toBe(7)

      // Simulate connection drop (e.g. gateway restart / network blip)
      ws1.close(1006, 'Abnormal closure')
      expect(client.getStatus()).toBe('reconnecting')
      expect(client.getReconnectAttempt()).toBe(1)

      // Fast-forward fake timers past backoff duration (up to 3000ms for attempt 0)
      vi.advanceTimersByTime(3500)

      // A new WebSocket should have been created
      expect(MockWebSocket.instances.length).toBe(2)
      const ws2 = MockWebSocket.instances[1]

      // Gateway sends HELLO (op 10) to new connection
      ws2.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })

      // Client should send RESUME (op 6) instead of IDENTIFY (op 2)
      expect(ws2.sentData.length).toBe(1)
      const resume = JSON.parse(ws2.sentData[0])
      expect(resume.op).toBe(6)
      expect(resume.d).toEqual({
        token: 'mock-jwt-token',
        session_id: 'sess_reconnect',
        seq: 7,
      })
      expect(client.getStatus()).toBe('resuming')

      // Replayed dispatch transitions status to ready
      ws2.receiveJson({
        op: 0,
        s: 8,
        t: 'MESSAGE_CREATE',
        d: { id: 'm2', content: 'replayed message' },
      })

      expect(client.getStatus()).toBe('ready')
      expect(client.getLastSeq()).toBe(8)
      expect(client.getReconnectAttempt()).toBe(0)
    })

    it('supports immediate manual retry via reconnectNow()', () => {
      const client = new GatewayClient()
      client.connect('mock-jwt-token')
      const ws1 = MockWebSocket.instances[0]

      ws1.close(1006, 'Abnormal closure')
      expect(client.getStatus()).toBe('reconnecting')

      // Manually trigger retry without waiting for backoff timer
      client.reconnectNow()

      expect(MockWebSocket.instances.length).toBe(2)
      expect(client.getStatus()).toBe('connecting')
    })
  })

  describe('INVALID_SESSION (op 9) Handling', () => {
    it('resets session_id, notifies SESSION_RESET, and falls back to IDENTIFY (op 2)', () => {
      const client = new GatewayClient()
      const onReset = vi.fn()
      client.onSessionReset(onReset)

      client.connect('mock-jwt-token')
      const ws1 = MockWebSocket.instances[0]

      ws1.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })
      ws1.receiveJson({
        op: 0,
        s: 12,
        t: 'READY',
        d: { session_id: 'expired_sess', user: { username: 'charlie' }, guilds: [] },
      })

      // Simulate reconnect
      ws1.close(1006, 'Abnormal closure')
      vi.advanceTimersByTime(3500)

      const ws2 = MockWebSocket.instances[1]
      ws2.receiveJson({ op: 10, d: { heartbeat_interval: 30000 } })
      expect(JSON.parse(ws2.sentData[0]).op).toBe(6) // RESUME

      // Server rejects resume with INVALID_SESSION (op 9)
      ws2.receiveJson({ op: 9, d: false })

      // Session should be cleared
      expect(client.getSessionId()).toBeNull()
      expect(client.getLastSeq()).toBeNull()
      expect(onReset).toHaveBeenCalledTimes(1)

      // Client falls back to IDENTIFY (op 2)
      expect(ws2.sentData.length).toBe(2)
      const fallbackIdentify = JSON.parse(ws2.sentData[1])
      expect(fallbackIdentify.op).toBe(2)
      expect(fallbackIdentify.d.token).toBe('mock-jwt-token')
    })
  })

  describe('Fatal Auth & Explicit Disconnect', () => {
    it('does not reconnect on 4004 Authentication Failed', () => {
      const client = new GatewayClient()
      client.connect('bad-token')
      const ws = MockWebSocket.instances[0]

      ws.close(4004, 'Authentication failed')

      expect(client.getStatus()).toBe('disconnected')
      vi.advanceTimersByTime(60000)

      // No new WebSocket instances created
      expect(MockWebSocket.instances.length).toBe(1)
    })

    it('does not reconnect when disconnect() is explicitly called', () => {
      const client = new GatewayClient()
      client.connect('mock-jwt-token')
      expect(MockWebSocket.instances.length).toBe(1)

      client.disconnect()
      expect(client.getStatus()).toBe('disconnected')

      vi.advanceTimersByTime(60000)
      expect(MockWebSocket.instances.length).toBe(1)
    })
  })
})
