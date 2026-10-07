import { useState, useEffect } from 'react'
import { Mail, X, RefreshCw, CheckCircle2 } from 'lucide-react'
import { useAuth } from '../../context/useAuth'

interface UnverifiedEmailBannerProps {
  onOpenVerifyModal: () => void
}

export function UnverifiedEmailBanner({ onOpenVerifyModal }: UnverifiedEmailBannerProps) {
  const { user, resendVerification } = useAuth()
  const [dismissed, setDismissed] = useState(() => {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('kith_dismiss_verify_banner') === 'true'
  })
  const [resending, setResending] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [resendStatus, setResendStatus] = useState<string | null>(null)

  // Countdown timer for resend button
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(timer)
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  // If user is verified or no user or dismissed, don't show
  if (!user || user.email_verified !== false || dismissed) {
    return null
  }

  const handleDismiss = () => {
    setDismissed(true)
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('kith_dismiss_verify_banner', 'true')
    }
  }

  const handleResend = async () => {
    if (!user.email || cooldown > 0 || resending) return
    setResending(true)
    setResendStatus(null)
    try {
      const res = await resendVerification(user.email)
      setCooldown(res.cooldown || 60)
      setResendStatus('Sent!')
      setTimeout(() => setResendStatus(null), 3000)
    } catch (err: any) {
      setResendStatus('Failed')
      setTimeout(() => setResendStatus(null), 3000)
    } finally {
      setResending(false)
    }
  }

  return (
    <div
      role="alert"
      className="unverified-email-banner"
      style={{
        position: 'relative',
        zIndex: 9998,
        width: '100%',
        backgroundColor: '#f0b232',
        color: '#1e1f22',
        padding: '7px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '13px',
        fontWeight: 600,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        transition: 'all 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
        <Mail size={16} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Please verify your email address (<strong>{user.email}</strong>) to protect your account.
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onOpenVerifyModal}
          data-testid="banner-verify-now-btn"
          style={{
            backgroundColor: '#1e1f22',
            border: 'none',
            borderRadius: '4px',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 700,
            padding: '3px 10px',
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2b2d31')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#1e1f22')}
        >
          Verify Now
        </button>

        <button
          type="button"
          onClick={handleResend}
          disabled={resending || cooldown > 0}
          data-testid="banner-resend-btn"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.12)',
            border: '1px solid rgba(0, 0, 0, 0.2)',
            borderRadius: '4px',
            color: '#1e1f22',
            fontSize: '12px',
            fontWeight: 600,
            padding: '3px 8px',
            cursor: cooldown > 0 || resending ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {resending ? (
            <RefreshCw size={12} className="spin" />
          ) : resendStatus ? (
            <>
              <CheckCircle2 size={12} />
              <span>{resendStatus}</span>
            </>
          ) : cooldown > 0 ? (
            `Resend in ${cooldown}s`
          ) : (
            'Resend Email'
          )}
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss banner"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(0, 0, 0, 0.6)',
            cursor: 'pointer',
            padding: '2px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#000')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(0, 0, 0, 0.6)')}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
