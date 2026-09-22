import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  collectInboundVideoStats,
  SfuClient,
  resolveSfuWsUrl,
  parseScreenMidsFromSdp,
  STATS_POLL_INTERVAL_MS,
} from './sfu-client'

describe('resolveSfuWsUrl', () => {
  it('resolves raw host:port endpoint to ws://', () => {
    expect(resolveSfuWsUrl('127.0.0.1:5000')).toBe('ws://127.0.0.1:5000/ws')
    expect(resolveSfuWsUrl('sfu.example.com:443')).toBe('ws://sfu.example.com:443/ws')
    expect(resolveSfuWsUrl('sfu.kith.local:7000')).toBe('ws://sfu.kith.local:7000/ws')
  })

  it('preserves existing ws:// or wss:// protocols and appends /ws', () => {
    expect(resolveSfuWsUrl('ws://custom-host:5000')).toBe('ws://custom-host:5000/ws')
    expect(resolveSfuWsUrl('wss://secure-host:5000/ws')).toBe('wss://secure-host:5000/ws')
  })

  it('maps https:// to wss:// and http:// to ws://', () => {
    expect(resolveSfuWsUrl('https://sfu.prod.io:7000')).toBe('wss://sfu.prod.io:7000/ws')
    expect(resolveSfuWsUrl('http://sfu.dev.io:5000')).toBe('ws://sfu.dev.io:5000/ws')
  })

  it('rewrites local dev endpoints to window.location.hostname when in browser', () => {
    vi.stubGlobal('window', {
      location: {
        hostname: '192.168.1.50',
        protocol: 'http:',
      },
    })

    expect(resolveSfuWsUrl('127.0.0.1:5000')).toBe('ws://192.168.1.50:5000/ws')
    expect(resolveSfuWsUrl('localhost:5000')).toBe('ws://192.168.1.50:5000/ws')
    expect(resolveSfuWsUrl('sfu.kith.local:7000')).toBe('ws://192.168.1.50:7000/ws')

    vi.unstubAllGlobals()
  })
})

