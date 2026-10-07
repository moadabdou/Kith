import { createContext } from 'react'
import type { User } from '../types'

export interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  error: string | null
  login: (loginStr: string, passwordStr: string) => Promise<void>
  register: (username: string, email: string, passwordStr: string) => Promise<void>
  verifyEmail: (payload: { code?: string; token?: string; email?: string }) => Promise<void>
  resendVerification: (email: string) => Promise<{ message: string; cooldown: number }>
  logout: () => void
  clearError: () => void
  updateUser: (user: User) => void
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)
