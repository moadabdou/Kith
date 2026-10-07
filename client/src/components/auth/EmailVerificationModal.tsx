import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ClipboardEvent } from 'react'
import { Mail, CheckCircle, AlertCircle, RefreshCw, X, ArrowRight } from 'lucide-react'
import { useAuth } from '../../context/useAuth'

interface EmailVerificationModalProps {
  isOpen: boolean
  onClose: () => void
  email?: string
  onVerified?: () => void
}

export function EmailVerificationModal({
  isOpen,
  onClose,
  email: initialEmail,
  onVerified,
}: EmailVerificationModalProps) {
  const { user, verifyEmail, resendVerification } = useAuth()
  const targetEmail = initialEmail || user?.email || ''

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setDigits(['', '', '', '', '', ''])
      setError(null)
      setSuccess(false)
      setInfoMessage(null)
      // Focus first input after modal renders
      setTimeout(() => {
        inputRefs.current[0]?.focus()
      }, 50)
    }
  }, [isOpen])

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const handleDigitChange = (index: number, value: string) => {
    setError(null)
    setInfoMessage(null)

    // Only allow alphanumeric / digits
    const cleaned = value.replace(/[^0-9a-zA-Z]/g, '')
    if (!cleaned) {
      const nextDigits = [...digits]
      nextDigits[index] = ''
      setDigits(nextDigits)
      return
    }

    const char = cleaned.slice(-1)
    const nextDigits = [...digits]
    nextDigits[index] = char
    setDigits(nextDigits)

    // Advance to next box if available
    if (index < 5 && char) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        // Move to previous box
        inputRefs.current[index - 1]?.focus()
        const nextDigits = [...digits]
        nextDigits[index - 1] = ''
        setDigits(nextDigits)
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus()
    } else if (e.key === 'Enter') {
      const fullCode = digits.join('')
      if (fullCode.length === 6) {
        handleVerify(fullCode)
      }
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    setError(null)
    const pasted = e.clipboardData.getData('text').trim().replace(/[^0-9a-zA-Z]/g, '')
    if (!pasted) return

    const chars = pasted.slice(0, 6).split('')
    const nextDigits = [...digits]
    chars.forEach((c, idx) => {
      if (idx < 6) nextDigits[idx] = c
    })
    setDigits(nextDigits)

    const nextFocusIdx = Math.min(chars.length, 5)
    inputRefs.current[nextFocusIdx]?.focus()

    if (chars.length === 6) {
      handleVerify(chars.join(''))
    }
  }

  const handleVerify = useCallback(
    async (codeToVerify?: string) => {
      const code = codeToVerify || digits.join('')
      if (code.length < 6) {
        setError('Please enter all 6 digits of your verification code.')
        return
      }

      setSubmitting(true)
      setError(null)
      try {
        await verifyEmail({
          code,
          email: targetEmail || undefined,
        })
        setSuccess(true)
        if (onVerified) {
          onVerified()
        }
        setTimeout(() => {
          onClose()
        }, 1200)
      } catch (err: any) {
        setError(err.message || 'Invalid or expired verification code.')
      } finally {
        setSubmitting(false)
      }
    },
    [digits, targetEmail, verifyEmail, onVerified, onClose]
  )

  const handleResend = async () => {
    if (cooldown > 0 || resending || !targetEmail) return

    setResending(true)
    setError(null)
    setInfoMessage(null)
    try {
      const res = await resendVerification(targetEmail)
      setCooldown(res.cooldown || 60)
      setInfoMessage('A new verification code has been dispatched to your email!')
    } catch (err: any) {
      setError(err.message || 'Failed to resend verification email.')
    } finally {
      setResending(false)
    }
  }

  if (!isOpen) return null

  const isComplete = digits.every((d) => d.length === 1)

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-content email-verify-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 480,
          background: '#121318',
          borderRadius: 16,
          padding: 0,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.08)',
          overflow: 'hidden',
          border: '1px solid rgba(255, 255, 255, 0.12)',
        }}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 18,
            right: 18,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted, #949ba4)',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            transition: 'color 0.15s, background 0.15s',
            zIndex: 10,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted, #949ba4)')}
        >
          <X size={20} />
        </button>

        <div style={{ padding: '32px 32px 24px', textAlign: 'center' }}>
          {/* Icon Header */}
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              background: success
                ? 'rgba(35, 165, 90, 0.15)'
                : 'linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.03))',
              border: success
                ? '1px solid rgba(35, 165, 90, 0.35)'
                : '1px solid rgba(255, 255, 255, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
              color: success ? '#23a55a' : '#ffffff',
              boxShadow: success
                ? '0 0 24px rgba(35, 165, 90, 0.25)'
                : '0 8px 24px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 255, 255, 0.08)',
            }}
          >
            {success ? <CheckCircle size={32} /> : <Mail size={30} />}
          </div>

          <h2
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: 'var(--text-header, #f2f3f5)',
              marginBottom: 8,
              letterSpacing: '-0.01em',
            }}
          >
            {success ? 'Email Verified!' : 'Check Your Inbox'}
          </h2>

          <p
            style={{
              fontSize: 14,
              lineHeight: '1.5',
              color: 'var(--text-muted, #949ba4)',
              margin: '0 auto 24px',
              maxWidth: 380,
            }}
          >
            {success ? (
              'Your email has been verified. You now have full access to all Kith features!'
            ) : (
              <>
                We sent a 6-digit verification code to{' '}
                <strong style={{ color: 'var(--text-normal, #dbdee1)', wordBreak: 'break-all' }}>
                  {targetEmail || 'your email'}
                </strong>
                . Enter it below to confirm your account.
              </>
            )}
          </p>

          {/* Feedback Messages */}
          {error && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(242, 63, 67, 0.12)',
                border: '1px solid rgba(242, 63, 67, 0.3)',
                color: '#f23f43',
                fontSize: 13,
                marginBottom: 20,
                textAlign: 'left',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}

          {infoMessage && !error && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(35, 165, 90, 0.12)',
                border: '1px solid rgba(35, 165, 90, 0.3)',
                color: '#23a55a',
                fontSize: 13,
                marginBottom: 20,
                textAlign: 'left',
              }}
            >
              <CheckCircle size={16} style={{ flexShrink: 0 }} />
              <span>{infoMessage}</span>
            </div>
          )}

          {/* OTP Input Boxes */}
          {!success && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                gap: 10,
                marginBottom: 28,
              }}
            >
              {digits.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => {
                    inputRefs.current[idx] = el
                  }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleDigitChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                  onPaste={idx === 0 ? handlePaste : undefined}
                  disabled={submitting}
                  aria-label={`Digit ${idx + 1}`}
                  data-testid={`otp-input-${idx}`}
                  style={{
                    width: 50,
                    height: 58,
                    fontSize: 24,
                    fontWeight: 700,
                    textAlign: 'center',
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: digit
                      ? '2px solid #ffffff'
                      : '2px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: 12,
                    color: '#ffffff',
                    outline: 'none',
                    transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                    boxShadow: digit
                      ? '0 0 16px rgba(255, 255, 255, 0.2), 0 4px 12px rgba(0, 0, 0, 0.4)'
                      : 'none',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = '#ffffff'
                    e.currentTarget.style.boxShadow = '0 0 20px rgba(255, 255, 255, 0.3)'
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.07)'
                  }}
                  onBlur={(e) => {
                    if (!digit) {
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.boxShadow = 'none'
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'
                    }
                  }}
                />
              ))}
            </div>
          )}

          {/* Action Button */}
          {!success && (
            <button
              type="button"
              onClick={() => handleVerify()}
              disabled={submitting || !isComplete}
              data-testid="verify-submit-button"
              style={{
                width: '100%',
                height: 48,
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                cursor: submitting || !isComplete ? 'not-allowed' : 'pointer',
                background: isComplete && !submitting ? '#ffffff' : 'rgba(255, 255, 255, 0.08)',
                border: isComplete && !submitting ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
                color: isComplete && !submitting ? '#090a0d' : 'rgba(255, 255, 255, 0.35)',
                boxShadow: isComplete && !submitting ? '0 4px 20px rgba(255, 255, 255, 0.25)' : 'none',
                transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={(e) => {
                if (isComplete && !submitting) {
                  e.currentTarget.style.backgroundColor = '#eaeaea'
                  e.currentTarget.style.transform = 'translateY(-1px)'
                }
              }}
              onMouseLeave={(e) => {
                if (isComplete && !submitting) {
                  e.currentTarget.style.backgroundColor = '#ffffff'
                  e.currentTarget.style.transform = 'translateY(0)'
                }
              }}
            >
              {submitting ? (
                <>
                  <RefreshCw size={16} className="spin-animation" />
                  <span>Verifying code…</span>
                </>
              ) : (
                <>
                  <span>Verify Email</span>
                  <ArrowRight size={16} strokeWidth={2.5} />
                </>
              )}
            </button>
          )}

          {/* Resend Cooldown Section */}
          {!success && (
            <div
              style={{
                marginTop: 22,
                fontSize: 13,
                color: 'var(--text-muted, #949ba4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <span>Didn't receive the email?</span>
              <button
                type="button"
                onClick={handleResend}
                disabled={resending || cooldown > 0 || !targetEmail}
                data-testid="resend-verification-button"
                style={{
                  background: cooldown > 0 ? 'rgba(255, 255, 255, 0.05)' : 'none',
                  border: cooldown > 0 ? '1px solid rgba(255, 255, 255, 0.1)' : 'none',
                  borderRadius: cooldown > 0 ? 6 : 0,
                  padding: cooldown > 0 ? '3px 8px' : 0,
                  fontSize: 13,
                  fontWeight: 600,
                  color:
                    cooldown > 0
                      ? 'var(--text-muted, #949ba4)'
                      : '#ffffff',
                  cursor: cooldown > 0 || resending ? 'default' : 'pointer',
                  textDecoration: cooldown > 0 ? 'none' : 'underline',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  transition: 'all 0.15s ease',
                }}
              >
                {resending ? (
                  'Sending…'
                ) : cooldown > 0 ? (
                  `Resend in ${cooldown}s`
                ) : (
                  'Resend email'
                )}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            background: 'var(--bg-secondary, #232428)',
            padding: '14px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid rgba(255, 255, 255, 0.05)',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-muted, #949ba4)' }}>
            Codes expire in 15 minutes
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted, #949ba4)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              padding: '6px 10px',
              borderRadius: 4,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted, #949ba4)')}
          >
            {success ? 'Close' : 'Verify later'}
          </button>
        </div>
      </div>
    </div>
  )
}
