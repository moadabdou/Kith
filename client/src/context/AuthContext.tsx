import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { User } from '../types'
import { AuthContext } from './auth-context-def'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => api.getToken())
  const [user, setUser] = useState<User | null>(() => {
    const activeToken = api.getToken()
    if (!activeToken) {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('kith_user')
      }
      return null
    }
    const saved = localStorage.getItem('kith_user')
    return saved ? JSON.parse(saved) : null
  })
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch (err) {
      console.warn('[Auth] Logout failed:', err)
    }
    localStorage.removeItem('kith_user')
    setToken(null)
    setUser(null)
  }, [])

  // Sync token from ApiClient when refreshed or cleared
  useEffect(() => {
    const unsubAuthChange = api.onAuthChange((newToken) => {
      setToken(newToken)
      if (!newToken) {
        localStorage.removeItem('kith_user')
        setUser(null)
      }
    })
    const unsubUnauthorized = api.onUnauthorized(() => {
      localStorage.removeItem('kith_user')
      setToken(null)
      setUser(null)
    })
    return () => {
      unsubAuthChange()
      unsubUnauthorized()
    }
  }, [])

  // Proactive background renewal before access token expiration
  useEffect(() => {
    if (!token) return

    const scheduleRenewal = () => {
      const expiresAt = api.getExpiresAt()
      if (!expiresAt) return null

      // Target 60 seconds before expiry; floor at 5 seconds
      const delay = Math.max(expiresAt - Date.now() - 60_000, 5_000)
      return setTimeout(async () => {
        try {
          await api.refreshTokens()
        } catch (err) {
          console.warn('[Auth] Proactive token renewal error:', err)
        }
      }, delay)
    }

    const timerId = scheduleRenewal()
    return () => {
      if (timerId) clearTimeout(timerId)
    }
  }, [token])

  // Multi-tab session synchronization via storage events
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'kith_token') {
        if (!e.newValue) {
          setUser(null)
          setToken(null)
          localStorage.removeItem('kith_user')
        } else if (e.newValue !== token) {
          setToken(e.newValue)
        }
      } else if (e.key === 'kith_user') {
        if (e.newValue) {
          try {
            setUser(JSON.parse(e.newValue))
          } catch {}
        } else {
          setUser(null)
        }
      }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', handleStorage)
      return () => {
        window.removeEventListener('storage', handleStorage)
      }
    }
  }, [token])

  useEffect(() => {
    async function verifyUser() {
      if (!token) {
        setUser(null)
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('kith_user')
        }
        setLoading(false)
        return
      }
      try {
        const me = await api.getMe()
        setUser(me)
        localStorage.setItem('kith_user', JSON.stringify(me))
      } catch (err) {
        console.warn('[Auth] Session validation failed on mount:', err)
        logout()
      } finally {
        setLoading(false)
      }
    }
    verifyUser()
  }, [token, logout])

  const login = async (loginStr: string, passwordStr: string) => {
    setError(null)
    try {
      const res = await api.login(loginStr, passwordStr)
      setToken(res.token)
      if (res.user) {
        setUser(res.user)
        localStorage.setItem('kith_user', JSON.stringify(res.user))
      } else {
        const me = await api.getMe()
        setUser(me)
        localStorage.setItem('kith_user', JSON.stringify(me))
      }
    } catch (err: any) {
      setError(err.message || 'Login failed')
      throw err
    }
  }

  const register = async (username: string, email: string, passwordStr: string) => {
    setError(null)
    try {
      await api.register(username, email, passwordStr)
      // Auto-login upon successful registration
      await login(username, passwordStr)
    } catch (err: any) {
      setError(err.message || 'Registration failed')
      throw err
    }
  }

  const verifyEmail = async (payload: { code?: string; token?: string; email?: string }) => {
    setError(null)
    try {
      const res = await api.verifyEmail(payload)
      if (res.token) {
        setToken(res.token)
      }
      if (res.user) {
        setUser(res.user)
        localStorage.setItem('kith_user', JSON.stringify(res.user))
      } else {
        const me = await api.getMe()
        setUser(me)
        localStorage.setItem('kith_user', JSON.stringify(me))
      }
    } catch (err: any) {
      setError(err.message || 'Verification failed')
      throw err
    }
  }

  const resendVerification = async (emailStr: string) => {
    setError(null)
    try {
      return await api.resendVerification(emailStr)
    } catch (err: any) {
      setError(err.message || 'Failed to resend verification email')
      throw err
    }
  }

  const clearError = () => setError(null)

  const updateUser = useCallback((updated: User) => {
    setUser(updated)
    localStorage.setItem('kith_user', JSON.stringify(updated))
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        error,
        login,
        register,
        verifyEmail,
        resendVerification,
        logout,
        clearError,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
