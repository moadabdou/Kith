import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelSidebar } from './ChannelSidebar'
import type { Channel, Guild } from '../../types'
import { EMPTY_MENTION_STATE } from '../../lib/mentionCounts'

vi.mock('../../context/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', discriminator: '0001' },
    logout: vi.fn(),
  }),
}))

vi.mock('../../context/useVoice', () => ({
  useVoice: () => ({
    selfMute: false,
    selfDeaf: false,
    activeVoice: null,
    getChannelVoiceStates: () => [],
    speakingUsers: new Set(),
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
    joinVoice: vi.fn(),
  }),
}))

vi.mock('../../gateway/useGateway', () => ({
  useGateway: () => ({
    subscribeToMessages: () => () => {},
    subscribeToMessageAcks: () => () => {},
    subscribeToMemberUpdates: () => () => {},
    subscribeToRoleUpdates: () => () => {},
    subscribeToRoleDeletes: () => () => {},
  }),
}))

vi.mock('../../api', () => ({
  api: {
    getChannelLatestMessages: vi.fn().mockResolvedValue([]),
    getReadStates: vi.fn().mockResolvedValue([]),
    getGuildMembers: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn().mockResolvedValue([]),
  },
}))

const storage: Record<string, string> = {}
const mockLocalStorage = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, val: string) => {
    storage[key] = String(val)
  },
  removeItem: (key: string) => {
    delete storage[key]
  },
  clear: () => {
    for (const key of Object.keys(storage)) {
      delete storage[key]
    }
  },
}

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

describe('ChannelSidebar collapsible categories and action buttons', () => {
  const dummyGuild: Guild = {
    id: 'guild-100',
    name: 'Test Guild',
    owner_id: 'user-1',
    created_at: new Date().toISOString(),
  }

  const dummyChannels: Channel[] = [
    {
      id: 'chan-text-1',
      guild_id: 'guild-100',
      name: 'general',
      type: 0,
      position: 0,
      created_at: new Date().toISOString(),
    },
    {
      id: 'chan-voice-1',
      guild_id: 'guild-100',
      name: 'Lounge',
      type: 2,
      position: 1,
      created_at: new Date().toISOString(),
    },
  ]

  beforeEach(() => {
    mockLocalStorage.clear()
  })

  it('renders category toggle buttons with chevron icons', () => {
    const html = renderToStaticMarkup(
      <ChannelSidebar
        currentGuild={dummyGuild}
        channels={dummyChannels}
        selectedChannelId="chan-text-1"
        onSelectChannel={vi.fn()}
        onOpenCreateChannelModal={vi.fn()}
        onOpenInviteModal={vi.fn()}
        onOpenChannelSettingsModal={vi.fn()}
        mentionState={EMPTY_MENTION_STATE}
        setMentionState={vi.fn()}
      />
    )

    expect(html).toContain('category-toggle-btn')
    expect(html).toContain('Text Channels')
    expect(html).toContain('Voice Channels')
    expect(html).toContain('category-chevron')
    expect(html).toContain('general')
    expect(html).toContain('Lounge')
  })

  it('renders hover-reveal quick invite and settings action buttons on channel items', () => {
    const html = renderToStaticMarkup(
      <ChannelSidebar
        currentGuild={dummyGuild}
        channels={dummyChannels}
        selectedChannelId="chan-text-1"
        onSelectChannel={vi.fn()}
        onOpenCreateChannelModal={vi.fn()}
        onOpenInviteModal={vi.fn()}
        onOpenChannelSettingsModal={vi.fn()}
        mentionState={EMPTY_MENTION_STATE}
        setMentionState={vi.fn()}
      />
    )

    expect(html).toContain('channel-invite-btn')
    expect(html).toContain('title="Create Invite"')
    expect(html).toContain('channel-settings-btn')
    expect(html).toContain('title="Edit Channel"')
  })

  it('respects stored collapsed state from localStorage', () => {
    localStorage.setItem(
      'kith_collapsed_categories',
      JSON.stringify({
        'guild-100:text': true,
      })
    )

    const html = renderToStaticMarkup(
      <ChannelSidebar
        currentGuild={dummyGuild}
        channels={dummyChannels}
        selectedChannelId="chan-text-1"
        onSelectChannel={vi.fn()}
        onOpenCreateChannelModal={vi.fn()}
        onOpenInviteModal={vi.fn()}
        mentionState={EMPTY_MENTION_STATE}
        setMentionState={vi.fn()}
      />
    )

    // Text channels should be collapsed, so "general" channel is not rendered
    expect(html).not.toContain('general')
    // Voice channels should remain expanded
    expect(html).toContain('Lounge')
    // Chevron should have collapsed class
    expect(html).toContain('category-chevron collapsed')
  })

  it('displays mention badge on collapsed category when unread mentions exist inside', () => {
    localStorage.setItem(
      'kith_collapsed_categories',
      JSON.stringify({
        'guild-100:text': true,
      })
    )

    const mentionStateWithUnread = {
      counts: {
        'chan-text-1': 5,
      },
      firstIds: {},
    }

    const html = renderToStaticMarkup(
      <ChannelSidebar
        currentGuild={dummyGuild}
        channels={dummyChannels}
        selectedChannelId="chan-voice-1"
        onSelectChannel={vi.fn()}
        onOpenCreateChannelModal={vi.fn()}
        onOpenInviteModal={vi.fn()}
        mentionState={mentionStateWithUnread}
        setMentionState={vi.fn()}
      />
    )

    expect(html).toContain('category-mention-pill')
    expect(html).toContain('5')
  })

  it('renders redesigned user deck with avatar, presence dot, audio buttons and settings gear', () => {
    const onOpenUserSettings = vi.fn()
    const html = renderToStaticMarkup(
      <ChannelSidebar
        currentGuild={dummyGuild}
        channels={dummyChannels}
        selectedChannelId="chan-text-1"
        onSelectChannel={vi.fn()}
        onOpenCreateChannelModal={vi.fn()}
        onOpenInviteModal={vi.fn()}
        onOpenUserSettings={onOpenUserSettings}
        presenceStatus="online"
        mentionState={EMPTY_MENTION_STATE}
        setMentionState={vi.fn()}
      />
    )

    expect(html).toContain('user-profile-bar')
    expect(html).toContain('user-avatar-wrap')
    expect(html).toContain('user-presence-dot')
    expect(html).toContain('user-username')
    expect(html).toContain('tester')
    expect(html).toContain('#0001')
    expect(html).toContain('user-controls')
    expect(html).toContain('aria-label="User Settings"')
    expect(html).toContain('aria-label="Mute"')
    expect(html).toContain('aria-label="Deafen"')
  })
})