describe('SfuClient', () => {
  let mockWs: any
  let mockPc: any
  let mockLocalStream: any
  let mockAudioTrack: any
  let mockVideoSender: any

  beforeEach(() => {
    mockAudioTrack = {
      id: 'track-1',
      enabled: true,
      stop: vi.fn(),
      onended: null,
    }

    mockLocalStream = {
      getAudioTracks: vi.fn(() => [mockAudioTrack]),
      getTracks: vi.fn(() => [mockAudioTrack]),
    }

    // Mock navigator.mediaDevices.getUserMedia
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockLocalStream),
      },
    })

    // Mock WebSocket
    mockWs = {
      readyState: 1, // OPEN
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    }

    class MockWebSocket {
      static OPEN = 1
      static CONNECTING = 0
      static CLOSED = 3

      constructor() {
        setTimeout(() => {
          if (mockWs.onopen) mockWs.onopen({})
        }, 0)
        return mockWs
      }
    }
    vi.stubGlobal('WebSocket', MockWebSocket)

    // Mock RTCPeerConnection. The pre-negotiated sendonly video transceiver
    // (negotiate-once slot) resolves to mockVideoSender on every connect.
    // Sender parameters are stateful (mirrors a real sender): setParameters
    // applies, getParameters reflects.
    const senderParams: any = {
      degradationPreference: '',
      encodings: [
        { rid: 'f', active: true },
        { rid: 'h', active: true },
        { rid: 'q', active: true },
      ],
    }
    mockVideoSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
      getParameters: vi.fn(() => senderParams),
      setParameters: vi.fn().mockImplementation(async (p: any) => {
        if (p?.encodings) senderParams.encodings = p.encodings
        if ('degradationPreference' in (p ?? {})) senderParams.degradationPreference = p.degradationPreference
      }),
    }
    // Mock RTCPeerConnection
    mockPc = {
      connectionState: 'new',
      remoteDescription: null,
      signalingState: 'stable',
      onicecandidate: null,
      onconnectionstatechange: null,
      ontrack: null,
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      addTransceiver: vi.fn().mockReturnValue({ sender: mockVideoSender }),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      createOffer: vi.fn().mockResolvedValue({ sdp: 'v=0 local-offer' }),
      createAnswer: vi.fn().mockResolvedValue({ sdp: 'v=0 local-answer' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockImplementation(async (desc: any) => {
        mockPc.remoteDescription = desc
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      restartIce: vi.fn(),
      close: vi.fn(),
    }

    class MockRTCPeerConnection {
      constructor() {
        return mockPc
      }
    }
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection)

    // Mock RTCIceCandidate
    class MockRTCIceCandidate {
      candidate: any
      constructor(init: any) {
        this.candidate = init
        return init
      }
    }
    vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate)

    // Mock MediaStream
    class MockMediaStream {
      private tracks: any[]
      constructor(tracks: any[] = []) {
        this.tracks = tracks
      }
      getAudioTracks() {
        return this.tracks
      }
      getTracks() {
        return this.tracks
      }
    }
    vi.stubGlobal('MediaStream', MockMediaStream)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('connects, initializes WebRTC, and sends join message with token', async () => {
    const onStateChange = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      guildId: 'guild-1',
      onConnectionStateChange: onStateChange,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    expect(onStateChange).toHaveBeenCalledWith('connecting')

    // Verified join message sent
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'join',
        token: 'jwt-token-123',
        channel_id: 'voice-chan-1',
        guild_id: 'guild-1',
        listen_only: false,
      })
    )

    // Verified local offer was created and sent
    expect(mockPc.createOffer).toHaveBeenCalled()
    expect(mockPc.setLocalDescription).toHaveBeenCalledWith({ sdp: 'v=0 local-offer' })
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'offer',
        sdp: 'v=0 local-offer',
      })
    )

    client.disconnect()
  })

  it('handles SFU answer and joined confirmation', async () => {
    const onStateChange = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onStateChange,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Receive joined
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    expect(onStateChange).toHaveBeenCalledWith('connected')

    // Receive answer
    await mockWs.onmessage({
      data: JSON.stringify({ type: 'answer', sdp: 'v=0 remote-answer' }),
    })
    expect(mockPc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0 remote-answer',
    })

    client.disconnect()
  })

  it('handles downstream renegotiation offer from SFU and replies with answer', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // SFU sends renegotiation offer
    await mockWs.onmessage({
      data: JSON.stringify({ type: 'offer', sdp: 'v=0 sfu-renegotiation-offer' }),
    })

    expect(mockPc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'v=0 sfu-renegotiation-offer',
    })
    expect(mockPc.createAnswer).toHaveBeenCalled()
    expect(mockPc.setLocalDescription).toHaveBeenCalledWith({ sdp: 'v=0 local-answer' })
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'answer',
        sdp: 'v=0 local-answer',
      })
    )

    client.disconnect()
  })

  it('queues ICE candidates before remoteDescription and drains them upon remoteDescription set', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Candidate arrives while remoteDescription is null
    expect(mockPc.remoteDescription).toBeNull()
    await mockWs.onmessage({
      data: JSON.stringify({
        type: 'candidate',
        candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.1 5000 typ host', sdpMid: '0' },
      }),
    })
    // Not added yet because remote description is not set
    expect(mockPc.addIceCandidate).not.toHaveBeenCalled()

    // Now SFU answer arrives and sets remoteDescription
    await mockWs.onmessage({
      data: JSON.stringify({ type: 'answer', sdp: 'v=0 remote-answer' }),
    })

    // Queued candidate is now drained and added
    expect(mockPc.addIceCandidate).toHaveBeenCalledTimes(1)

    // Subsequent candidate arrives after remote description is set -> added immediately
    await mockWs.onmessage({
      data: JSON.stringify({
        type: 'candidate',
        candidate: { candidate: 'candidate:2 1 UDP 2122260223 192.168.1.2 5001 typ host', sdpMid: '0' },
      }),
    })
    expect(mockPc.addIceCandidate).toHaveBeenCalledTimes(2)

    client.disconnect()
  })

  it('forwards local ICE candidates over WebSocket', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const mockCandidate = {
      candidate: 'candidate:local 1 UDP 2122260223 10.0.0.1 5000 typ host',
      toJSON: () => ({ candidate: 'candidate:local 1 UDP 2122260223 10.0.0.1 5000 typ host' }),
    }

    // Trigger local ice candidate event
    mockPc.onicecandidate({ candidate: mockCandidate })

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'candidate',
        candidate: { candidate: 'candidate:local 1 UDP 2122260223 10.0.0.1 5000 typ host' },
      })
    )

    client.disconnect()
  })

  it('handles remote audio track and plays out through HTMLAudioElement', async () => {
    const onRemoteTrack = vi.fn()
    const mockAudioEl = {
      autoplay: false,
      muted: false,
      srcObject: null as any,
      style: {} as any,
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      setAttribute: vi.fn(),
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag) => {
        if (tag === 'audio') return mockAudioEl
        return {}
      }),
      body: {
        appendChild: vi.fn(),
      },
    })

    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteTrack,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const remoteTrack: any = { id: 'remote-track-1', onended: null }
    const remoteStream: any = { id: 'remote-stream-1' }

    mockPc.ontrack({ track: remoteTrack, streams: [remoteStream] })

    expect(onRemoteTrack).toHaveBeenCalledWith(remoteTrack, remoteStream)
    expect(mockAudioEl.autoplay).toBe(true)
    expect(mockAudioEl.srcObject).toBe(remoteStream)
    expect(document.body.appendChild).toHaveBeenCalledWith(mockAudioEl)
    expect(mockAudioEl.play).toHaveBeenCalled()

    // Test deafen mute toggle
    client.setDeaf(true)
    expect(mockAudioEl.muted).toBe(true)

    client.setDeaf(false)
    expect(mockAudioEl.muted).toBe(false)

    // Test track ended cleanup
    remoteTrack.onended()
    expect(mockAudioEl.remove).toHaveBeenCalled()

    client.disconnect()
  })

  it('falls back gracefully to listen-only mode when mic capture is unavailable', async () => {
    // Simulate getUserMedia throwing error (permission denied)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('Permission denied')),
      },
    })

    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    // Connect should not throw, should fall back to listen_only: true
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'join',
        token: 'jwt-token-123',
        channel_id: 'voice-chan-1',
        guild_id: undefined,
        listen_only: true,
      })
    )

    // In listen-only mode, local offer is not published
    expect(mockPc.createOffer).not.toHaveBeenCalled()

    client.disconnect()
  })

  it('dispatches speaking events from SFU', async () => {
    const onSpeaking = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onSpeakingChange: onSpeaking,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // SFU sends speaking = true
    await mockWs.onmessage({
      data: JSON.stringify({
        type: 'speaking',
        user_id: 'user-bob',
        speaking: true,
      }),
    })

    expect(onSpeaking).toHaveBeenCalledWith('user-bob', true)

    // SFU sends speaking = false
    await mockWs.onmessage({
      data: JSON.stringify({
        type: 'speaking',
        user_id: 'user-bob',
        speaking: false,
      }),
    })

    expect(onSpeaking).toHaveBeenCalledWith('user-bob', false)

    client.disconnect()
  })

  it('handles SFU error messages and WebSocket errors', async () => {
    const onError = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onError,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // SFU sends error message
    await mockWs.onmessage({
      data: JSON.stringify({ type: 'error', message: 'Room channel is full' }),
    })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Room channel is full' }))

    // WebSocket error
    mockWs.onerror({ message: 'network failure' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'SFU WebSocket error' }))

    client.disconnect()
  })

  it('reports RTCPeerConnection state transitions', async () => {
    const onStateChange = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onStateChange,
      reconnectGraceMs: 20,
      reconnectTimeoutMs: 50,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'

    // Transition to connected
    mockPc.connectionState = 'connected'
    mockPc.onconnectionstatechange()
    expect(onStateChange).toHaveBeenCalledWith('connected')

    // Transition to failed → recovery starts (connecting), then recovers
    // instead of surfacing a leave.
    mockPc.connectionState = 'failed'
    mockPc.onconnectionstatechange()
    expect(onStateChange).toHaveBeenCalledWith('connecting')
    mockPc.connectionState = 'connected'
    mockPc.onconnectionstatechange()
    await new Promise((r) => setTimeout(r, 20))
    expect(onStateChange).toHaveBeenCalledWith('connected')
    expect(onStateChange).not.toHaveBeenCalledWith('failed')

    // Transition to disconnected → debounced while transient, never forwarded.
    onStateChange.mockClear()
    mockPc.connectionState = 'disconnected'
    mockPc.onconnectionstatechange()
    expect(onStateChange).not.toHaveBeenCalledWith('disconnected')
    mockPc.connectionState = 'connected'
    mockPc.onconnectionstatechange()
    await new Promise((r) => setTimeout(r, 30))
    expect(onStateChange).not.toHaveBeenCalledWith('disconnected')
    expect(onStateChange).not.toHaveBeenCalledWith('failed')

    client.disconnect()
  })

  it('toggles microphone mute and deafen state', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Initial state: unmuted
    expect(mockAudioTrack.enabled).toBe(true)

    // Mute microphone
    client.setMute(true)
    expect(mockAudioTrack.enabled).toBe(false)
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'speaking', speaking: false })
    )

    // Unmute microphone
    client.setMute(false)
    expect(mockAudioTrack.enabled).toBe(true)

    client.disconnect()
  })

  it('cleans up resources on disconnect', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    client.disconnect()

    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'leave' }))
    expect(mockAudioTrack.stop).toHaveBeenCalled()
    expect(mockPc.close).toHaveBeenCalled()
    expect(mockWs.close).toHaveBeenCalled()
  })

  it('connect pre-negotiates a sendonly video transceiver in the join offer', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Negotiate-once: the video slot exists from join, before any toggle,
    // declaring the 3 simulcast send encodings (issue #80).
    expect(mockPc.addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'sendonly',
      sendEncodings: [
        { rid: 'f', maxBitrate: 2_500_000 },
        { rid: 'h', maxBitrate: 500_000, scaleResolutionDownBy: 2 },
        { rid: 'q', maxBitrate: 150_000, scaleResolutionDownBy: 4 },
      ],
    })
    expect((client as any).videoSender).toBe(mockVideoSender)
    // Exactly one offer per session so far (the join offer).
    expect(mockPc.createOffer).toHaveBeenCalledTimes(1)

    client.disconnect()
  })

  it('screen switch activates f-only encodings with 720p30 capture, cam restores all', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-sim', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream-sim',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    const screenTrack: any = { id: 'screen-sim', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream-sim',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    const getDisplayMediaMock = vi.fn().mockResolvedValue(screenStream)
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    ;(navigator.mediaDevices as any).getDisplayMedia = getDisplayMediaMock
    mockPc.createOffer.mockClear()
    mockVideoSender.setParameters.mockClear()

    // Screen: 720p30 capture requested, only f stays active, resolution
    // pinned (P1) — no offers.
    await client.setVideoSource('screen')
    expect(getDisplayMediaMock).toHaveBeenCalledWith({
      video: {
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
    expect(mockVideoSender.setParameters).toHaveBeenCalledTimes(1)
    const screenParams = mockVideoSender.setParameters.mock.calls[0][0]
    expect(screenParams.encodings).toEqual([
      { rid: 'f', active: true },
      { rid: 'h', active: false },
      { rid: 'q', active: false },
    ])
    expect(screenParams.degradationPreference).toBe('maintain-resolution')
    expect(mockPc.createOffer).not.toHaveBeenCalled()

    // Back to cam: all layers reactivated, preference reset to default —
    // still no offers.
    mockVideoSender.setParameters.mockClear()
    await client.setVideoSource('camera')
    expect(mockVideoSender.setParameters).toHaveBeenCalledTimes(1)
    const camParams = mockVideoSender.setParameters.mock.calls[0][0]
    expect(camParams.encodings.every((e: any) => e.active !== false)).toBe(true)
    expect(camParams.degradationPreference ?? '').toBe('')
    expect(mockPc.createOffer).not.toHaveBeenCalled()

    client.disconnect()
  })

  it('P1: setParameters rejection keeps previous encoding set, switch still resolves', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const screenTrack: any = { id: 'screen-p1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream-p1',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)
    mockVideoSender.setParameters.mockRejectedValueOnce(new Error('params rejected'))

    // Rejection is swallowed: the share still goes live with the previous set.
    const stream = await client.setVideoSource('screen')
    expect(stream).toBe(screenStream)
    expect(client.getVideoSource()).toBe('screen')

    client.disconnect()
  })

  it('enables and disables camera with replaceTrack only, no renegotiation', async () => {
    const mockVideoTrack = {
      id: 'vid-track-1',
      kind: 'video',
      enabled: true,
      stop: vi.fn(),
      onended: null,
    }
    const mockVideoStream = {
      getVideoTracks: vi.fn(() => [mockVideoTrack]),
      getTracks: vi.fn(() => [mockVideoTrack]),
    }

    const getUserMediaMock = vi.fn().mockResolvedValue(mockVideoStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    })

    const onLocalVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onLocalVideoChange: onLocalVideo,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.createOffer.mockClear()
    mockPc.addTrack.mockClear() // drop the mic track recorded during connect()

    // Enable camera: replaceTrack on the pre-negotiated sender, video:true
    // signaled, zero offers.
    const stream = await client.setCameraEnabled(true)
    expect(stream).toBe(mockVideoStream)
    expect(client.isCameraActive()).toBe(true)
    expect(getUserMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        }),
      })
    )
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(mockVideoTrack)
    expect(mockPc.addTrack).not.toHaveBeenCalled()
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(onLocalVideo).toHaveBeenCalledWith(mockVideoStream)
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":true'))).toBe(true)

    // Disable camera: track stopped + detached via replaceTrack(null),
    // video:false signaled, still zero offers. Sender retained for reuse.
    await client.setCameraEnabled(false)
    expect(client.isCameraActive()).toBe(false)
    expect(mockVideoTrack.stop).toHaveBeenCalled()
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(null)
    expect(mockPc.removeTrack).not.toHaveBeenCalled()
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(onLocalVideo).toHaveBeenCalledWith(null)
    expect((client as any).videoSender).toBe(mockVideoSender)

    client.disconnect()
  })

  it('reuses one MediaStream per receiver track across re-announcements', async () => {
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'receiver-cam-stable', kind: 'video', readyState: 'live', onended: null }
    const firstStream: any = {
      id: 'kith-stream-alice',
      getTracks: () => [camTrack],
      getVideoTracks: () => [camTrack],
    }
    mockPc.ontrack({ track: camTrack, streams: [firstStream] })
    expect(onRemoteVideo).toHaveBeenCalledWith('alice', firstStream)
    onRemoteVideo.mockClear()

    // Same physical track re-announced WITHOUT a browser stream
    // (attachTransceiverTracks path, streams[0] undefined): the client must
    // reuse the stable wrapper instead of minting a fresh MediaStream per
    // event — new identities abort in-flight <video> play() and latch
    // "ended" in spotlight.
    mockPc.ontrack({ track: camTrack, streams: [] })
    expect(onRemoteVideo).not.toHaveBeenCalled()
    expect(client.getRemoteVideoStreams().get('alice')).toBe(firstStream)
    expect((client as any).remoteStreamByTrack.get('receiver-cam-stable')).toBe(firstStream)

    client.disconnect()
  })

  it('handles remote video tracks and triggers onRemoteVideoChange callback', async () => {
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const remoteVideoTrack: any = {
      id: 'kith-track-alice-video',
      kind: 'video',
      onended: null,
    }
    const remoteVideoStream: any = {
      id: 'kith-stream-alice',
      getTracks: () => [remoteVideoTrack],
    }

    mockPc.ontrack({ track: remoteVideoTrack, streams: [remoteVideoStream] })

    expect(onRemoteVideo).toHaveBeenCalledWith('alice', remoteVideoStream)
    expect(client.getRemoteVideoStreams().get('alice')).toBe(remoteVideoStream)

    // When remote track ends
    remoteVideoTrack.onended()
    expect(onRemoteVideo).toHaveBeenCalledWith('alice', null)
    expect(client.getRemoteVideoStreams().has('alice')).toBe(false)

    client.disconnect()
  })

  it('parses screenshare mids from SFU offer SDP', () => {
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:0',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=msid:kith-stream-bob kith-track-bob-video',
      '',
    ].join('\r\n')

    const mids = parseScreenMidsFromSdp(sdp)
    expect(mids.get('0')).toBe('alice')
    expect(mids.has('1')).toBe(false)
  })

  it('classifies a screen downlink via MID even with a synthetic stream (viewer bug)', async () => {
    const onRemoteScreen = vi.fn()
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteScreenShareChange: onRemoteScreen,
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // SFU downstream offer carries the screenshare msid on mid 0.
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:0',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    // ontrack arrives with a browser-assigned stream id (not kith-screen-*),
    // but the transceiver mid correlates it to alice's screen.
    const receiverTrack: any = { id: 'receiver-track-xyz', kind: 'video', readyState: 'live', onended: null }
    const browserStream: any = {
      id: 'random-browser-stream-id',
      getTracks: () => [receiverTrack],
      getVideoTracks: () => [receiverTrack],
    }
    mockPc.ontrack({ track: receiverTrack, streams: [browserStream], transceiver: { mid: '0' } })

    expect(onRemoteScreen).toHaveBeenCalledWith('alice', browserStream)
    expect(client.getRemoteScreenStreams().get('alice')).toBe(browserStream)
    // Must not be mirrored into the camera map.
    expect(onRemoteVideo).not.toHaveBeenCalledWith('alice', expect.anything())
    expect(client.getRemoteVideoStreams().has('alice')).toBe(false)

    // attachTransceiverTracks re-announcing the same receiver track dedupes.
    mockPc.getTransceivers = vi.fn(() => [{ mid: '0', receiver: { track: receiverTrack } }])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })
    expect(onRemoteScreen).toHaveBeenCalledTimes(1)

    client.disconnect()
  })

  it('keeps a legitimate cam tile when the same uid starts sharing screen', async () => {
    const onRemoteScreen = vi.fn()
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteScreenShareChange: onRemoteScreen,
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Properly-identified camera for alice arrives first.
    const camTrack: any = { id: 'receiver-cam', kind: 'video', onended: null }
    const camStream: any = {
      id: 'kith-stream-alice',
      getTracks: () => [camTrack],
      getVideoTracks: () => [camTrack],
    }
    mockPc.ontrack({ track: camTrack, streams: [camStream] })
    expect(onRemoteVideo).toHaveBeenCalledWith('alice', camStream)

    // A different track for the same uid arrivesMID-correlated as screen:
    // the cam tile must survive (cam+screen coexistence, Image 1).
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:7',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    const screenTrack: any = { id: 'receiver-screen', kind: 'video', readyState: 'live', onended: null }
    const screenStream: any = {
      id: 'synthetic-stream',
      getTracks: () => [screenTrack],
      getVideoTracks: () => [screenTrack],
    }
    mockPc.ontrack({ track: screenTrack, streams: [screenStream], transceiver: { mid: '7' } })

    expect(onRemoteVideo).not.toHaveBeenCalledWith('alice', null)
    expect(onRemoteScreen).toHaveBeenCalledWith('alice', screenStream)
    expect(client.getRemoteVideoStreams().get('alice')).toBe(camStream)
    expect(client.getRemoteScreenStreams().get('alice')).toBe(screenStream)

    client.disconnect()
  })

  it('moves the SAME track from camera to screen map when MID corrects it', async () => {
    const onRemoteScreen = vi.fn()
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteScreenShareChange: onRemoteScreen,
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Same receiver track first seen without MID (filed as camera)...
    const track: any = { id: 'receiver-x', kind: 'video', readyState: 'live', onended: null }
    const firstStream: any = {
      id: 'kith-stream-alice',
      getTracks: () => [track],
      getVideoTracks: () => [track],
    }
    mockPc.ontrack({ track, streams: [firstStream] })
    expect(client.getRemoteVideoStreams().get('alice')).toBe(firstStream)

    // ...then the MID index reveals it is actually the screen downlink.
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:7',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    const reannouncedStream: any = {
      id: 'synthetic-stream',
      getTracks: () => [track],
      getVideoTracks: () => [track],
    }
    mockPc.ontrack({ track, streams: [reannouncedStream], transceiver: { mid: '7' } })

    expect(onRemoteVideo).toHaveBeenCalledWith('alice', null)
    expect(onRemoteScreen).toHaveBeenCalledWith('alice', reannouncedStream)
    expect(client.getRemoteVideoStreams().has('alice')).toBe(false)
    expect(client.getRemoteScreenStreams().get('alice')).toBe(reannouncedStream)

    client.disconnect()
  })

  // Phase 0 regression (S2/R9, TDD — must FAIL before the fix):
  // camera downlink with a synthetic browser stream must still resolve to the
  // publisher uid via the MID index, not fall back to track.id keying.
  it('Phase0: resolves camera downlink to uid with synthetic stream (S2)', async () => {
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // SFU offer carries the camera msid on mid 1.
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=msid:kith-stream-alice kith-track-alice-video',
      '',
    ].join('\r\n')
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    // ontrack with browser-assigned (synthetic) stream/track ids.
    const receiverTrack: any = { id: 'receiver-cam-xyz', kind: 'video', readyState: 'live', onended: null }
    const browserStream: any = {
      id: 'random-browser-stream-id',
      getTracks: () => [receiverTrack],
      getVideoTracks: () => [receiverTrack],
    }
    mockPc.ontrack({ track: receiverTrack, streams: [browserStream], transceiver: { mid: '1' } })

    expect(onRemoteVideo).toHaveBeenCalledWith('alice', browserStream)
    expect(client.getRemoteVideoStreams().get('alice')).toBe(browserStream)

    client.disconnect()
  })

  // Phase 0 regression (S5-ghost/R3, TDD — must FAIL before the fix):
  // a stale in-flight offer arriving after screen:false must NOT resurrect
  // the cleared MID mapping (no ghost screen).
  it('Phase0: stale offer after screen:false does not resurrect ghost screen', async () => {
    const onRemoteScreen = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteScreenShareChange: onRemoteScreen,
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])

    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:0',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    const screenTrack: any = { id: 'receiver-screen-1', kind: 'video', readyState: 'live', onended: null }
    const screenStream: any = {
      id: 'kith-screen-alice',
      getTracks: () => [screenTrack],
      getVideoTracks: () => [screenTrack],
    }
    mockPc.ontrack({ track: screenTrack, streams: [screenStream], transceiver: { mid: '0' } })
    expect(client.getRemoteScreenStreams().get('alice')).toBe(screenStream)

    // Sharer stops: viewers delete + tombstone the MID.
    await mockWs.onmessage({ data: JSON.stringify({ type: 'screen', user_id: 'alice', screen: false }) })
    expect(client.getRemoteScreenStreams().has('alice')).toBe(false)
    onRemoteScreen.mockClear()

    // Stale in-flight offer for the dead MID arrives late.
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    const ghostTrack: any = { id: 'receiver-screen-1', kind: 'video', readyState: 'live', onended: null }
    const ghostStream: any = {
      id: 'kith-screen-alice',
      getTracks: () => [ghostTrack],
      getVideoTracks: () => [ghostTrack],
    }
    mockPc.ontrack({ track: ghostTrack, streams: [ghostStream], transceiver: { mid: '0' } })

    expect(client.getRemoteScreenStreams().has('alice')).toBe(false)
    expect(onRemoteScreen).not.toHaveBeenCalledWith('alice', expect.anything())

    client.disconnect()
  })

  // Tombstone race (reshare-after-stop): the server emits the reshare's
  // downstream offer BEFORE the screen:true broadcast, so the offer is
  // indexed while the previous screen:false tombstone is still set and the
  // screen MID is skipped. screen:true must heal this by re-indexing from
  // the last downstream SDP — otherwise the track orphans and the viewer
  // sits on avatar until refresh.
  it('Tombstone race: screen:true re-indexes a skipped reshare offer', async () => {
    const onRemoteScreen = vi.fn()
    const onRemoteVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onRemoteScreenShareChange: onRemoteScreen,
      onRemoteVideoChange: onRemoteVideo,
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])

    // Prior share ended -> tombstone set (exactly like screen:false does).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'screen', user_id: 'alice', screen: false }) })
    expect((client as any).screenRevoked.has('alice')).toBe(true)

    // Reshare offer arrives BEFORE screen:true (server order).
    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:7',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    // MID skipped while tombstoned.
    expect((client as any).midIndex.get('7')).toBeUndefined()

    // The track itself still arrives — and must not surface anywhere yet.
    const track: any = { id: 'receiver-screen-9', kind: 'video', readyState: 'live', onended: null }
    const stream: any = {
      id: 'synthetic-browser-stream',
      getTracks: () => [track],
      getVideoTracks: () => [track],
    }
    mockPc.ontrack({ track, streams: [stream], transceiver: { mid: '7' } })
    expect(onRemoteScreen).not.toHaveBeenCalledWith('alice', expect.anything())

    // screen:true lifts the tombstone AND heals the skipped index...
    await mockWs.onmessage({ data: JSON.stringify({ type: 'screen', user_id: 'alice', screen: true }) })
    expect((client as any).screenRevoked.has('alice')).toBe(false)
    expect((client as any).midIndex.get('7')).toEqual({ uid: 'alice', kind: 'screen' })

    // ...so the (re-announced) receiver track classifies as screen.
    mockPc.ontrack({ track, streams: [stream], transceiver: { mid: '7' } })
    expect(onRemoteScreen).toHaveBeenCalledWith('alice', stream)
    expect(client.getRemoteScreenStreams().get('alice')).toBe(stream)

    client.disconnect()
  })

  // Negotiate-once (R1): concurrent camera+screen publish serializes on the
  // pre-negotiated sender — zero offers, zero addTracks — and exactly ONE
  // source ends up live (second source wins, first device stopped).
  it('Negotiate-once: concurrent camera+screen serializes, zero offers (R1)', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    const screenTrack: any = { id: 'screen-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)

    mockPc.addTrack.mockClear() // drop the mic track recorded during connect()
    mockPc.createOffer.mockClear() // drop the connect-time join offer

    const [camResult, screenResult] = await Promise.all([
      client.setCameraEnabled(true),
      client.startScreenShare(),
    ])

    expect(camResult).toBe(camStream)
    expect(screenResult).toBe(screenStream)
    // Negotiate-once: no offers, no new senders — both ops replaceTrack on
    // the pre-negotiated slot.
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(mockPc.addTrack).not.toHaveBeenCalled()
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(camTrack)
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(screenTrack)
    // Old device fully stopped (bandwidth goal).
    expect(camTrack.stop).toHaveBeenCalled()
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":true'))).toBe(true)
    expect(sent.some((s: string) => s.includes('"video":false'))).toBe(true)
    expect(sent.some((s: string) => s.includes('"screen":true'))).toBe(true)
    // Last-writer-wins: screen is the live source, camera is off.
    expect(client.isCameraActive()).toBe(false)
    expect(client.isScreenSharing()).toBe(true)
    expect(client.getVideoSource()).toBe('screen')
    expect(client.getLocalVideoStream()).toBeNull()
    expect(client.getLocalScreenStream()).toBe(screenStream)

    client.disconnect()
  })

  // Negotiate-once: 10 rapid toggles (the glare-storm repro) produce zero
  // offers and leave the slot in the last-requested state, session alive.
  it('Negotiate-once: rapid toggle storm sends zero offers, keeps session', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const acquired: any[] = []
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        const track: any = { id: `cam-${i}`, kind: 'video', enabled: true, stop: vi.fn(), onended: null }
        const stream: any = {
          id: `cam-stream-${i}`,
          getVideoTracks: () => [track],
          getTracks: () => [track],
        }
        acquired.push(track)
        ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(stream)
        await client.setCameraEnabled(true)
      } else {
        await client.setCameraEnabled(false)
      }
    }

    // 10 toggles: zero offers beyond join, each acquired track stopped.
    expect(mockPc.createOffer).toHaveBeenCalledTimes(1) // join offer only
    expect(mockPc.addTrack).toHaveBeenCalledTimes(1) // mic only
    expect(acquired).toHaveLength(5)
    for (const track of acquired) {
      expect(track.stop).toHaveBeenCalled()
    }
    // Even count of toggles starting from off ends... 5 enables + 5
    // disables interleaved → last op is disable → off.
    expect(client.getVideoSource()).toBe('off')
    // No failure surfaced: session never wedged.
    expect(onState).not.toHaveBeenCalledWith('failed')

    client.disconnect()
  })

  // Negotiate-once: sequential cam→screen switch reuses the pre-negotiated
  // sender and stops the old device; no offers anywhere.
  it('Negotiate-once: sequential switch reuses sender, stops old device', async () => {
    const onLocalVideo = vi.fn()
    const onLocalScreen = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onLocalVideoChange: onLocalVideo,
      onLocalScreenChange: onLocalScreen,
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    const screenTrack: any = { id: 'screen-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)

    mockPc.addTrack.mockClear()
    mockPc.createOffer.mockClear()

    await client.setCameraEnabled(true)
    expect(client.getVideoSource()).toBe('camera')
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(camTrack)
    expect(mockPc.createOffer).not.toHaveBeenCalled()

    // cam→screen: replaceTrack on the same sender, old kind cleared first.
    await client.startScreenShare()
    expect(client.getVideoSource()).toBe('screen')
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(screenTrack)
    expect(mockPc.addTrack).not.toHaveBeenCalled()
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(camTrack.stop).toHaveBeenCalled()
    expect(client.isCameraActive()).toBe(false)
    expect(client.isScreenSharing()).toBe(true)

    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":false'))).toBe(true)
    expect(sent.some((s: string) => s.includes('"screen":true'))).toBe(true)

    // setCameraEnabled(false) must NOT kill a live screen (legacy guard).
    mockWs.send.mockClear()
    await client.setCameraEnabled(false)
    expect(client.getVideoSource()).toBe('screen')
    expect(mockWs.send).not.toHaveBeenCalled()

    // stopScreenShare() clears the slot with screen:false.
    await client.stopScreenShare()
    expect(client.getVideoSource()).toBe('off')
    expect(screenTrack.stop).toHaveBeenCalled()
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(null)
    const sent2 = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent2.some((s: string) => s.includes('"screen":false'))).toBe(true)

    client.disconnect()
  })

  // Negotiate-once (R6): a replaceTrack failure restores the previous live
  // source — no wedge, no ghost — and retry works.
  it('Negotiate-once: failed switch restores previous source, retry works (R6)', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    const screenTrack: any = { id: 'screen-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)
    mockPc.signalingState = 'stable'

    await client.setCameraEnabled(true)
    expect(client.getVideoSource()).toBe('camera')

    // The switch replaceTrack blows up; the restore replaceTrack succeeds.
    mockVideoSender.replaceTrack
      .mockRejectedValueOnce(new Error('replace boom'))
      .mockResolvedValue(undefined)
    await expect(client.startScreenShare()).rejects.toThrow('replace boom')
    // Previous source restored live: camera still on, cam track kept.
    expect(client.getVideoSource()).toBe('camera')
    expect(client.isCameraActive()).toBe(true)
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(camTrack)
    expect(camTrack.stop).not.toHaveBeenCalled()
    expect(screenTrack.stop).toHaveBeenCalled()
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"screen":true'))).toBe(false)
    expect(sent.some((s: string) => s.includes('"video":false'))).toBe(false)

    // Retry allowed after failure.
    const retried = await client.startScreenShare()
    expect(retried).toBe(screenStream)
    expect(client.getVideoSource()).toBe('screen')

    client.disconnect()
  })

  // Step 1 (R6 across kinds): a failed screen acquisition leaves the live
  // camera untouched.
  it('Step1: failed screen acquisition keeps live camera (R6)', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockRejectedValue(denied)
    mockPc.addTrack.mockReturnValue({ replaceTrack: vi.fn().mockResolvedValue(undefined) })
    mockPc.signalingState = 'stable'

    await client.setCameraEnabled(true)
    expect(client.getVideoSource()).toBe('camera')

    await expect(client.startScreenShare()).rejects.toThrow('denied')
    expect(client.getVideoSource()).toBe('camera')
    expect(client.isCameraActive()).toBe(true)
    expect(camTrack.stop).not.toHaveBeenCalled()

    client.disconnect()
  })

  // Negotiate-once (R6): when the pre-negotiated sender is missing, enable
  // falls back to addTrack + one offer — and a failed fallback offer rolls
  // everything back with no phantom video.
  it('Negotiate-once: fallback addTrack rolls back on offer failure (R6)', async () => {
    const onLocalVideo = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onLocalVideoChange: onLocalVideo,
    })

    // Transceiver setup yields no sender → fallback path on first enable.
    mockPc.addTransceiver.mockReturnValueOnce({ sender: null } as any)

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    const fallbackSender = { replaceTrack: vi.fn().mockResolvedValue(undefined), id: 'fallback' }
    mockPc.addTrack.mockReturnValue(fallbackSender)
    mockPc.signalingState = 'stable'
    mockPc.createOffer.mockRejectedValue(new Error('offer boom'))

    await expect(client.setCameraEnabled(true)).rejects.toThrow('offer boom')
    expect(mockPc.removeTrack).toHaveBeenCalledWith(fallbackSender)
    expect((client as any).videoSender).toBeNull()
    expect(client.getLocalVideoStream()).toBeNull()
    expect(client.isCameraActive()).toBe(false)
    expect(camTrack.stop).toHaveBeenCalled()
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":true'))).toBe(false)

    // Retry allowed after failure.
    mockPc.createOffer.mockResolvedValue({ sdp: 'v=0 ok' })
    const retryTrack: any = { id: 'cam-2', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const retryStream: any = {
      id: 'cam-stream-2',
      getVideoTracks: () => [retryTrack],
      getTracks: () => [retryTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(retryStream)
    const retried = await client.setCameraEnabled(true)
    expect(retried).toBe(retryStream)
    expect(client.isCameraActive()).toBe(true)

    client.disconnect()
  })

  // Negotiate-once (R4): teardown sends video:false even when the detach
  // fails — teardown resolves instead of rejecting, sender retained.
  it('Negotiate-once: disable sends video:false even when detach fails (R4)', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    mockPc.signalingState = 'stable'

    await client.setCameraEnabled(true)
    expect(client.isCameraActive()).toBe(true)

    // Detach blows up — teardown still clears state and signals video:false.
    mockVideoSender.replaceTrack.mockRejectedValueOnce(new Error('detach boom'))
    await client.setCameraEnabled(false)

    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":false'))).toBe(true)
    expect(client.getLocalVideoStream()).toBeNull()
    expect(client.isCameraActive()).toBe(false)
    expect(camTrack.stop).toHaveBeenCalled()
    // Pre-negotiated sender retained for reuse (m-section intact).
    expect((client as any).videoSender).toBe(mockVideoSender)

    client.disconnect()
  })

  // Phase 0 (O/R6): denied camera permission mutates nothing — no sender,
  // still off — and a later retry works.
  it('Phase0: denied camera permission mutates nothing and allows retry (O)', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValue(camStream)
    mockPc.addTrack.mockReturnValue({ replaceTrack: vi.fn().mockResolvedValue(undefined) })
    mockPc.addTrack.mockClear() // drop the mic track recorded during connect()
    mockPc.signalingState = 'stable'

    await expect(client.setCameraEnabled(true)).rejects.toThrow('denied')
    // Pre-negotiated sender survives acquisition failure untouched.
    expect((client as any).videoSender).toBe(mockVideoSender)
    expect(client.isCameraActive()).toBe(false)
    expect(mockPc.addTrack).not.toHaveBeenCalled()

    const retried = await client.setCameraEnabled(true)
    expect(retried).toBe(camStream)
    expect(client.isCameraActive()).toBe(true)

    client.disconnect()
  })

  // Phase 0 (R1): redundant enable reuses the live track — no second sender.
  it('Phase0: redundant camera enable reuses live track without new sender', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    mockPc.addTrack.mockReturnValue({ replaceTrack: vi.fn().mockResolvedValue(undefined) })
    mockPc.signalingState = 'stable'

    const first = await client.setCameraEnabled(true)
    mockPc.addTrack.mockClear()
    const second = await client.setCameraEnabled(true)

    expect(second).toBe(first)
    expect(mockPc.addTrack).not.toHaveBeenCalled()

    client.disconnect()
  })

  // Phase 0 (R2): a downstream offer arriving mid-renegotiation is stashed —
  // never force-applied — and applied once signaling returns to stable.
  it('Phase0: downstream offer during glare is stashed and applied on stable (R2)', async () => {
    const listeners: Record<string, Function[]> = {}
    mockPc.addEventListener = vi.fn((ev: string, cb: Function) => {
      ;(listeners[ev] ||= []).push(cb)
    })
    mockPc.removeEventListener = vi.fn((ev: string, cb: Function) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb)
    })
    mockPc.signalingState = 'stable'

    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const fireSignaling = (state: string) => {
      mockPc.signalingState = state
      ;(listeners['signalingstatechange'] || []).slice().forEach((cb) => cb())
    }

    // Glare: our own offer is still in flight.
    mockPc.signalingState = 'have-local-offer'
    mockPc.setRemoteDescription.mockClear()
    mockWs.send.mockClear()

    const sdp = 'v=0 sfu-renegotiation-offer'
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    // Stashed, not force-applied: no setRemote, no answer.
    expect(mockPc.setRemoteDescription).not.toHaveBeenCalled()
    expect((client as any).pendingOffer).toBe(sdp)
    expect(
      mockWs.send.mock.calls.some((c: any) => String(c[0]).includes('"answer"')),
    ).toBe(false)

    // Our exchange settles → stashed offer applies exactly once.
    fireSignaling('stable')
    await new Promise((r) => setTimeout(r, 20))

    expect(mockPc.setRemoteDescription).toHaveBeenCalledTimes(1)
    expect(mockPc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp })
    expect(
      mockWs.send.mock.calls.some((c: any) => String(c[0]).includes('"answer"')),
    ).toBe(true)
    expect((client as any).pendingOffer).toBeNull()

    client.disconnect()
  })

  // Phase 0 (R2): setRemoteDescription throwing InvalidStateError stashes
  // instead of wedging — the message handler resolves and a later stable
  // flush applies the offer.
  it('Phase0: InvalidStateError on setRemoteDescription stashes without wedging (R2)', async () => {
    const listeners: Record<string, Function[]> = {}
    mockPc.addEventListener = vi.fn((ev: string, cb: Function) => {
      ;(listeners[ev] ||= []).push(cb)
    })
    mockPc.removeEventListener = vi.fn((ev: string, cb: Function) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb)
    })
    mockPc.signalingState = 'stable'

    const onError = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onError,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const fireSignaling = (state: string) => {
      mockPc.signalingState = state
      ;(listeners['signalingstatechange'] || []).slice().forEach((cb) => cb())
    }

    const sdp = 'v=0 sfu-offer-glare'
    mockPc.setRemoteDescription.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'InvalidStateError' }),
    )
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    // No throw, no error surfaced, offer kept for retry.
    expect(onError).not.toHaveBeenCalled()
    expect((client as any).pendingOffer).toBe(sdp)

    // Next stable flush applies it (mock now resolves).
    fireSignaling('stable')
    await new Promise((r) => setTimeout(r, 20))

    expect(mockPc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp })
    expect(
      mockWs.send.mock.calls.some((c: any) => String(c[0]).includes('"answer"')),
    ).toBe(true)
    expect(onError).not.toHaveBeenCalled()

    client.disconnect()
  })

  // Phase 0 (R2): back-to-back offers under glare collapse — latest wins, no
  // wedge, exactly one application.
  it('Phase0: back-to-back offers under glare collapse to latest (R2)', async () => {
    const listeners: Record<string, Function[]> = {}
    mockPc.addEventListener = vi.fn((ev: string, cb: Function) => {
      ;(listeners[ev] ||= []).push(cb)
    })
    mockPc.removeEventListener = vi.fn((ev: string, cb: Function) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb)
    })
    mockPc.signalingState = 'stable'

    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const fireSignaling = (state: string) => {
      mockPc.signalingState = state
      ;(listeners['signalingstatechange'] || []).slice().forEach((cb) => cb())
    }

    mockPc.signalingState = 'have-local-offer'
    mockPc.setRemoteDescription.mockClear()
    mockWs.send.mockClear()

    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp: 'v=0 offer-1' }) })
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp: 'v=0 offer-2' }) })

    expect(mockPc.setRemoteDescription).not.toHaveBeenCalled()
    expect((client as any).pendingOffer).toBe('v=0 offer-2')

    fireSignaling('stable')
    await new Promise((r) => setTimeout(r, 20))

    expect(mockPc.setRemoteDescription).toHaveBeenCalledTimes(1)
    expect(mockPc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0 offer-2' })

    client.disconnect()
  })

  // Negotiate-once: enabling video never waits for the join-ack and never
  // offers — replaceTrack is local, and kind signals need no handshake.
  // (E2E-found: instant screen-share right after channel open.)
  it('enable proceeds immediately without join-ack and without offering', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    // Simulate "ack not yet received": flip the private flag back.
    ;(client as any).joinAcked = false

    const camTrack: any = { id: 'cam-j', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream-j',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    mockPc.signalingState = 'stable'
    mockPc.createOffer.mockClear()

    const stream = await client.setCameraEnabled(true)
    expect(stream).toBe(camStream)
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(camTrack)
    expect(client.isCameraActive()).toBe(true)
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    expect(sent.some((s: string) => s.includes('"video":true'))).toBe(true)

    client.disconnect()
  })

  const fireConn = (state: string) => {
    mockPc.connectionState = state
    mockPc.onconnectionstatechange?.()
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Phase 0 (R10/S6): a transient `disconnected` that heals within the grace
  // window surfaces nothing — no leave, no restart.
  it('Phase0: transient disconnected heals silently within grace (R10)', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
      reconnectGraceMs: 30,
      reconnectTimeoutMs: 200,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    fireConn('connected')
    onState.mockClear()
    mockPc.restartIce.mockClear()

    fireConn('disconnected')
    await sleep(10)
    fireConn('connected')
    await sleep(50)

    expect(onState).not.toHaveBeenCalledWith('disconnected')
    expect(onState).not.toHaveBeenCalledWith('failed')
    expect(mockPc.restartIce).not.toHaveBeenCalled()
    expect(onState).toHaveBeenCalledWith('connected')

    client.disconnect()
  })

  // Phase 0 (R10/S6): a sustained `disconnected` triggers one ICE restart +
  // re-offer (surfaced as connecting), and recovery emits connected.
  it('Phase0: sustained disconnected triggers restart and recovers (R10)', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
      reconnectGraceMs: 30,
      reconnectTimeoutMs: 200,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'

    fireConn('connected')
    onState.mockClear()
    mockPc.restartIce.mockClear()
    mockPc.createOffer.mockClear()

    fireConn('disconnected')
    await sleep(60)

    expect(mockPc.restartIce).toHaveBeenCalledTimes(1)
    expect(mockPc.createOffer).toHaveBeenCalled()
    expect(onState).toHaveBeenCalledWith('connecting')
    expect(onState).not.toHaveBeenCalledWith('failed')
    expect(onState).not.toHaveBeenCalledWith('disconnected')

    fireConn('connected')
    await sleep(30)

    expect(onState).toHaveBeenCalledWith('connected')
    expect(onState).not.toHaveBeenCalledWith('failed')

    client.disconnect()
  })

  // Phase 0 (R10): `failed` restarts immediately without waiting for grace.
  it('Phase0: failed triggers immediate restart (R10)', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
      reconnectGraceMs: 30,
      reconnectTimeoutMs: 200,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'

    fireConn('connected')
    onState.mockClear()
    mockPc.restartIce.mockClear()

    fireConn('failed')
    await sleep(20)

    expect(mockPc.restartIce).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenCalledWith('connecting')

    fireConn('connected')
    await sleep(30)
    expect(onState).toHaveBeenCalledWith('connected')
    expect(onState).not.toHaveBeenCalledWith('failed')

    client.disconnect()
  })

  // Phase 0 (R10): unrecoverable outage (re-offer keeps failing) surfaces
  // exactly one failed per episode — bounded restarts, no spin.
  it('Phase0: unrecoverable outage fails cleanly with bounded restarts (R10)', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
      reconnectGraceMs: 30,
      reconnectTimeoutMs: 200,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    mockPc.signalingState = 'stable'

    fireConn('connected')
    onState.mockClear()
    mockPc.restartIce.mockClear()
    mockPc.createOffer.mockRejectedValue(new Error('nope'))

    // Episode 1: restart attempted once, then failed.
    fireConn('disconnected')
    await sleep(60)
    expect(mockPc.restartIce).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenCalledWith('failed')

    // Episode 2: one more attempt (attempts=2), then failed again.
    onState.mockClear()
    fireConn('failed')
    await sleep(30)
    expect(mockPc.restartIce).toHaveBeenCalledTimes(2)
    expect(onState).toHaveBeenCalledWith('failed')

    // Episode 3: attempts exhausted — immediate failed, no restart.
    onState.mockClear()
    fireConn('failed')
    await sleep(30)
    expect(mockPc.restartIce).toHaveBeenCalledTimes(2)
    expect(onState).toHaveBeenCalledWith('failed')

    client.disconnect()
  })

  // Phase 0 (R10): pre-connect blips keep legacy behavior — forwarded, never
  // recovered (no connected basis yet).
  it('Phase0: pre-connect blip is forwarded without recovery (R10)', async () => {
    const onState = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onConnectionStateChange: onState,
      reconnectGraceMs: 30,
      reconnectTimeoutMs: 200,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })
    onState.mockClear()
    mockPc.restartIce.mockClear()

    fireConn('disconnected')
    expect(onState).toHaveBeenCalledWith('disconnected')
    await sleep(60)
    expect(mockPc.restartIce).not.toHaveBeenCalled()

    client.disconnect()
  })

  // E2E-found (offer-glare retry, now bounded): when the SFU rejects our
  // join offer ("failed to process offer"), the client re-offers once with
  // backoff while the PC is stable — then stops. No unbounded ping-pong.
  it('re-offers once with backoff after the SFU rejects an offer (glare retry)', async () => {
    const onError = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onError,
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    mockPc.signalingState = 'stable'
    mockPc.createOffer.mockClear()

    await mockWs.onmessage({
      data: JSON.stringify({ type: 'error', message: 'failed to process offer: glare' }),
    })
    // Backoff is 500ms * attempt: no instant retry...
    await sleep(200)
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    // ...exactly one retry after the backoff window.
    await sleep(500)
    expect(mockPc.createOffer).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalled()

    // Further rejections keep retrying only up to the bound (3 total).
    for (let i = 0; i < 3; i++) {
      await mockWs.onmessage({
        data: JSON.stringify({ type: 'error', message: 'failed to process offer: glare' }),
      })
      await sleep(1800)
    }
    expect(mockPc.createOffer.mock.calls.length).toBeLessThanOrEqual(4) // 1 + ≤3 retries

    client.disconnect()
  }, 20000)

  // screen:true carries the browser track ID so the SFU can mark the uplink
  // as screen out-of-band (Pion ignores SDP msid rewrites).
  it('screen:true carries browser trackId for SFU marking', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    // Simulate SFU join-ack (join gating in SfuClient requires it).
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const screenTrack: any = { id: 'browser-screen-uuid-1', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'browser-screen-stream-1',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)
    mockPc.signalingState = 'stable'

    await client.startScreenShare()
    const sent = mockWs.send.mock.calls.map((c: any) => String(c[0]))
    const screenMsg = sent.find((m: string) => m.includes('"screen":true'))
    expect(screenMsg).toBeDefined()
    expect(JSON.parse(screenMsg as string)).toMatchObject({
      type: 'screen',
      screen: true,
      trackId: 'browser-screen-uuid-1',
    })

    client.disconnect()
  })

  // Screen keyframe hygiene: returning from a backgrounded tab while
  // sharing requests a keyframe so desynced viewers resync immediately
  // instead of waiting out the sparse static-content cadence.
  it('requests a keyframe on visible-return while sharing screen', async () => {
    const listeners: Record<string, Function[]> = {}
    const docStub: any = {
      visibilityState: 'hidden',
      addEventListener: vi.fn((ev: string, cb: Function) => {
        ;(listeners[ev] ||= []).push(cb)
      }),
      removeEventListener: vi.fn((ev: string, cb: Function) => {
        listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb)
      }),
    }
    vi.stubGlobal('document', docStub)
    mockVideoSender.generateKeyFrame = vi.fn().mockResolvedValue(undefined)

    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const screenTrack: any = { id: 'screen-kf', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const screenStream: any = {
      id: 'screen-stream-kf',
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    }
    ;(navigator.mediaDevices as any).getDisplayMedia = vi.fn().mockResolvedValue(screenStream)
    await client.startScreenShare()

    const fireVisible = () => {
      ;(listeners['visibilitychange'] || []).slice().forEach((cb) => cb())
    }

    // Still hidden: no keyframe.
    fireVisible()
    expect(mockVideoSender.generateKeyFrame).not.toHaveBeenCalled()

    // Back to visible while sharing: exactly one keyframe request.
    docStub.visibilityState = 'visible'
    fireVisible()
    expect(mockVideoSender.generateKeyFrame).toHaveBeenCalledTimes(1)
    expect(client.requestKeyframe()).toBe(true)

    // Camera live: visible-return asks for nothing.
    const camTrack: any = { id: 'cam-kf', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream-kf',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    await client.setCameraEnabled(true)
    ;(mockVideoSender.generateKeyFrame as any).mockClear()
    fireVisible()
    expect(mockVideoSender.generateKeyFrame).not.toHaveBeenCalled()

    // Disconnect unregisters the listener.
    client.disconnect()
    expect(docStub.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })

  it('collectInboundVideoStats extracts video tracks keyed by track id', () => {
    expect(STATS_POLL_INTERVAL_MS).toBe(2000)
    const report = new Map<string, any>([
      [
        'inbound-video-1',
        {
          id: 'inbound-video-1',
          type: 'inbound-rtp',
          kind: 'video',
          trackId: 'recv-track-1',
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 30,
          framesDropped: 2,
          jitterBufferDelay: 0.12,
          jitterBufferEmittedCount: 6,
        },
      ],
      ['track-1', { id: 'track-1', type: 'track', trackIdentifier: 'recv-track-1' }],
      [
        'inbound-audio-1',
        { id: 'inbound-audio-1', type: 'inbound-rtp', kind: 'audio', trackId: 'audio-track-1' },
      ],
      [
        'inbound-video-nofps',
        {
          id: 'inbound-video-nofps',
          type: 'inbound-rtp',
          kind: 'video',
          trackId: 'recv-track-2',
          frameWidth: 640,
          frameHeight: 360,
        },
      ],
    ]) as unknown as RTCStatsReport

    const stats = collectInboundVideoStats(report)
    expect(stats.size).toBe(2)
    expect(stats.get('recv-track-1')).toEqual({
      trackId: 'recv-track-1',
      width: 1280,
      height: 720,
      framesPerSecond: 30,
      framesDropped: 2,
      jitterBufferDelayMs: 20,
    })
    expect(stats.get('recv-track-2')).toEqual({
      trackId: 'recv-track-2',
      width: 640,
      height: 360,
      framesPerSecond: null,
      framesDropped: null,
      jitterBufferDelayMs: null,
    })
  })

  it('collectInboundVideoStats ignores non-finite values and empty reports', () => {
    const report = new Map<string, any>([
      [
        'bad',
        {
          id: 'bad',
          type: 'inbound-rtp',
          kind: 'video',
          trackId: 't-bad',
          frameWidth: NaN,
          frameHeight: Infinity,
          framesPerSecond: 'fast',
        },
      ],
    ]) as unknown as RTCStatsReport
    const stats = collectInboundVideoStats(report)
    expect(stats.get('t-bad')).toEqual({
      trackId: 't-bad',
      width: null,
      height: null,
      framesPerSecond: null,
      framesDropped: null,
      jitterBufferDelayMs: null,
    })
    expect(collectInboundVideoStats(new Map() as unknown as RTCStatsReport).size).toBe(0)
  })

  it('starts stats polling on connect and stops on disconnect', async () => {
    const onStatsUpdate = vi.fn()
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
      onStatsUpdate,
    })

    let resolveFirst: ((v: unknown) => void) | null = null
    const getStats = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFirst ??= resolve
          // Resolve asynchronously: startStatsPolling fires-and-forgets.
          setTimeout(() => resolve(new Map()), 0)
        }),
    )
    mockPc.getStats = getStats

    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    // Primed immediately on joined (async resolve).
    await new Promise((r) => setTimeout(r, 10))
    expect(getStats).toHaveBeenCalled()
    expect(onStatsUpdate).toHaveBeenCalledTimes(1)
    expect(onStatsUpdate).toHaveBeenCalledWith(expect.any(Map))

    // stopStatsPolling halts the timer: direct unit check without
    // fake-timer interference with the suite's other async tests.
    client.stopStatsPolling()
    expect((client as any).statsTimer).toBeNull()
    const polls = getStats.mock.calls.length
    await new Promise((r) => setTimeout(r, STATS_POLL_INTERVAL_MS + 50))
    expect(getStats.mock.calls.length).toBe(polls)

    client.disconnect()
  })

  // L2 parser interop: lone-LF SDP (non-Pion stacks) indexes identically to CRLF.
  it('parseMidIndexFromSdp handles LF-only line endings', async () => {
    const { parseMidIndexFromSdp } = await import('./sfu-client')
    const crlf = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=mid:0',
      'a=msid:kith-stream-alice kith-track-alice-xyz',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=msid:kith-stream-alice kith-track-alice-video',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:2',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      '',
    ].join('\r\n')
    const lf = crlf.replaceAll('\r\n', '\n')

    for (const sdp of [crlf, lf]) {
      const idx = parseMidIndexFromSdp(sdp)
      expect(idx.get('0')).toEqual({ uid: 'alice', kind: 'audio' })
      expect(idx.get('1')).toEqual({ uid: 'alice', kind: 'video' })
      expect(idx.get('2')).toEqual({ uid: 'alice', kind: 'screen' })
    }
  })

  // L2 parser interop: realistic unified-plan offer (extra attrs, rtcp-mux,
  // BUNDLE group, session-level lines) classifies every section.
  it('parseMidIndexFromSdp classifies a realistic unified-plan offer', async () => {
    const { parseMidIndexFromSdp } = await import('./sfu-client')
    const sdp = [
      'v=0',
      'o=- 12345 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0 1 2',
      'a=msid-semantic: WMS',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
      'a=mid:0',
      'a=rtpmap:111 opus/48000/2',
      'a=msid:kith-stream-bob kith-track-bob-abc123',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'c=IN IP4 0.0.0.0',
      'a=mid:1',
      'a=rtpmap:96 VP8/90000',
      'a=rtcp-fb:96 nack pli',
      'a=msid:kith-stream-bob kith-track-bob-video',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'c=IN IP4 0.0.0.0',
      'a=mid:2',
      'a=rtpmap:96 VP8/90000',
      'a=msid:kith-screen-bob kith-track-bob-screen',
      '',
    ].join('\r\n')

    const idx = parseMidIndexFromSdp(sdp)
    expect(idx.size).toBe(3)
    expect(idx.get('0')).toEqual({ uid: 'bob', kind: 'audio' })
    expect(idx.get('1')).toEqual({ uid: 'bob', kind: 'video' })
    expect(idx.get('2')).toEqual({ uid: 'bob', kind: 'screen' })
  })

  // Image 1: cam + screen from the same publisher must coexist in their
  // respective maps, in both arrival orders. The old uid-level mutual
  // exclusion dropped the cam tile (or evicted it when screen arrived).
  it.each([['cam-first'], ['screen-first']])(
    'cam+screen coexistence survives arrival order (%s)',
    async (order: string) => {
      const onRemoteVideo = vi.fn()
      const onRemoteScreen = vi.fn()
      const client = new SfuClient({
        endpoint: '127.0.0.1:5000',
        token: 'jwt-token-123',
        channelId: 'voice-chan-1',
        onRemoteVideoChange: onRemoteVideo,
        onRemoteScreenShareChange: onRemoteScreen,
      })
      await client.connect()
      await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

      const sdp = [
        'v=0',
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'a=mid:0',
        'a=msid:kith-screen-alice kith-track-alice-screen',
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'a=mid:1',
        'a=msid:kith-stream-alice kith-track-alice-video',
        '',
      ].join('\r\n')
      mockPc.signalingState = 'stable'
      mockPc.getTransceivers = vi.fn(() => [])
      await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

      const camTrack: any = { id: 'receiver-cam', kind: 'video', readyState: 'live', onended: null }
      const camStream: any = {
        id: 'synthetic-cam-stream',
        getTracks: () => [camTrack],
        getVideoTracks: () => [camTrack],
      }
      const screenTrack: any = { id: 'receiver-screen', kind: 'video', readyState: 'live', onended: null }
      const screenStream: any = {
        id: 'synthetic-screen-stream',
        getTracks: () => [screenTrack],
        getVideoTracks: () => [screenTrack],
      }

      // Arrival order follows the case: the old uid-level mutual
      // exclusion dropped or evicted one side depending on who came first.
      if (order === 'cam-first') {
        mockPc.ontrack({ track: camTrack, streams: [camStream], transceiver: { mid: '1' } })
        mockPc.ontrack({ track: screenTrack, streams: [screenStream], transceiver: { mid: '0' } })
      } else {
        mockPc.ontrack({ track: screenTrack, streams: [screenStream], transceiver: { mid: '0' } })
        mockPc.ontrack({ track: camTrack, streams: [camStream], transceiver: { mid: '1' } })
      }

      expect(client.getRemoteVideoStreams().get('alice')).toBe(camStream)
      expect(client.getRemoteScreenStreams().get('alice')).toBe(screenStream)
      expect(onRemoteVideo).toHaveBeenCalledWith('alice', camStream)
      expect(onRemoteScreen).toHaveBeenCalledWith('alice', screenStream)

      client.disconnect()
    },
  )

  it('screen arrival keeps a live cam tile, cam arrival keeps the screen', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const sdp = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:0',
      'a=msid:kith-screen-alice kith-track-alice-screen',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:1',
      'a=msid:kith-stream-alice kith-track-alice-video',
      '',
    ].join('\r\n')
    mockPc.signalingState = 'stable'
    mockPc.getTransceivers = vi.fn(() => [])
    await mockWs.onmessage({ data: JSON.stringify({ type: 'offer', sdp }) })

    const screenTrack: any = { id: 'receiver-screen', kind: 'video', readyState: 'live', onended: null }
    const screenStream: any = {
      id: 'synthetic-screen-stream',
      getTracks: () => [screenTrack],
      getVideoTracks: () => [screenTrack],
    }
    // Screen first, then cam (reverse order of the previous test).
    mockPc.ontrack({ track: screenTrack, streams: [screenStream], transceiver: { mid: '0' } })
    const camTrack: any = { id: 'receiver-cam', kind: 'video', readyState: 'live', onended: null }
    const camStream: any = {
      id: 'synthetic-cam-stream',
      getTracks: () => [camTrack],
      getVideoTracks: () => [camTrack],
    }
    mockPc.ontrack({ track: camTrack, streams: [camStream], transceiver: { mid: '1' } })

    expect(client.getRemoteScreenStreams().get('alice')).toBe(screenStream)
    expect(client.getRemoteVideoStreams().get('alice')).toBe(camStream)

    client.disconnect()
  })

  // Images 3-4 (negotiate-once): a toggle during have-remote-offer no
  // longer touches signaling at all — replaceTrack is orthogonal to the
  // offer/answer exchange, so it completes immediately with zero offers.
  it('toggle during have-remote-offer completes immediately, zero offers', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })
    await client.connect()
    await mockWs.onmessage({ data: JSON.stringify({ type: 'joined', channel_id: 'voice-chan-1' }) })

    const camTrack: any = { id: 'cam-w', kind: 'video', enabled: true, stop: vi.fn(), onended: null }
    const camStream: any = {
      id: 'cam-stream-w',
      getVideoTracks: () => [camTrack],
      getTracks: () => [camTrack],
    }
    ;(navigator.mediaDevices as any).getUserMedia = vi.fn().mockResolvedValue(camStream)
    mockPc.createOffer.mockClear()

    // Remote offer pending (e.g. downstream offer mid-flight).
    mockPc.signalingState = 'have-remote-offer'
    const stream = await client.setCameraEnabled(true)
    expect(stream).toBe(camStream)
    expect(mockVideoSender.replaceTrack).toHaveBeenCalledWith(camTrack)
    expect(mockPc.createOffer).not.toHaveBeenCalled()
    expect(client.isCameraActive()).toBe(true)

    client.disconnect()
  })
})
