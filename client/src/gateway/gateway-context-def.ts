import { createContext } from 'react'
import type { MemberChunkPayload, Message, PresenceUpdatePayload } from '../types'
import type { GatewayStatus } from './client'

export interface RequestGuildMembersOptions {
  query?: string
  limit?: number
  presences?: boolean
}

export interface GatewayContextValue {
  status: GatewayStatus
  connected: boolean
  sessionId: string | null
  reconnectAttempt: number
  reconnectCountdownMs: number | null
  reconnectNow: () => void
  subscribeToMessages: (callback: (msg: Message) => void) => () => void
  onSessionReset: (callback: () => void) => () => void
  requestGuildMembers: (guildId: string, opts?: RequestGuildMembersOptions) => void
  subscribeToMemberChunks: (callback: (chunk: MemberChunkPayload) => void) => () => void
  subscribeToPresenceUpdates: (callback: (update: PresenceUpdatePayload) => void) => () => void
}

export const GatewayContext = createContext<GatewayContextValue | null>(null)
