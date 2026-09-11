import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../context/useAuth'
import type {
  MemberAddPayload,
  MemberChunkPayload,
  MemberRemovePayload,
  Message,
  PresenceUpdatePayload,
  TypingStartPayload,
} from '../types'
import { gatewayClient, type GatewayStatus, type ReconnectState } from './client'
import { GatewayContext } from './gateway-context-def'
import type { RequestGuildMembersOptions } from './gateway-context-def'

export function GatewayProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const [status, setStatus] = useState<GatewayStatus>(gatewayClient.getStatus())
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(null)

  useEffect(() => {
    const unsubStatus = gatewayClient.onStatusChange((s) => {
      setStatus(s)
    })
    const unsubReconnect = gatewayClient.onReconnectChange((r) => {
      setReconnectState(r)
    })
    return () => {
      unsubStatus()
      unsubReconnect()
    }
  }, [])

  useEffect(() => {
    if (token) {
      gatewayClient.connect(token)
    } else {
      gatewayClient.disconnect()
    }
  }, [token])

  const subscribeToMessages = (callback: (msg: Message) => void) => {
    return gatewayClient.onMessage(callback)
  }

  const onSessionReset = (callback: () => void) => {
    return gatewayClient.onSessionReset(callback)
  }

  const requestGuildMembers = (guildId: string, opts?: RequestGuildMembersOptions) => {
    gatewayClient.requestGuildMembers(guildId, opts)
  }

  const subscribeToMemberChunks = (callback: (chunk: MemberChunkPayload) => void) => {
    return gatewayClient.onMemberChunk(callback)
  }

  const subscribeToPresenceUpdates = (callback: (update: PresenceUpdatePayload) => void) => {
    return gatewayClient.onPresenceUpdate(callback)
  }

  const sendTyping = (channelId: string) => {
    return gatewayClient.sendTyping(channelId)
  }

  const subscribeToTyping = (callback: (typing: TypingStartPayload) => void) => {
    return gatewayClient.onTypingStart(callback)
  }

  const subscribeToMemberAdds = (callback: (payload: MemberAddPayload) => void) => {
    return gatewayClient.onGuildMemberAdd(callback)
  }

  const subscribeToMemberRemoves = (callback: (payload: MemberRemovePayload) => void) => {
    return gatewayClient.onGuildMemberRemove(callback)
  }

  const reconnectNow = () => {
    gatewayClient.reconnectNow()
  }

  return (
    <GatewayContext.Provider
      value={{
        status,
        connected: status === 'ready' || status === 'connected',
        sessionId: gatewayClient.getSessionId(),
        reconnectAttempt: reconnectState?.attempt ?? gatewayClient.getReconnectAttempt(),
        reconnectCountdownMs: reconnectState?.countdownMs ?? null,
        reconnectNow,
        subscribeToMessages,
        onSessionReset,
        requestGuildMembers,
        subscribeToMemberChunks,
        subscribeToPresenceUpdates,
        sendTyping,
        subscribeToTyping,
        subscribeToMemberAdds,
        subscribeToMemberRemoves,
      }}
    >
      {children}
    </GatewayContext.Provider>
  )
}
