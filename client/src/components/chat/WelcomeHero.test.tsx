import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WelcomeHero } from './WelcomeHero'
import type { Channel } from '../../types'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'chan-123',
    guild_id: 'guild-1',
    name: 'announcements',
    type: 0,
    position: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('WelcomeHero', () => {
  it('renders welcome title and subtitle with channel name', () => {
    const channel = makeChannel({ name: 'general' })
    const html = renderToStaticMarkup(<WelcomeHero channel={channel} />)

    expect(html).toContain('channel-welcome-banner')
    expect(html).toContain('welcome-title')
    expect(html).toContain('Welcome to #general!')
    expect(html).toContain('This is the start of the #general channel.')
  })

  it('renders empty channel hint when empty is true', () => {
    const channel = makeChannel()
    const html = renderToStaticMarkup(<WelcomeHero channel={channel} empty={true} />)

    expect(html).toContain('welcome-empty-hint')
    expect(html).toContain('This channel is brand new. Send a message to start the conversation!')
  })

  it('omits empty channel hint when empty is false', () => {
    const channel = makeChannel()
    const html = renderToStaticMarkup(<WelcomeHero channel={channel} empty={false} />)

    expect(html).not.toContain('welcome-empty-hint')
  })

  it('renders accessibility attributes for screen readers', () => {
    const channel = makeChannel()
    const html = renderToStaticMarkup(<WelcomeHero channel={channel} />)

    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Channel start"')
  })
})
