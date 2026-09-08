import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../context/useAuth'
import type { Message } from '../types'
import { gatewayClient, type GatewayStatus, type ReconnectState } from './client'
import { GatewayContext } from './gateway-context-def'

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
      }}
    >
      {children}
    </GatewayContext.Provider>
  )
}
