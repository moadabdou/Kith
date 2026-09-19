import { describe, it, expect } from 'vitest'
import {
  applyVoiceStateUpdate,
  hydrateGuildVoiceStates,
  getUsersInVoiceChannel,
  type GuildVoiceStates,
} from './voice'
import type { VoiceState } from '../types'

describe('Voice State Management (#68, #69)', () => {
  it('hydrates initial voice states from guild objects', () => {
    const rawGuilds = [
      {
        id: 'guild-1',
        voice_states: {
          'user-1': {
            guild_id: 'guild-1',
            channel_id: 'chan-1',
            user_id: 'user-1',
            session_id: 'sess-1',
            self_mute: false,
            self_deaf: false,
          },
          'user-2': {
            guild_id: 'guild-1',
            channel_id: 'chan-2',
            user_id: 'user-2',
            session_id: 'sess-2',
            self_mute: true,
            self_deaf: true,
          },
        },
      },
      {
        id: 'guild-2',
        voice_states: [
          {
            guild_id: 'guild-2',
            channel_id: 'chan-3',
            user_id: 'user-3',
            session_id: 'sess-3',
            self_mute: false,
            self_deaf: false,
          },
        ],
      },
    ]

    const initial: GuildVoiceStates = {}
    const hydrated = hydrateGuildVoiceStates(initial, rawGuilds as any)

    expect(getUsersInVoiceChannel(hydrated, 'guild-1', 'chan-1').length).toBe(1)
    expect(getUsersInVoiceChannel(hydrated, 'guild-1', 'chan-1')[0].user_id).toBe('user-1')

    expect(getUsersInVoiceChannel(hydrated, 'guild-1', 'chan-2').length).toBe(1)
    expect(getUsersInVoiceChannel(hydrated, 'guild-1', 'chan-2')[0].self_mute).toBe(true)

    expect(getUsersInVoiceChannel(hydrated, 'guild-2', 'chan-3').length).toBe(1)
    expect(getUsersInVoiceChannel(hydrated, 'guild-2', 'chan-3')[0].user_id).toBe('user-3')
  })

  it('handles user joining and updating voice state', () => {
    let states: GuildVoiceStates = {}

    const joinUpdate: VoiceState = {
      guild_id: 'guild-1',
      channel_id: 'voice-chan-a',
      user_id: 'user-alice',
      session_id: 'sess-alice',
      self_mute: false,
      self_deaf: false,
    }

    states = applyVoiceStateUpdate(states, joinUpdate)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'voice-chan-a').length).toBe(1)

    // User mutes self
    const muteUpdate: VoiceState = {
      ...joinUpdate,
      self_mute: true,
    }
    states = applyVoiceStateUpdate(states, muteUpdate)
    const inChan = getUsersInVoiceChannel(states, 'guild-1', 'voice-chan-a')
    expect(inChan.length).toBe(1)
    expect(inChan[0].self_mute).toBe(true)
  })

  it('handles moving between channels', () => {
    let states: GuildVoiceStates = {}

    const userJoinChanA: VoiceState = {
      guild_id: 'guild-1',
      channel_id: 'chan-a',
      user_id: 'user-bob',
      session_id: 'sess-bob',
      self_mute: false,
      self_deaf: false,
    }

    states = applyVoiceStateUpdate(states, userJoinChanA)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-a').length).toBe(1)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-b').length).toBe(0)

    // Move to chan-b
    const userMoveChanB: VoiceState = {
      ...userJoinChanA,
      channel_id: 'chan-b',
    }
    states = applyVoiceStateUpdate(states, userMoveChanB)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-a').length).toBe(0)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-b').length).toBe(1)
  })

  it('handles user leaving a voice channel (channel_id: null)', () => {
    let states: GuildVoiceStates = {}

    const userJoin: VoiceState = {
      guild_id: 'guild-1',
      channel_id: 'chan-a',
      user_id: 'user-charlie',
      session_id: 'sess-charlie',
      self_mute: false,
      self_deaf: false,
    }

    states = applyVoiceStateUpdate(states, userJoin)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-a').length).toBe(1)

    const userLeave: VoiceState = {
      guild_id: 'guild-1',
      channel_id: null,
      user_id: 'user-charlie',
      session_id: 'sess-charlie',
      self_mute: false,
      self_deaf: false,
    }

    states = applyVoiceStateUpdate(states, userLeave)
    expect(getUsersInVoiceChannel(states, 'guild-1', 'chan-a').length).toBe(0)
    expect(states['guild-1']['user-charlie']).toBeUndefined()
  })
})
