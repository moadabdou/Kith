import { useContext } from 'react'
import { GatewayContext, type GatewayContextValue } from './gateway-context-def'

export function useGateway(): GatewayContextValue {
  const context = useContext(GatewayContext)
  if (!context) {
    throw new Error('useGateway must be used within a GatewayProvider')
  }
  return context
}
