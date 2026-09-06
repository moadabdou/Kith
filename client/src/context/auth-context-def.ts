import { createContext } from 'react'
import type { User } from '../types'

export interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  error: string | null
  login: (loginStr: string, passwordStr: string) => Promise<void>
  register: (username: string, email: string, passwordStr: string) => Promise<void>
  logout: () => void
  clearError: () => void
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)
