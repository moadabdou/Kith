import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react'
import { useGateway } from '../../gateway/useGateway'

export function ConnectionBanner() {
  const { status, reconnectAttempt, reconnectCountdownMs, reconnectNow } = useGateway()

  if (status === 'ready' || status === 'connected') {
    return null
  }

  const countdownSec = reconnectCountdownMs !== null ? Math.ceil(reconnectCountdownMs / 1000) : null

  let bgColor = '#f0b232' // Amber for reconnecting / resuming
  let textColor = '#000000'
  let message = ''
  let showRetry = false

  if (status === 'reconnecting') {
    bgColor = '#f0b232'
    textColor = '#1e1f22'
    message = countdownSec !== null && countdownSec > 0
      ? `Connection lost. Reconnecting in ${countdownSec}s (attempt ${reconnectAttempt})...`
      : `Connection lost. Reconnecting now (attempt ${reconnectAttempt})...`
    showRetry = true
  } else if (status === 'resuming') {
    bgColor = '#5865f2'
    textColor = '#ffffff'
    message = 'Reconnected! Resuming session and replaying missed events...'
  } else if (status === 'connecting') {
    bgColor = '#383a40'
    textColor = '#dbdee1'
    message = 'Connecting to real-time gateway...'
  } else {
    // disconnected
    bgColor = '#da373c'
    textColor = '#ffffff'
    message = 'Disconnected from gateway.'
    showRetry = true
  }

  return (
    <div
      style={{
        position: 'relative',
        zIndex: 9999,
        width: '100%',
        backgroundColor: bgColor,
        color: textColor,
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        fontSize: '13px',
        fontWeight: 600,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        transition: 'all 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {status === 'reconnecting' ? (
          <AlertTriangle size={16} />
        ) : status === 'disconnected' ? (
          <WifiOff size={16} />
        ) : (
          <RefreshCw size={14} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
        )}
        <span>{message}</span>
      </div>

      {showRetry && (
        <button
          onClick={reconnectNow}
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
            border: '1px solid rgba(0, 0, 0, 0.25)',
            borderRadius: '4px',
            color: 'inherit',
            fontSize: '11px',
            fontWeight: 700,
            padding: '2px 8px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
          title="Retry connection immediately"
        >
          <RefreshCw size={11} />
          Retry Now
        </button>
      )}
    </div>
  )
}
