import { createContext } from 'react'
import type { GuildVoiceStates } from '../lib/voice'
import type { VoiceState } from '../types'

export interface ActiveVoiceConnection {
  guildId: string
  channelId: string
}

export type VoiceConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface VoiceContextValue {
  voiceStates: GuildVoiceStates
  activeVoice: ActiveVoiceConnection | null
  connectionStatus: VoiceConnectionStatus
  selfMute: boolean
  selfDeaf: boolean
  isSpeaking: boolean
  speakingUsers: Set<string>
  joinVoice: (guildId: string, channelId: string) => void
  leaveVoice: () => void
  toggleMute: () => void
  toggleDeaf: () => void
  getChannelVoiceStates: (guildId: string, channelId: string) => VoiceState[]
}

export const VoiceContext = createContext<VoiceContextValue | null>(null)
