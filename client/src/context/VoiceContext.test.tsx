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

  it('handles session reset (Opcode 9) by disconnecting SFU and clearing voice state', async () => {
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

    expect(sfu.disconnect).toHaveBeenCalled()
    expect(voiceValue?.activeVoice).toBeNull()
    expect(voiceValue?.connectionStatus).toBe('disconnected')
    expect(voiceValue?.speakingUsers.size).toBe(0)
  })
})
