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

  it('identifies private channels where @everyone is denied VIEW_CHANNEL', () => {
    const guildId = '100'

    const publicChannelOverwrites: Perms.OverwriteLike[] = []
    const isPublic = publicChannelOverwrites.some(
      (ow) => Number(ow.target_type) === 0 && String(ow.target_id) === guildId && Perms.hasPermission(ow.deny, Perms.VIEW_CHANNEL)
    )
    expect(isPublic).toBe(false)

    const privateChannelOverwrites: Perms.OverwriteLike[] = [
      { target_id: guildId, target_type: 0, allow: '0', deny: Perms.VIEW_CHANNEL.toString() },
      { target_id: '200', target_type: 0, allow: Perms.VIEW_CHANNEL.toString(), deny: '0' },
    ]
    const isPrivate = privateChannelOverwrites.some(
      (ow) => Number(ow.target_type) === 0 && String(ow.target_id) === guildId && Perms.hasPermission(ow.deny, Perms.VIEW_CHANNEL)
    )
    expect(isPrivate).toBe(true)
  })

  it('validates MANAGE_CHANNELS permission gating', () => {
    expect(Perms.hasPermission(0n, Perms.MANAGE_CHANNELS)).toBe(false)
    expect(Perms.hasPermission(Perms.MANAGE_CHANNELS, Perms.MANAGE_CHANNELS)).toBe(true)
    expect(Perms.hasPermission(Perms.ADMINISTRATOR, Perms.ADMINISTRATOR)).toBe(true)
  })

  it('resolves SEND_MESSAGES gating for message input', () => {
    const guildId = '100'
    const ownerId = '999'
    const memberId = '42'

    const baseRoles: Perms.RoleLike[] = [
      { id: guildId, permissions: (Perms.VIEW_CHANNEL | Perms.SEND_MESSAGES).toString() },
    ]

    // 1. Normal channel allows send
    const normalPerms = Perms.resolveChannelPermissions(guildId, ownerId, memberId, baseRoles, [])
    expect(Perms.hasPermission(normalPerms, Perms.SEND_MESSAGES)).toBe(true)

    // 2. Read-only channel with SEND_MESSAGES denied for @everyone
    const readOnlyOverwrites: Perms.OverwriteLike[] = [
      { target_id: guildId, type: 0, allow: '0', deny: Perms.SEND_MESSAGES.toString() },
    ]
    const readOnlyPerms = Perms.resolveChannelPermissions(guildId, ownerId, memberId, baseRoles, readOnlyOverwrites)
    expect(Perms.hasPermission(readOnlyPerms, Perms.SEND_MESSAGES)).toBe(false)

    // 3. Member with VIP role allowed SEND_MESSAGES overrides @everyone deny
    const vipRoles: Perms.RoleLike[] = [
      ...baseRoles,
      { id: '200', permissions: '0' },
    ]
    const vipOverwrites: Perms.OverwriteLike[] = [
      { target_id: guildId, type: 0, allow: '0', deny: Perms.SEND_MESSAGES.toString() },
      { target_id: '200', type: 0, allow: Perms.SEND_MESSAGES.toString(), deny: '0' },
    ]
    const vipPerms = Perms.resolveChannelPermissions(guildId, ownerId, memberId, vipRoles, vipOverwrites)
    expect(Perms.hasPermission(vipPerms, Perms.SEND_MESSAGES)).toBe(true)

    // 4. Owner bypasses read-only deny unconditionally
    const ownerPerms = Perms.resolveChannelPermissions(guildId, ownerId, ownerId, [], readOnlyOverwrites)
    expect(Perms.hasPermission(ownerPerms, Perms.SEND_MESSAGES)).toBe(true)

    // 5. Server base role override: @everyone has SEND_MESSAGES=0, but custom role has SEND_MESSAGES=1
    const baseRolesWithoutEveryoneSend: Perms.RoleLike[] = [
      { id: guildId, permissions: Perms.VIEW_CHANNEL.toString() }, // @everyone: no SEND_MESSAGES
      { id: '300', permissions: Perms.SEND_MESSAGES.toString() },   // @nerds: has SEND_MESSAGES
    ]
    const resolvedMemberWithRole = Perms.resolveChannelPermissions(
      guildId,
      ownerId,
      memberId,
      baseRolesWithoutEveryoneSend,
      []
    )
    expect(Perms.hasPermission(resolvedMemberWithRole, Perms.SEND_MESSAGES)).toBe(true)

    // Member without the custom role cannot send messages
    const resolvedMemberWithoutRole = Perms.resolveChannelPermissions(
      guildId,
      ownerId,
      memberId,
      [{ id: guildId, permissions: Perms.VIEW_CHANNEL.toString() }],
      []
    )
    expect(Perms.hasPermission(resolvedMemberWithoutRole, Perms.SEND_MESSAGES)).toBe(false)
  })
})
