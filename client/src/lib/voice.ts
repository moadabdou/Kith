import type { VoiceState } from '../types'

export type GuildVoiceStates = Record<string, Record<string, VoiceState>>

/**
 * Applies a VOICE_STATE_UPDATE dispatch to the nested guild-scoped voice state map.
 * If channel_id is null or undefined, the user is removed from their active channel.
 * Otherwise, their voice state is inserted or updated.
 */
export function applyVoiceStateUpdate(
  current: GuildVoiceStates,
  update: VoiceState
): GuildVoiceStates {
  const guildId = update.guild_id
  const userId = update.user_id
  const guildStates = { ...(current[guildId] || {}) }

  if (!update.channel_id) {
    // User left voice
    if (!guildStates[userId]) {
      return current
    }
    delete guildStates[userId]
  } else {
    // User joined or updated voice state
    guildStates[userId] = { ...update }
  }

  return {
    ...current,
    [guildId]: guildStates,
  }
}

/**
 * Hydrates guild voice states from the READY payload or initial guild snapshot.
 */
export function hydrateGuildVoiceStates(
  current: GuildVoiceStates,
  guilds: Array<{ id: string; voice_states?: Record<string, VoiceState> | VoiceState[] }>
): GuildVoiceStates {
  let next = { ...current }

  for (const guild of guilds) {
    if (!guild || !guild.id) continue
    const gid = String(guild.id)
    const existing = { ...(next[gid] || {}) }

    if (guild.voice_states) {
      if (Array.isArray(guild.voice_states)) {
        for (const vs of guild.voice_states) {
          if (vs && vs.user_id && vs.channel_id) {
            existing[vs.user_id] = { ...vs, guild_id: gid }
          }
        }
      } else if (typeof guild.voice_states === 'object') {
        for (const [uid, vs] of Object.entries(guild.voice_states)) {
          if (vs && vs.channel_id) {
            existing[uid] = { ...vs, guild_id: gid, user_id: vs.user_id || uid }
          }
        }
      }
    }

    next = {
      ...next,
      [gid]: existing,
    }
  }

  return next
}

/**
 * Returns all active voice states for a specific channel in a guild.
 */
export function getUsersInVoiceChannel(
  states: GuildVoiceStates,
  guildId: string,
  channelId: string
): VoiceState[] {
  const guildStates = states[guildId]
  if (!guildStates) return []

  return Object.values(guildStates).filter((vs) => vs.channel_id === channelId)
}
