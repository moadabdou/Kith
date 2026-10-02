import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PinnedMessagesDrawer } from './PinnedMessagesDrawer'
import type { Channel } from '../../types'

vi.mock('../../api', () => ({
  api: {
    getPinnedMessages: vi.fn(),
    unpinMessage: vi.fn(),
  },
}))

vi.mock('../../gateway/useGateway', () => ({
  useGateway: () => ({
    subscribeToChannelPinsUpdate: vi.fn(() => vi.fn()),
    subscribeToMessageDeletes: vi.fn(() => vi.fn()),
    subscribeToMessageUpdates: vi.fn(() => vi.fn()),
  }),
}))

const mockChannel: Channel = {
  id: 'chan-100',
  guild_id: 'guild-1',
  name: 'general',
  type: 0,
  position: 0,
  created_at: '2026-10-02T00:00:00.000Z',
}

describe('PinnedMessagesDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when isOpen is false', () => {
    const html = renderToStaticMarkup(
      <PinnedMessagesDrawer
        isOpen={false}
        onClose={vi.fn()}
        channel={mockChannel}
        canManageMessages={true}
        onJumpToMessage={vi.fn()}
      />
    )
    expect(html).toBe('')
  })

  it('renders header, close button, and empty state when open with no pins', () => {
    const html = renderToStaticMarkup(
      <PinnedMessagesDrawer
        isOpen={true}
        onClose={vi.fn()}
        channel={mockChannel}
        canManageMessages={true}
        onJumpToMessage={vi.fn()}
      />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('Pinned Messages')
    expect(html).toContain('0 / 50')
    expect(html).toContain('pinned-close-btn')
    expect(html).toContain('No pinned messages yet')
    expect(html).toContain('Pin important messages here')
  })
})
