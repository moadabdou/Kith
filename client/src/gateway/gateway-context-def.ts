import { createContext } from 'react'
import type { Message } from '../types'
import type { GatewayStatus } from './client'

export interface GatewayContextValue {
  status: GatewayStatus
  connected: boolean
  sessionId: string | null
  subscribeToMessages: (callback: (msg: Message) => void) => () => void
}

export const GatewayContext = createContext<GatewayContextValue | null>(null)
