import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceProvider } from './VoiceContext'
import { useVoice } from './useVoice'

// Configure React 19 act environment
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Minimal DOM mocks for React 19 createRoot in Node environment
class MockHTMLIFrameElement {}
class MockNode {}
;(globalThis as any).HTMLIFrameElement = MockHTMLIFrameElement
;(globalThis as any).Node = MockNode

function createMockElement(tag = 'div') {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [] as any[],
    style: {},
    setAttribute: () => {},
    removeAttribute: () => {},
    appendChild: function (c: any) {
      this.children.push(c)
      return c
    },
    removeChild: function (c: any) {
      return c
    },
    insertBefore: function (c: any) {
      return c
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    ownerDocument: null as any,
  }
}

const mockDoc = {
  nodeType: 9,
  defaultView: globalThis,
  createElement: (tag: string) => {
    const el = createMockElement(tag)
    el.ownerDocument = mockDoc
    return el
  },
  createElementNS: (_ns: string, tag: string) => {
    const el = createMockElement(tag)
    el.ownerDocument = mockDoc
    return el
  },
  createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
  createComment: (t: string) => ({ nodeType: 8, textContent: t }),
  addEventListener: () => {},
  removeEventListener: () => {},
}

;(globalThis as any).document = mockDoc
;(globalThis as any).window = globalThis

// Mocks for useAuth and useGateway
let mockUser: any = { id: 'user-self', username: 'Moad' }
let gatewayListeners: {
  voiceStateUpdates: ((payload: any) => void)[]
  voiceServerUpdates: ((payload: any) => void)[]
  ready: ((data: any) => void)[]
  sessionReset: (() => void)[]
}
let sendVoiceStateUpdateMock: any

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}))

vi.mock('../gateway/useGateway', () => ({
  useGateway: () => ({
    sendVoiceStateUpdate: sendVoiceStateUpdateMock,
    subscribeToVoiceStateUpdates: (cb: any) => {
      gatewayListeners.voiceStateUpdates.push(cb)
      return () => {
        gatewayListeners.voiceStateUpdates = gatewayListeners.voiceStateUpdates.filter((x) => x !== cb)
      }
    },
    subscribeToVoiceServerUpdates: (cb: any) => {
      gatewayListeners.voiceServerUpdates.push(cb)
      return () => {
        gatewayListeners.voiceServerUpdates = gatewayListeners.voiceServerUpdates.filter((x) => x !== cb)
      }
    },
    subscribeToReady: (cb: any) => {
      gatewayListeners.ready.push(cb)
      return () => {
        gatewayListeners.ready = gatewayListeners.ready.filter((x) => x !== cb)
      }
    },
    onSessionReset: (cb: any) => {
      gatewayListeners.sessionReset.push(cb)
      return () => {
        gatewayListeners.sessionReset = gatewayListeners.sessionReset.filter((x) => x !== cb)
      }
    },
  }),
}))

// Mock video-devices
let mockVideoDevices = [
  { deviceId: 'cam-1', label: 'FaceTime HD Camera', kind: 'videoinput' } as MediaDeviceInfo,
  { deviceId: 'cam-2', label: 'External USB Cam', kind: 'videoinput' } as MediaDeviceInfo,
]
let deviceChangeCb: any = null
vi.mock('../lib/video-devices', () => ({
  getVideoInputDevices: vi.fn().mockImplementation(() => Promise.resolve(mockVideoDevices)),
  onDeviceChange: vi.fn().mockImplementation((cb) => {
    deviceChangeCb = cb
    return () => { deviceChangeCb = null }
  }),
}))

