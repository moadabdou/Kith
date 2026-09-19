import { useContext } from 'react'
import { VoiceContext, type VoiceContextValue } from './voice-context-def'

export function useVoice(): VoiceContextValue {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoice must be used within a VoiceProvider')
  }
  return context
}
