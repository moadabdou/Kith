import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmailVerificationModal } from './EmailVerificationModal'

// Mock useAuth
vi.mock('../../context/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: '123',
      username: 'tester',
      discriminator: '0001',
      email: 'test@kith.chat',
      email_verified: false,
    },
    verifyEmail: vi.fn(),
    resendVerification: vi.fn().mockResolvedValue({ message: 'Sent', cooldown: 60 }),
  }),
}))

describe('EmailVerificationModal', () => {
  it('renders nothing when isOpen is false', () => {
    const html = renderToStaticMarkup(
      <EmailVerificationModal isOpen={false} onClose={vi.fn()} />
    )
    expect(html).toBe('')
  })

  it('renders modal dialog with 6 OTP inputs and target email when isOpen is true', () => {
    const html = renderToStaticMarkup(
      <EmailVerificationModal isOpen={true} onClose={vi.fn()} />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('email-verify-modal')
    expect(html).toContain('Check Your Inbox')
    expect(html).toContain('test@kith.chat')
    expect(html).toContain('Verify Email')
    expect(html).toContain('Resend email')
    expect(html).toContain('Codes expire in 15 minutes')

    // 6 input boxes
    for (let i = 0; i < 6; i++) {
      expect(html).toContain(`data-testid="otp-input-${i}"`)
    }
  })

  it('renders with custom email override prop', () => {
    const html = renderToStaticMarkup(
      <EmailVerificationModal
        isOpen={true}
        onClose={vi.fn()}
        email="custom-recipient@example.com"
      />
    )

    expect(html).toContain('custom-recipient@example.com')
  })

  it('renders modal action buttons with accessibility tags', () => {
    const html = renderToStaticMarkup(
      <EmailVerificationModal isOpen={true} onClose={vi.fn()} />
    )

    expect(html).toContain('data-testid="verify-submit-button"')
    expect(html).toContain('data-testid="resend-verification-button"')
    expect(html).toContain('aria-label="Close"')
  })
})
