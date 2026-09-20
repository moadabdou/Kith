import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SfuClient, resolveSfuWsUrl } from './sfu-client'

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

    // Mock RTCPeerConnection
    mockPc = {
      connectionState: 'new',
      remoteDescription: null,
      onicecandidate: null,
      onconnectionstatechange: null,
      ontrack: null,
      addTrack: vi.fn(),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      createOffer: vi.fn().mockResolvedValue({ sdp: 'v=0 local-offer' }),
      createAnswer: vi.fn().mockResolvedValue({ sdp: 'v=0 local-answer' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockImplementation(async (desc: any) => {
        mockPc.remoteDescription = desc
      }),
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
    })

    await client.connect()

    // Transition to connected
    mockPc.connectionState = 'connected'
    mockPc.onconnectionstatechange()
    expect(onStateChange).toHaveBeenCalledWith('connected')

    // Transition to failed
    mockPc.connectionState = 'failed'
    mockPc.onconnectionstatechange()
    expect(onStateChange).toHaveBeenCalledWith('failed')

    // Transition to disconnected
    mockPc.connectionState = 'disconnected'
    mockPc.onconnectionstatechange()
    expect(onStateChange).toHaveBeenCalledWith('disconnected')

    client.disconnect()
  })

  it('toggles microphone mute and deafen state', async () => {
    const client = new SfuClient({
      endpoint: '127.0.0.1:5000',
      token: 'jwt-token-123',
      channelId: 'voice-chan-1',
    })

    await client.connect()

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
    client.disconnect()

    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'leave' }))
    expect(mockAudioTrack.stop).toHaveBeenCalled()
    expect(mockPc.close).toHaveBeenCalled()
    expect(mockWs.close).toHaveBeenCalled()
  })

  it('enables and disables camera, executing renegotiation with SFU', async () => {
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

    const mockSender = {
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    }
    mockPc.addTrack.mockReturnValue(mockSender)
    mockPc.removeTrack = vi.fn()

    // Enable camera
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
    expect(mockPc.addTrack).toHaveBeenCalledWith(mockVideoTrack, mockVideoStream)
    expect(onLocalVideo).toHaveBeenCalledWith(mockVideoStream)

    // Disable camera
    await client.setCameraEnabled(false)
    expect(client.isCameraActive()).toBe(false)
    expect(mockVideoTrack.stop).toHaveBeenCalled()
    expect(mockPc.removeTrack).toHaveBeenCalledWith(mockSender)
    expect(onLocalVideo).toHaveBeenCalledWith(null)

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
})
