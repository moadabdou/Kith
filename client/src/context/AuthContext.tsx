import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { User } from '../types'
import { AuthContext } from './auth-context-def'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('kith_user')
    return saved ? JSON.parse(saved) : null
  })
  const [token, setToken] = useState<string | null>(() => api.getToken())
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
        setLoading(false)
        return
      }
      try {
        const me = await api.getMe()
        setUser(me)
        localStorage.setItem('kith_user', JSON.stringify(me))
      } catch {
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
        logout,
        clearError,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
