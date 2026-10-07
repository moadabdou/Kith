import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatEmptyState } from './ChatEmptyState'
import type { Channel, Guild } from '../../types'

describe('ChatEmptyState', () => {
  it('renders welcome hero with create server CTA when no servers exist', () => {
    const html = renderToStaticMarkup(
      <ChatEmptyState
        currentGuild={null}
        guilds={[]}
        channels={[]}
        onOpenCreateGuildModal={vi.fn()}
      />
    )

    expect(html).toContain('Welcome to Kith')
    expect(html).toContain('Create a Server')
    expect(html).toContain('Channels &amp; Text')
    expect(html).toContain('Voice &amp; Video')
    expect(html).toContain('Roles &amp; Perms')
  })

  it('renders server selection view with your servers list when guilds exist', () => {
    const mockGuilds: Guild[] = [
      { id: '1', name: 'Cool Hangout', owner_id: '10', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', name: 'Gaming Zone', owner_id: '10', created_at: '2026-01-01T00:00:00Z' },
    ]

    const html = renderToStaticMarkup(
      <ChatEmptyState
        currentGuild={null}
        guilds={mockGuilds}
        channels={[]}
        onSelectGuild={vi.fn()}
      />
    )

    expect(html).toContain('Select a Server')
    expect(html).toContain('Your Servers')
    expect(html).toContain('Cool Hangout')
    expect(html).toContain('Gaming Zone')
  })

  it('renders guild welcome view with channel quick-jump buttons when a guild is active', () => {
    const activeGuild: Guild = { id: '100', name: 'Dev Headquarters', owner_id: '10', created_at: '2026-01-01T00:00:00Z' }
    const mockChannels: Channel[] = [
      { id: '101', guild_id: '100', name: 'general', type: 0, position: 0, created_at: '2026-01-01T00:00:00Z' },
      { id: '102', guild_id: '100', name: 'dev-chat', type: 0, position: 1, created_at: '2026-01-01T00:00:00Z' },
      { id: '103', guild_id: '100', name: 'voice-lounge', type: 2, position: 2, created_at: '2026-01-01T00:00:00Z' },
    ]

    const html = renderToStaticMarkup(
      <ChatEmptyState
        currentGuild={activeGuild}
        channels={mockChannels}
        onSelectChannel={vi.fn()}
      />
    )

    expect(html).toContain('Welcome to Dev Headquarters!')
    expect(html).toContain('Channels in this server')
    expect(html).toContain('general')
    expect(html).toContain('dev-chat')
    expect(html).toContain('voice-lounge')
  })
})
