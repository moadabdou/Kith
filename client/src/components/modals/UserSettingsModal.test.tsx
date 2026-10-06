import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserSettingsModal } from './UserSettingsModal'
import type { User } from '../../types'

vi.mock('../../context/useVoice', () => ({
  useVoice: () => ({
    selfMute: false,
    selfDeaf: false,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
  }),
}))

describe('UserSettingsModal', () => {
  const mockUser: User = {
    id: 'user-123456789',
    username: 'testpilot',
    discriminator: '9999',
    email: 'test@kith.local',
    created_at: '2025-01-01T00:00:00Z',
  }

  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    user: mockUser,
    presenceStatus: 'online' as const,
    onStatusChange: vi.fn(),
    onLogout: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when isOpen is false', () => {
    const html = renderToStaticMarkup(<UserSettingsModal {...defaultProps} isOpen={false} />)
    expect(html).toBe('')
  })

  it('renders nothing when user is null', () => {
    const html = renderToStaticMarkup(<UserSettingsModal {...defaultProps} user={null} />)
    expect(html).toBe('')
  })

  it('renders user details in My Account tab by default', () => {
    const html = renderToStaticMarkup(<UserSettingsModal {...defaultProps} />)
    expect(html).toContain('My Account')
    expect(html).toContain('testpilot')
    expect(html).toContain('#9999')
    expect(html).toContain('user-123456789')
    expect(html).toContain('Presence &amp; Status')
    expect(html).toContain('Voice &amp; Audio')
    expect(html).toContain('Log Out')
    expect(html).toContain('Close Settings')
  })

  it('displays user avatar and presence status indicator', () => {
    const html = renderToStaticMarkup(<UserSettingsModal {...defaultProps} presenceStatus="dnd" />)
    expect(html).toContain('testpilot')
    expect(html).toContain('var(--presence-dnd')
  })
})
