import { createContext } from 'react'
import type { Message } from '../types'
import type { GatewayStatus } from './client'

export interface GatewayContextValue {
  status: GatewayStatus
  connected: boolean
  sessionId: string | null
  reconnectAttempt: number
  reconnectCountdownMs: number | null
  reconnectNow: () => void
  subscribeToMessages: (callback: (msg: Message) => void) => () => void
  onSessionReset: (callback: () => void) => () => void
}

export const GatewayContext = createContext<GatewayContextValue | null>(null)
