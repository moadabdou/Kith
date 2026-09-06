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

  const logout = useCallback(() => {
    api.setToken(null)
    localStorage.removeItem('kith_user')
    setToken(null)
    setUser(null)
  }, [])

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
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
