import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnverifiedEmailBanner } from './UnverifiedEmailBanner'

let mockUser: any = {
  id: 'u-1',
  username: 'novak',
  email: 'novak@example.com',
  email_verified: false,
}

vi.mock('../../context/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    resendVerification: vi.fn().mockResolvedValue({ cooldown: 60 }),
  }),
}))

describe('UnverifiedEmailBanner', () => {
  it('renders banner when user is not verified', () => {
    mockUser = {
      id: 'u-1',
      username: 'novak',
      email: 'novak@example.com',
      email_verified: false,
    }

    const html = renderToStaticMarkup(
      <UnverifiedEmailBanner onOpenVerifyModal={vi.fn()} />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('unverified-email-banner')
    expect(html).toContain('novak@example.com')
    expect(html).toContain('Verify Now')
    expect(html).toContain('Resend Email')
    expect(html).toContain('banner-verify-now-btn')
  })

  it('renders nothing when user is already verified', () => {
    mockUser = {
      id: 'u-1',
      username: 'novak',
      email: 'novak@example.com',
      email_verified: true,
    }

    const html = renderToStaticMarkup(
      <UnverifiedEmailBanner onOpenVerifyModal={vi.fn()} />
    )

    expect(html).toBe('')
  })
})
