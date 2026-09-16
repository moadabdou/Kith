import { describe, expect, it } from 'vitest'
import vectors from '../../../testvectors/permissions_vectors.json'
import * as Perms from './permissions'

describe('Cross-language Permission Engine - TypeScript Golden Parity (#60)', () => {
  it('loads and verifies all 45 golden test vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(40)

    for (const tc of vectors) {
      const actual = Perms.resolveChannelPermissions(
        tc.guild_id,
        tc.owner_id,
        tc.user_id,
        tc.roles,
        tc.overwrites
      )
      const expected = BigInt(tc.expected)

      expect(
        actual,
        `Vector failed: ${tc.name} (${tc.description})`
      ).toBe(expected)
    }
  })

  it('resolveGuildPermissions handles owner, admin, and role unions', () => {
    // Owner bypass
    expect(Perms.resolveGuildPermissions('100', '999', '999', [])).toBe(Perms.ALL_PERMISSIONS)

    // Admin bypass in role
    expect(
      Perms.resolveGuildPermissions('100', '999', '42', [
        { id: '1', permissions: Perms.ADMINISTRATOR.toString() },
      ])
    ).toBe(Perms.ALL_PERMISSIONS)

    // Normal union
    expect(
      Perms.resolveGuildPermissions('100', '999', '42', [
        { id: '1', permissions: Perms.VIEW_CHANNEL.toString() },
        { id: '2', permissions: Perms.SEND_MESSAGES.toString() },
      ])
    ).toBe(Perms.VIEW_CHANNEL | Perms.SEND_MESSAGES)
  })

  it('hasPermission evaluates single and combined permissions', () => {
    const perms = Perms.VIEW_CHANNEL | Perms.SEND_MESSAGES | Perms.ATTACH_FILES

    expect(Perms.hasPermission(perms, Perms.VIEW_CHANNEL)).toBe(true)
    expect(Perms.hasPermission(perms, Perms.SEND_MESSAGES)).toBe(true)
    expect(Perms.hasPermission(perms, Perms.ATTACH_FILES)).toBe(true)
    expect(Perms.hasPermission(perms, Perms.VIEW_CHANNEL | Perms.SEND_MESSAGES)).toBe(true)
    expect(Perms.hasPermission(perms, Perms.BAN_MEMBERS)).toBe(false)
    expect(Perms.hasPermission(perms, Perms.ADMINISTRATOR)).toBe(false)
    expect(Perms.hasPermission(perms, Perms.VIEW_CHANNEL | Perms.BAN_MEMBERS)).toBe(false)
  })

  it('verifies 29 canonical permission constants and ALL_PERMISSIONS', () => {
    const bits: Array<[string, bigint, bigint]> = [
      ['CREATE_INSTANT_INVITE', Perms.CREATE_INSTANT_INVITE, 0n],
      ['KICK_MEMBERS', Perms.KICK_MEMBERS, 1n],
      ['BAN_MEMBERS', Perms.BAN_MEMBERS, 2n],
      ['ADMINISTRATOR', Perms.ADMINISTRATOR, 3n],
      ['MANAGE_CHANNELS', Perms.MANAGE_CHANNELS, 4n],
      ['MANAGE_GUILD', Perms.MANAGE_GUILD, 5n],
      ['ADD_REACTIONS', Perms.ADD_REACTIONS, 6n],
      ['VIEW_AUDIT_LOG', Perms.VIEW_AUDIT_LOG, 7n],
      ['PRIORITY_SPEAKER', Perms.PRIORITY_SPEAKER, 8n],
      ['STREAM', Perms.STREAM, 9n],
      ['VIEW_CHANNEL', Perms.VIEW_CHANNEL, 10n],
      ['SEND_MESSAGES', Perms.SEND_MESSAGES, 11n],
      ['SEND_TTS_MESSAGES', Perms.SEND_TTS_MESSAGES, 12n],
      ['MANAGE_MESSAGES', Perms.MANAGE_MESSAGES, 13n],
      ['EMBED_LINKS', Perms.EMBED_LINKS, 14n],
      ['ATTACH_FILES', Perms.ATTACH_FILES, 15n],
      ['READ_MESSAGE_HISTORY', Perms.READ_MESSAGE_HISTORY, 16n],
      ['MENTION_EVERYONE', Perms.MENTION_EVERYONE, 17n],
      ['USE_EXTERNAL_EMOJIS', Perms.USE_EXTERNAL_EMOJIS, 18n],
      ['VIEW_GUILD_INSIGHTS', Perms.VIEW_GUILD_INSIGHTS, 19n],
      ['CONNECT', Perms.CONNECT, 20n],
      ['SPEAK', Perms.SPEAK, 21n],
      ['MUTE_MEMBERS', Perms.MUTE_MEMBERS, 22n],
      ['DEAFEN_MEMBERS', Perms.DEAFEN_MEMBERS, 23n],
      ['MOVE_MEMBERS', Perms.MOVE_MEMBERS, 24n],
      ['USE_VAD', Perms.USE_VAD, 25n],
      ['CHANGE_NICKNAME', Perms.CHANGE_NICKNAME, 26n],
      ['MANAGE_NICKNAMES', Perms.MANAGE_NICKNAMES, 27n],
      ['MANAGE_ROLES', Perms.MANAGE_ROLES, 28n],
    ]

    let union = 0n
    for (const [name, val, shift] of bits) {
      expect(val).toBe(1n << shift)
      expect(union & val, `Overlap detected for ${name}`).toBe(0n)
      union |= val
    }

    expect(union).toBe(Perms.ALL_PERMISSIONS)
    expect(Perms.ALL_PERMISSIONS).toBe((1n << 29n) - 1n)
  })
})
