import { describe, expect, it } from 'vitest'
import type { Member, PresenceStatus, Role } from '../types'
import { buildMemberGroups, displayName, highestHoistedRole, isOnline, memberNameColor, roleColorHex } from './members'

function role(id: string, opts: Partial<Role> = {}): Role {
  return {
    id,
    guild_id: 'g1',
    name: opts.name ?? `Role ${id}`,
    color: opts.color ?? 0,
    hoist: opts.hoist ?? false,
    position: opts.position ?? 0,
    permissions: '0',
    mentionable: false,
    created_at: '2026-01-01T00:00:00Z',
  }
}

function member(id: string, username: string, roles: string[], nick: string | null = null): Member {
  return {
    user: { id, username, discriminator: '0001' },
    nick,
    roles,
    joined_at: '2026-01-01T00:00:00Z',
  }
}

describe('Member sidebar grouping (#38)', () => {
  it('roleColorHex converts int RGB and treats 0 as default', () => {
    expect(roleColorHex(0)).toBeNull()
    expect(roleColorHex(15158332)).toBe('#e74c3c')
    expect(roleColorHex(3447003)).toBe('#3498db')
    expect(roleColorHex(255)).toBe('#0000ff')
  })

  it('isOnline accepts online/idle/dnd only', () => {
    expect(isOnline('online')).toBe(true)
    expect(isOnline('idle')).toBe(true)
    expect(isOnline('dnd')).toBe(true)
    expect(isOnline('offline')).toBe(false)
    expect(isOnline('invisible')).toBe(false)
    expect(isOnline(undefined)).toBe(false)
  })

  it('displayName prefers nick over username', () => {
    expect(displayName(member('1', 'alice', [], 'Ali'))).toBe('Ali')
    expect(displayName(member('1', 'alice', []))).toBe('alice')
    expect(displayName(member('1', 'alice', [], ''))).toBe('alice')
  })

  it('highestHoistedRole picks the highest-position hoisted role and ignores non-hoisted', () => {
    const admin = role('r-admin', { hoist: true, position: 2 })
    const mod = role('r-mod', { hoist: true, position: 1 })
    const plain = role('r-plain', { hoist: false, position: 5 })

    const m = member('1', 'alice', ['r-mod', 'r-plain', 'r-admin'])
    expect(highestHoistedRole(m, [admin, mod, plain])).toBe(admin)

    const onlyPlain = member('2', 'bob', ['r-plain'])
    expect(highestHoistedRole(onlyPlain, [admin, mod, plain])).toBeNull()
  })

  it('memberNameColor uses the highest-position colored role, hoisted or not', () => {
    const coloredLow = role('r-low', { color: 0x00ff00, position: 1 })
    const coloredHigh = role('r-high', { color: 0xff0000, position: 3 })
    const uncolored = role('r-none', { color: 0, position: 9 })

    const m = member('1', 'alice', ['r-none', 'r-low', 'r-high'])
    expect(memberNameColor(m, [coloredLow, coloredHigh, uncolored])).toBe('#ff0000')

    const noColor = member('2', 'bob', ['r-none'])
    expect(memberNameColor(noColor, [coloredLow, coloredHigh, uncolored])).toBeNull()
  })

  it('groups online members by highest hoisted role, position DESC, hiding empty groups', () => {
    const admin = role('r-admin', { name: 'Admin', hoist: true, position: 2, color: 15158332 })
    const mod = role('r-mod', { name: 'Moderator', hoist: true, position: 1 })
    const members = [
      member('1', 'alice', ['r-admin']),
      member('2', 'bob', ['r-mod']),
      member('3', 'carol', []),
    ]
    const presences = new Map<string, PresenceStatus>([['1', 'online'], ['2', 'dnd'], ['3', 'idle']])

    const groups = buildMemberGroups(members, [admin, mod], presences)

    expect(groups.map((g) => g.key)).toEqual(['r-admin', 'r-mod', 'online'])
    expect(groups[0].label).toBe('Admin')
    expect(groups[0].color).toBe('#e74c3c')
    expect(groups[0].members.map((m) => m.user.username)).toEqual(['alice'])
    expect(groups[2].label).toBe('Online')
    expect(groups[2].members.map((m) => m.user.username)).toEqual(['carol'])
  })

  it('sends offline members to a single Offline group at the bottom regardless of roles', () => {
    const admin = role('r-admin', { name: 'Admin', hoist: true, position: 2 })
    const members = [
      member('1', 'alice', ['r-admin']), // offline but has hoisted role
      member('2', 'bob', ['r-admin']),
    ]
    const presences = new Map<string, PresenceStatus>([['2', 'online']])

    const groups = buildMemberGroups(members, [admin], presences)

    expect(groups).toHaveLength(2)
    expect(groups[0].key).toBe('r-admin')
    expect(groups[0].members.map((m) => m.user.username)).toEqual(['bob'])
    expect(groups[1].key).toBe('offline')
    expect(groups[1].members.map((m) => m.user.username)).toEqual(['alice'])
  })

  it('absence from the presence map means offline', () => {
    const members = [member('1', 'alice', [])]
    const groups = buildMemberGroups(members, [], new Map())
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('offline')
  })

  it('sorts members alphabetically by display name within a group', () => {
    const members = [
      member('1', 'zoe', []),
      member('2', 'alice', [], 'Bee'),
      member('3', 'mike', []),
    ]
    const presences = new Map<string, PresenceStatus>([
      ['1', 'online'],
      ['2', 'online'],
      ['3', 'online'],
    ])

    const groups = buildMemberGroups(members, [], presences)
    expect(groups[0].members.map((m) => m.user.id)).toEqual(['2', '3', '1'])
  })

  it('handles empty inputs without emitting groups', () => {
    expect(buildMemberGroups([], [], new Map())).toEqual([])
  })
})
