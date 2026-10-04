import { createContext } from 'react'
import type {
  ChannelEventPayload,
  ChannelPinsUpdatePayload,
  GuildEmojisUpdatePayload,
  GuildStickersUpdatePayload,
  MemberAddPayload,
  MemberChunkPayload,
  MemberRemovePayload,
  MemberUpdatePayload,
  Message,
  MessageAckPayload,
  MessageDeletePayload,
  MessageReactionEvent,
  PresenceUpdatePayload,
  RoleDeletePayload,
  RoleEventPayload,
  TypingStartPayload,
  VoiceServerUpdatePayload,
  VoiceStateUpdatePayload,
} from '../types'
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
  subscribeToMessageUpdates: (callback: (msg: Partial<Message> & { id: string; channel_id: string }) => void) => () => void
  subscribeToMessageDeletes: (callback: (payload: MessageDeletePayload) => void) => () => void
  subscribeToChannelPinsUpdate: (callback: (payload: ChannelPinsUpdatePayload) => void) => () => void
  subscribeToMessageReactionAdd: (callback: (payload: MessageReactionEvent) => void) => () => void
  subscribeToMessageReactionRemove: (callback: (payload: MessageReactionEvent) => void) => () => void
  subscribeToMessageAcks: (callback: (ack: MessageAckPayload) => void) => () => void
  onSessionReset: (callback: () => void) => () => void
  subscribeToReady: (callback: (data?: any) => void) => () => void
  requestGuildMembers: (guildId: string, opts?: RequestGuildMembersOptions) => void
  subscribeToMemberChunks: (callback: (chunk: MemberChunkPayload) => void) => () => void
  subscribeToPresenceUpdates: (callback: (update: PresenceUpdatePayload) => void) => () => void
  sendTyping: (channelId: string) => boolean
  resetTypingThrottle: (channelId?: string) => void
  subscribeToTyping: (callback: (typing: TypingStartPayload) => void) => () => void
  subscribeToMemberAdds: (callback: (payload: MemberAddPayload) => void) => () => void
  subscribeToMemberRemoves: (callback: (payload: MemberRemovePayload) => void) => () => void
  subscribeToMemberUpdates: (callback: (payload: MemberUpdatePayload) => void) => () => void
  subscribeToRoleCreates: (callback: (payload: RoleEventPayload) => void) => () => void
  subscribeToRoleUpdates: (callback: (payload: RoleEventPayload) => void) => () => void
  subscribeToRoleDeletes: (callback: (payload: RoleDeletePayload) => void) => () => void
  subscribeToChannelCreates: (callback: (payload: ChannelEventPayload) => void) => () => void
  subscribeToChannelUpdates: (callback: (payload: ChannelEventPayload) => void) => () => void
  subscribeToChannelDeletes: (callback: (payload: ChannelEventPayload) => void) => () => void
  sendVoiceStateUpdate: (
    guildId: string,
    channelId: string | null,
    selfMute?: boolean,
    selfDeaf?: boolean
  ) => boolean
  subscribeToVoiceStateUpdates: (callback: (payload: VoiceStateUpdatePayload) => void) => () => void
  subscribeToVoiceServerUpdates: (callback: (payload: VoiceServerUpdatePayload) => void) => () => void
  subscribeToGuildEmojisUpdate: (callback: (payload: GuildEmojisUpdatePayload) => void) => () => void
  subscribeToGuildStickersUpdate: (callback: (payload: GuildStickersUpdatePayload) => void) => () => void
}

export const GatewayContext = createContext<GatewayContextValue | null>(null)