// Mock SfuClient
let sfuClientInstances: any[] = []
vi.mock('../lib/sfu-client', async (importOriginal) => {
  const actual: any = await importOriginal()
  class MockSfuClient {
    public options: any
    public connect = vi.fn().mockResolvedValue(undefined)
    public disconnect = vi.fn()
    public setMute = vi.fn()
    public setDeaf = vi.fn()
    public setCameraEnabled = vi.fn().mockImplementation((enabled: boolean) => {
      const mockStream = enabled ? ({ id: 'stream-local-cam', getVideoTracks: () => [{ id: 'track-1' }] } as any) : null
      this.options?.onLocalVideoChange?.(mockStream)
      return Promise.resolve(mockStream)
    })
    public setCameraDevice = vi.fn().mockImplementation((_devId: string) => {
      const mockStream = { id: 'stream-switched', getVideoTracks: () => [{ id: 'track-switched' }] } as any
      this.options?.onLocalVideoChange?.(mockStream)
      return Promise.resolve(mockStream)
    })

    constructor(options: any) {
      this.options = options
      sfuClientInstances.push(this)
    }
  }

  return {
    ...actual,
    SfuClient: MockSfuClient,
  }
})

describe('VoiceContext Client Integration (Phase 5c / Issue #74)', () => {
  let voiceValue: ReturnType<typeof useVoice> | null = null
  let root: any = null

  function Consumer() {
    const val = useVoice()
    useEffect(() => {
      voiceValue = val
    })
    return null
  }

  beforeEach(async () => {
    mockUser = { id: 'user-self', username: 'Moad' }
    sfuClientInstances = []
    gatewayListeners = {
      voiceStateUpdates: [],
      voiceServerUpdates: [],
      ready: [],
      sessionReset: [],
    }
    sendVoiceStateUpdateMock = vi.fn()
    voiceValue = null

    const rootEl = createMockElement('div')
    rootEl.ownerDocument = mockDoc
    root = createRoot(rootEl as any)

    await act(async () => {
      root.render(
        React.createElement(
          VoiceProvider,
          null,
          React.createElement(Consumer)
        )
      )
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    vi.clearAllMocks()
  })

  it('hydrates initial voice state when current user is in a channel on READY', async () => {
    await act(async () => {
      gatewayListeners.ready.forEach((cb) =>
        cb({
          guilds: [
            {
              id: 'guild-100',
              voice_states: {
                'user-self': {
                  guild_id: 'guild-100',
                  channel_id: 'voice-chan-100',
                  user_id: 'user-self',
                  self_mute: true,
                  self_deaf: false,
                },
              },
            },
          ],
        })
      )
    })

    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-100',
      channelId: 'voice-chan-100',
    })
    expect(voiceValue?.connectionStatus).toBe('connecting')
    expect(voiceValue?.selfMute).toBe(true)
    expect(voiceValue?.selfDeaf).toBe(false)
  })

  it('joins voice channel and sends Gateway VOICE_STATE_UPDATE (Opcode 4)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
    })

    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-1',
      channelId: 'channel-voice-1',
    })
    expect(voiceValue?.connectionStatus).toBe('connecting')
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith('guild-1', 'channel-voice-1', false, false)
  })

  it('handles Gateway VOICE_SERVER_UPDATE, connects to SFU, and transitions to connected', async () => {
    // Join channel
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
    })

    // Gateway dispatches VOICE_SERVER_UPDATE with Pion SFU endpoint & JWT token
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: 'sfu.kith.local:7000',
          token: 'jwt-voice-auth-token',
        })
      )
    })

    expect(sfuClientInstances.length).toBe(1)
    const sfu = sfuClientInstances[0]
    expect(sfu.options.endpoint).toBe('sfu.kith.local:7000')
    expect(sfu.options.token).toBe('jwt-voice-auth-token')
    expect(sfu.options.channelId).toBe('channel-voice-1')
    expect(sfu.options.guildId).toBe('guild-1')
    expect(sfu.connect).toHaveBeenCalled()

    // SFU signals connected
    await act(async () => {
      sfu.options.onConnectionStateChange('connected')
    })

    expect(voiceValue?.connectionStatus).toBe('connected')
  })

  it('ignores duplicate VOICE_SERVER_UPDATEs for the same connected session', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    expect(sfuClientInstances.length).toBe(1)
    const sfu = sfuClientInstances[0]

    await act(async () => {
      sfu.options.onConnectionStateChange('connected')
    })
    expect(voiceValue?.connectionStatus).toBe('connected')

    // Duplicate re-emit (token refresh / state re-push): must NOT rebuild.
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-refreshed',
        })
      )
    })

    expect(sfuClientInstances.length).toBe(1)
    expect(sfu.disconnect).not.toHaveBeenCalled()
    expect(voiceValue?.connectionStatus).toBe('connected')
  })

  it('rebuilds the SFU session when the endpoint actually changes', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const first = sfuClientInstances[0]
    await act(async () => {
      first.options.onConnectionStateChange('connected')
    })

    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '10.9.9.9:5000',
          token: 'token-new-transport',
        })
      )
    })

    expect(sfuClientInstances.length).toBe(2)
    expect(first.disconnect).toHaveBeenCalled()
  })

  it('updates speaking indicators for remote peers and current user', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // Peer 'user-bob' starts speaking
    await act(async () => {
      sfu.options.onSpeakingChange('user-bob', true)
    })
    expect(voiceValue?.speakingUsers.has('user-bob')).toBe(true)
    expect(voiceValue?.isSpeaking).toBe(false)

    // Current user 'user-self' starts speaking
    await act(async () => {
      sfu.options.onSpeakingChange('user-self', true)
    })
    expect(voiceValue?.speakingUsers.has('user-self')).toBe(true)
    expect(voiceValue?.isSpeaking).toBe(true)

    // Peer 'user-bob' stops speaking
    await act(async () => {
      sfu.options.onSpeakingChange('user-bob', false)
    })
    expect(voiceValue?.speakingUsers.has('user-bob')).toBe(false)
    expect(voiceValue?.speakingUsers.has('user-self')).toBe(true)
    expect(voiceValue?.isSpeaking).toBe(true)

    // Current user stops speaking
    await act(async () => {
      sfu.options.onSpeakingChange('user-self', false)
    })
    expect(voiceValue?.speakingUsers.has('user-self')).toBe(false)
    expect(voiceValue?.isSpeaking).toBe(false)
  })

  it('toggles mute and deafen, updating SFU client and Gateway in real time', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // Toggle mute
    await act(async () => {
      voiceValue?.toggleMute()
    })

    expect(voiceValue?.selfMute).toBe(true)
    expect(sfu.setMute).toHaveBeenCalledWith(true)
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith('guild-1', 'channel-voice-1', true, false)

    // Toggle deafen (auto-mutes as well)
    await act(async () => {
      voiceValue?.toggleDeaf()
    })

    expect(voiceValue?.selfDeaf).toBe(true)
    expect(voiceValue?.selfMute).toBe(true)
    expect(sfu.setDeaf).toHaveBeenCalledWith(true)
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith('guild-1', 'channel-voice-1', true, true)
  })

  it('clears speaking users when peer leaves via VOICE_STATE_UPDATE (channel_id: null)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // 'user-alice' speaking
    await act(async () => {
      sfu.options.onSpeakingChange('user-alice', true)
    })
    expect(voiceValue?.speakingUsers.has('user-alice')).toBe(true)

    // 'user-alice' disconnects from voice channel
    await act(async () => {
      gatewayListeners.voiceStateUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: null,
          user_id: 'user-alice',
        })
      )
    })

    // User is immediately pruned from speakingUsers
    expect(voiceValue?.speakingUsers.has('user-alice')).toBe(false)
  })

  it('handles remote leave reconciliation when current user is disconnected by server', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // Gateway dispatches leave for current user (e.g. kicked, server cleanup on ICE drop)
    await act(async () => {
      gatewayListeners.voiceStateUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: null,
          user_id: 'user-self',
        })
      )
    })

    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.activeVoice).toBeNull()
    expect(voiceValue?.connectionStatus).toBe('disconnected')
    expect(voiceValue?.isSpeaking).toBe(false)
  })

  it('leaves voice on leaveVoice() action, disconnecting SFU and updating Gateway', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    await act(async () => {
      voiceValue?.leaveVoice()
    })

    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.activeVoice).toBeNull()
    expect(voiceValue?.connectionStatus).toBe('disconnected')
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith('guild-1', null, false, false)
  })

  it('handles session reset (Opcode 9) by parking SFU transport but preserving voice intent', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // Gateway fires session reset
    await act(async () => {
      gatewayListeners.sessionReset.forEach((cb) => cb())
    })

    // Transport torn down…
    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.speakingUsers.size).toBe(0)
    // …but intent preserved: still parked on the channel, reconnecting.
    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-1',
      channelId: 'channel-voice-1',
    })
    expect(voiceValue?.connectionStatus).toBe('connecting')
  })

  it('volunteers preserved intent via Op 4 when READY snapshot misses us (actor restart)', async () => {
    // Join, then suffer a session reset (intent preserved, transport parked)
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })
    await act(async () => {
      gatewayListeners.sessionReset.forEach((cb) => cb())
    })
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(1) // join only
    sendVoiceStateUpdateMock.mockClear()

    // Fresh READY whose snapshot forgot us (restarted actor, empty map)
    await act(async () => {
      gatewayListeners.ready.forEach((cb) =>
        cb({
          user: { id: 'user-self' },
          guilds: [{ id: 'guild-1', voice_states: {} }],
        })
      )
    })

    // Client volunteers its intent — actor treats it as a fresh join.
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith(
      'guild-1',
      'channel-voice-1',
      false,
      false
    )
    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-1',
      channelId: 'channel-voice-1',
    })
    expect(voiceValue?.connectionStatus).toBe('connecting')
  })

  it('adopts the READY snapshot when it lists us (no redundant Op 4)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
    })
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(1)
    sendVoiceStateUpdateMock.mockClear()

    // READY snapshot knows us — adopt, don't re-speak.
    await act(async () => {
      gatewayListeners.ready.forEach((cb) =>
        cb({
          user: { id: 'user-self' },
          guilds: [
            {
              id: 'guild-1',
              voice_states: {
                'user-self': {
                  guild_id: 'guild-1',
                  channel_id: 'channel-voice-1',
                  user_id: 'user-self',
                  self_mute: true,
                  self_deaf: false,
                },
              },
            },
          ],
        })
      )
    })

    // Snapshot-hit path re-confirms via Op 4 (existing restore behavior)…
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith('guild-1', 'channel-voice-1', true, false)
    expect(voiceValue?.selfMute).toBe(true)
    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-1',
      channelId: 'channel-voice-1',
    })
  })

  it('stays silent on READY miss with no intent (explicit leave is not resurrected)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      voiceValue?.leaveVoice()
    })
    sendVoiceStateUpdateMock.mockClear()

    await act(async () => {
      gatewayListeners.sessionReset.forEach((cb) => cb())
    })

    await act(async () => {
      gatewayListeners.ready.forEach((cb) =>
        cb({
          user: { id: 'user-self' },
          guilds: [{ id: 'guild-1', voice_states: {} }],
        })
      )
    })

    expect(sendVoiceStateUpdateMock).not.toHaveBeenCalled()
    expect(voiceValue?.activeVoice).toBeNull()
    expect(voiceValue?.connectionStatus).toBe('disconnected')
  })

  it('re-requests voice server via Op 4 when SFU media fails (failover hint)', async () => {    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(1) // join only
    sendVoiceStateUpdateMock.mockClear()

    // SfuClient exhausts recovery and gives up.
    await act(async () => {
      sfu.options.onConnectionStateChange?.('failed')
    })

    // Client solicits fresh placement; parks in connecting, not disconnected.
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith(
      'guild-1',
      'channel-voice-1',
      false,
      false
    )
    expect(voiceValue?.connectionStatus).toBe('connecting')
  })

  it('caps SFU failover re-requests and surfaces disconnected when exhausted', async () => {    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    sendVoiceStateUpdateMock.mockClear()

    // Fail past the budget (5): each failure re-requests until exhausted.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        sfu.options.onConnectionStateChange?.('failed')
      })
    }

    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(5)
    expect(voiceValue?.connectionStatus).toBe('disconnected')
  })

  it('resets the failover budget on fresh server update and on connect', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    sendVoiceStateUpdateMock.mockClear()

    // Two failures consume budget…
    await act(async () => {
      sfu.options.onConnectionStateChange?.('failed')
    })
    await act(async () => {
      sfu.options.onConnectionStateChange?.('failed')
    })
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(2)

    // …but a fresh allocation resets it: 5 more allowed, not 3.
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5001',
          token: 'token-def',
        })
      )
    })
    sendVoiceStateUpdateMock.mockClear()

    const sfu2 = sfuClientInstances[sfuClientInstances.length - 1]
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        sfu2.options.onConnectionStateChange?.('failed')
      })
    }
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(5)

    // And a successful connect resets too (no throw on the 6th — budget
    // was refreshed by the connect before these failures… assert via a
    // fresh cycle instead: connect, then fail once more → re-requests).
    await act(async () => {
      sfu2.options.onConnectionStateChange?.('connected')
    })
    sendVoiceStateUpdateMock.mockClear()
    await act(async () => {
      sfu2.options.onConnectionStateChange?.('failed')
    })
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('parks on null endpoint and rebuilds on the fresh allocation (no Op 4 storm)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    sendVoiceStateUpdateMock.mockClear()

    // Gateway declares the SFU dead: null arrives first.
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: null,
          token: 'token-null',
        })
      )
    })

    // Transport torn down, parked in connecting, NO Op 4 (reallocation
    // is coming — soliciting now would just get the same answer).
    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.connectionStatus).toBe('connecting')
    expect(voiceValue?.activeVoice).toEqual({
      guildId: 'guild-1',
      channelId: 'channel-voice-1',
    })
    expect(sendVoiceStateUpdateMock).not.toHaveBeenCalled()

    // A media failure while parked burns no budget and solicits nothing.
    await act(async () => {
      sfu.options.onConnectionStateChange?.('failed')
    })
    expect(sendVoiceStateUpdateMock).not.toHaveBeenCalled()

    // Fresh allocation arrives → rebuild on the survivor.
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5001',
          token: 'token-def',
        })
      )
    })

    expect(sfuClientInstances.length).toBe(2)
    const sfu2 = sfuClientInstances[1]
    expect(sfu2.options.endpoint).toBe('127.0.0.1:5001')
    expect(voiceValue?.connectionStatus).toBe('connecting')
  })

  it('ignores a stale null naming an SFU we already left (confirm fast lane won the race)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    // Fast lane: fresh allocation on the survivor arrives FIRST (confirm
    // path answered before the poller flipped + null-push went out).
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5001',
          token: 'token-def',
        })
      )
    })
    expect(sfuClientInstances.length).toBe(2)
    // Forget the joinVoice Op 4: from here only failover traffic counts.
    sendVoiceStateUpdateMock.mockClear()

    // Late null names the OLD endpoint — must not tear down the healthy
    // session on :5001.
    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: null,
          token: 'token-null',
          dead_endpoint: '127.0.0.1:5000',
        })
      )
    })

    const survivor = sfuClientInstances[1]
    expect(survivor.disconnect).not.toHaveBeenCalled()
    expect(sfuClientInstances.length).toBe(2)
    expect(sendVoiceStateUpdateMock).not.toHaveBeenCalled()
  })

  it('parks on a legacy null with no dead_endpoint (fail-closed)', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]

    await act(async () => {
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: null,
          token: 'token-null',
        })
      )
    })

    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.connectionStatus).toBe('connecting')
  })

  it('surfaces disconnected (intent kept) when the reallocation never arrives', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        voiceValue?.joinVoice('guild-1', 'channel-voice-1')
        gatewayListeners.voiceServerUpdates.forEach((cb) =>
          cb({
            guild_id: 'guild-1',
            channel_id: 'channel-voice-1',
            endpoint: '127.0.0.1:5000',
            token: 'token-abc',
          })
        )
      })
      sendVoiceStateUpdateMock.mockClear()

      await act(async () => {
        gatewayListeners.voiceServerUpdates.forEach((cb) =>
          cb({
            guild_id: 'guild-1',
            channel_id: 'channel-voice-1',
            endpoint: null,
            token: 'token-null',
          })
        )
      })
      expect(voiceValue?.connectionStatus).toBe('connecting')

      // Let the 15s reallocation window expire.
      await act(async () => {
        vi.advanceTimersByTime(16_000)
      })

      expect(voiceValue?.connectionStatus).toBe('disconnected')
      // No solicit on timeout (gateway wedged — don't storm it)…
      expect(sendVoiceStateUpdateMock).not.toHaveBeenCalled()
      // …but the intent survives for the next READY to volunteer.
      expect(voiceValue?.activeVoice).toEqual({
        guildId: 'guild-1',
        channelId: 'channel-voice-1',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('populates video devices and reacts to devicechange events', async () => {
    expect(voiceValue?.videoDevices).toHaveLength(2)
    expect(voiceValue?.videoDevices[0].deviceId).toBe('cam-1')

    await act(async () => {
      deviceChangeCb?.([
        { deviceId: 'cam-3', label: 'New WebCam', kind: 'videoinput' } as MediaDeviceInfo,
      ])
    })

    expect(voiceValue?.videoDevices).toHaveLength(1)
    expect(voiceValue?.videoDevices[0].deviceId).toBe('cam-3')
  })

  it('toggles camera on and off and switches camera devices', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    expect(voiceValue?.isCameraOn).toBe(false)
    expect(voiceValue?.localVideoStream).toBeNull()

    // Toggle camera ON
    await act(async () => {
      await voiceValue?.toggleCamera()
    })

    expect(sfu.setCameraEnabled).toHaveBeenCalledWith(true, undefined)
    expect(voiceValue?.isCameraOn).toBe(true)
    expect(voiceValue?.localVideoStream?.id).toBe('stream-local-cam')

    // Switch camera device
    await act(async () => {
      await voiceValue?.setSelectedCameraId('cam-2')
    })

    expect(sfu.setCameraDevice).toHaveBeenCalledWith('cam-2')
    expect(voiceValue?.selectedCameraId).toBe('cam-2')

    // Toggle camera OFF
    await act(async () => {
      await voiceValue?.toggleCamera()
    })

    expect(sfu.setCameraEnabled).toHaveBeenCalledWith(false, 'cam-2')
    expect(voiceValue?.isCameraOn).toBe(false)
    expect(voiceValue?.localVideoStream).toBeNull()
  })

  it('receives remote video stream updates from SFU client', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    const remoteStream = { id: 'remote-stream-u2' } as MediaStream

    await act(async () => {
      sfu.options.onRemoteVideoChange?.('user-2', remoteStream)
    })

    expect(voiceValue?.remoteVideoStreams.get('user-2')).toBe(remoteStream)
  })

  // Images 4-5: a real connection drop must clear remote media state so a
  // rejoin starts clean instead of rendering the previous session's ghosts.
  // (Phase 7d: `failed` now parks in `connecting` + re-requests placement
  // instead of surfacing `disconnected` — the media-clearing contract is
  // unchanged, only the status transition moved.)
  it('clears remote video and screen maps when the SFU connection drops', async () => {
    await act(async () => {
      voiceValue?.joinVoice('guild-1', 'channel-voice-1')
      gatewayListeners.voiceServerUpdates.forEach((cb) =>
        cb({
          guild_id: 'guild-1',
          channel_id: 'channel-voice-1',
          endpoint: '127.0.0.1:5000',
          token: 'token-abc',
        })
      )
    })

    const sfu = sfuClientInstances[0]
    const remoteVideo = { id: 'remote-video-u2' } as MediaStream
    const remoteScreen = { id: 'remote-screen-u2' } as MediaStream

    await act(async () => {
      sfu.options.onConnectionStateChange('connected')
      sfu.options.onRemoteVideoChange?.('user-2', remoteVideo)
      sfu.options.onRemoteScreenShareChange?.('user-2', remoteScreen)
    })
    expect(voiceValue?.remoteVideoStreams.get('user-2')).toBe(remoteVideo)
    expect(voiceValue?.remoteScreenStreams.get('user-2')).toBe(remoteScreen)

    await act(async () => {
      sfu.options.onConnectionStateChange('failed')
    })

    // Parked for failover (re-request sent), media cleared for a clean rejoin.
    expect(voiceValue?.connectionStatus).toBe('connecting')
    expect(sendVoiceStateUpdateMock).toHaveBeenCalledWith(
      'guild-1',
      'channel-voice-1',
      false,
      false
    )
    expect(voiceValue?.remoteVideoStreams.has('user-2')).toBe(false)
    expect(voiceValue?.remoteScreenStreams.has('user-2')).toBe(false)
  })
})
