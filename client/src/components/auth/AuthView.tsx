import { useState, type FormEvent } from 'react'
import { useAuth } from '../../context/useAuth'

export function AuthView() {
  const { login, register, error, clearError } = useAuth()
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [loginField, setLoginField] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pendingInvite = typeof window !== 'undefined' ? sessionStorage.getItem('kith_pending_invite') : null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (isRegister) {
        await register(username, email, password)
      } else {
        await login(loginField, password)
      }
    } catch {
      // Error is set in AuthContext
    } finally {
      setSubmitting(false)
    }
  }

  const toggleMode = () => {
    clearError()
    setIsRegister(!isRegister)
  }

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="auth-header">
          <h2 className="auth-title">
            {isRegister ? 'Create an account' : 'Welcome back!'}
          </h2>
          <p className="auth-subtitle">
            {isRegister
              ? "We're so excited to have you join Kith!"
              : "We're so excited to see you again!"}
          </p>
        </div>

        {pendingInvite && (
          <div
            style={{
              backgroundColor: 'rgba(88, 101, 242, 0.2)',
              border: '1px solid var(--brand)',
              borderRadius: 6,
              padding: '10px 14px',
              color: 'var(--text-header)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            🎉 You have a server invitation! Log in or create an account to join.
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isRegister ? (
            <>
              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  type="text"
                  className="form-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. moad"
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  type="email"
                  className="form-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@domain.com"
                  required
                />
              </div>
            </>
          ) : (
            <div className="form-group">
              <label className="form-label">Email or Username</label>
              <input
                type="text"
                className="form-input"
                value={loginField}
                onChange={(e) => setLoginField(e.target.value)}
                placeholder="Username or email"
                required
                autoFocus
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="btn-primary"
            style={{ width: '100%', height: 44, marginTop: 8 }}
            disabled={submitting}
          >
            {submitting ? 'Please wait…' : isRegister ? 'Continue' : 'Log In'}
          </button>

          <div className="auth-toggle">
            {isRegister ? (
              <>
                Already have an account?
                <a onClick={toggleMode}>Log In</a>
              </>
            ) : (
              <>
                Need an account?
                <a onClick={toggleMode}>Register</a>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
