import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../context/useAuth'
import type { Message } from '../types'
import { gatewayClient, type GatewayStatus } from './client'
import { GatewayContext } from './gateway-context-def'

export function GatewayProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth()
  const [status, setStatus] = useState<GatewayStatus>(gatewayClient.getStatus())

  useEffect(() => {
    const unsub = gatewayClient.onStatusChange((s) => {
      setStatus(s)
    })
    return unsub
  }, [])

  useEffect(() => {
    if (token && user) {
      gatewayClient.connect(token)
    } else {
      gatewayClient.disconnect()
    }
  }, [token, user])

  const subscribeToMessages = (callback: (msg: Message) => void) => {
    return gatewayClient.onMessage(callback)
  }

  return (
    <GatewayContext.Provider
      value={{
        status,
        connected: status === 'ready' || status === 'connected',
        sessionId: gatewayClient.getSessionId(),
        subscribeToMessages,
      }}
    >
      {children}
    </GatewayContext.Provider>
  )
}
