import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoicePipMiniPlayer } from './VoicePipMiniPlayer'
import type { Channel, Guild } from '../../types'

const mockLeaveVoice = vi.fn()
const mockToggleMute = vi.fn()
const mockToggleDeaf = vi.fn()
const mockToggleCamera = vi.fn()
const mockToggleScreenShare = vi.fn()

let mockActiveVoice: { guildId: string; channelId: string } | null = {
  guildId: 'guild-1',
  channelId: 'channel-voice-1',
}
let mockIsScreenSharing = false
let mockIsCameraOn = false
let mockSpeakingUsers = new Set<string>()
let mockRemoteScreenStreams = new Map<string, MediaStream>()
let mockRemoteVideoStreams = new Map<string, MediaStream>()

vi.mock('../../context/useVoice', () => ({
  useVoice: () => ({
    activeVoice: mockActiveVoice,
    connectionStatus: 'connected',
    selfMute: false,
    selfDeaf: false,
    toggleMute: mockToggleMute,
    toggleDeaf: mockToggleDeaf,
    isCameraOn: mockIsCameraOn,
    toggleCamera: mockToggleCamera,
    isScreenSharing: mockIsScreenSharing,
    toggleScreenShare: mockToggleScreenShare,
    leaveVoice: mockLeaveVoice,
    localVideoStream: null,
    remoteVideoStreams: mockRemoteVideoStreams,
    localScreenStream: null,
    remoteScreenStreams: mockRemoteScreenStreams,
    speakingUsers: mockSpeakingUsers,
    getChannelVoiceStates: () => [
      { user_id: 'user-1', self_mute: false, self_deaf: false },
      { user_id: 'user-2', self_mute: true, self_deaf: false },
    ],
  }),
}))

vi.mock('../../context/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'Tester' },
  }),
}))

describe('VoicePipMiniPlayer Component', () => {
  const mockGuild: Guild = {
    id: 'guild-1',
    name: 'Awesome Server',
    owner_id: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
  }

  const mockChannels: Channel[] = [
    {
      id: 'channel-voice-1',
      guild_id: 'guild-1',
      name: 'General Voice',
      type: 2,
      position: 1,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'channel-text-1',
      guild_id: 'guild-1',
      name: 'general-chat',
      type: 0,
      position: 0,
      created_at: '2026-01-01T00:00:00Z',
    },
  ]

  const mockOnReturn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveVoice = { guildId: 'guild-1', channelId: 'channel-voice-1' }
    mockIsScreenSharing = false
    mockIsCameraOn = false
    mockSpeakingUsers = new Set<string>()
    mockRemoteScreenStreams = new Map()
    mockRemoteVideoStreams = new Map()
  })

  it('renders nothing if activeVoice is null', () => {
    mockActiveVoice = null
    const html = renderToStaticMarkup(
      <VoicePipMiniPlayer
        currentGuild={mockGuild}
        channels={mockChannels}
        onReturnToVoice={mockOnReturn}
      />
    )
    expect(html).toBe('')
  })

  it('renders PiP container with channel name, guild name, and fallback stage', () => {
    const html = renderToStaticMarkup(
      <VoicePipMiniPlayer
        currentGuild={mockGuild}
        channels={mockChannels}
        onReturnToVoice={mockOnReturn}
      />
    )

    expect(html).toContain('voice-pip-container')
    expect(html).toContain('General Voice')
    expect(html).toContain('Awesome Server')
    expect(html).toContain('2 in voice')
    expect(html).toContain('voice-pip-fallback-stage')
    expect(html).toContain('Return to Call')
  })

  it('renders floating call controls with tooltips', () => {
    const html = renderToStaticMarkup(
      <VoicePipMiniPlayer
        currentGuild={mockGuild}
        channels={mockChannels}
        onReturnToVoice={mockOnReturn}
      />
    )

    expect(html).toContain('title="Mute"')
    expect(html).toContain('title="Deafen"')
    expect(html).toContain('title="Turn on camera"')
    expect(html).toContain('title="Share screen"')
    expect(html).toContain('title="Disconnect from call"')
    expect(html).toContain('title="Return to Voice Channel"')
  })

  it('renders video element and screenshare badge when screen stream is available', () => {
    const mockTrack = { id: 'track-1', readyState: 'live', enabled: true } as any
    const mockStream = {
      id: 'stream-screen-1',
      getVideoTracks: () => [mockTrack],
    } as any

    mockRemoteScreenStreams.set('user-2', mockStream)

    const html = renderToStaticMarkup(
      <VoicePipMiniPlayer
        currentGuild={mockGuild}
        channels={mockChannels}
        onReturnToVoice={mockOnReturn}
      />
    )

    expect(html).toContain('<video')
    expect(html).toContain('Screenshare')
    expect(html).toContain('voice-pip-video')
  })

  it('renders speaker video badge when remote camera stream is available', () => {
    const mockTrack = { id: 'track-2', readyState: 'live', enabled: true } as any
    const mockStream = {
      id: 'stream-cam-1',
      getVideoTracks: () => [mockTrack],
    } as any

    mockSpeakingUsers.add('user-2')
    mockRemoteVideoStreams.set('user-2', mockStream)

    const html = renderToStaticMarkup(
      <VoicePipMiniPlayer
        currentGuild={mockGuild}
        channels={mockChannels}
        onReturnToVoice={mockOnReturn}
      />
    )

    expect(html).toContain('<video')
    expect(html).toContain('Speaker Video')
  })
})
