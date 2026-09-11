import type { Member, PresenceStatus, Role } from '../types'

export interface MemberGroup {
  key: string // role id, or 'online' / 'offline' for fallback groups
  label: string
  color: string | null // role color as #RRGGBB; null = default muted
  members: Member[]
}

/**
 * Converts an int RGB role color to a #RRGGBB string.
 * Discord uses 0 to mean "default" (no color) — returns null for that.
 */
export function roleColorHex(color: number): string | null {
  if (!color || color < 0) return null
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

/** A status counts as "online" for sidebar grouping unless offline/invisible. */
export function isOnline(status: PresenceStatus | undefined): boolean {
  return status === 'online' || status === 'idle' || status === 'dnd'
}

/** Sidebar display name: nick overrides username (Discord semantics). */
export function displayName(member: Member): string {
  return member.nick || member.user.username
}

function initialsOf(name: string): string {
  return name.substring(0, 2).toUpperCase() || 'U'
}

export { initialsOf }

/**
 * The member's highest-position hoisted role, or null when they hold none.
 * Hoisted roles are the ones that get their own sidebar group header.
 */
export function highestHoistedRole(member: Member, hoistedRoles: Role[]): Role | null {
  let best: Role | null = null
  for (const role of hoistedRoles) {
    if (!role.hoist || !member.roles.includes(role.id)) continue
    if (!best || role.position > best.position || (role.position === best.position && role.id < best.id)) {
      best = role
    }
  }
  return best
}

/**
 * Name color: the color of the member's highest-position role that has a
 * non-default color (hoisted or not — Discord colors names by top colored role).
 */
export function memberNameColor(member: Member, roles: Role[]): string | null {
  let best: Role | null = null
  for (const role of roles) {
    if (role.color === 0 || !member.roles.includes(role.id)) continue
    if (!best || role.position > best.position || (role.position === best.position && role.id < best.id)) {
      best = role
    }
  }
  return best ? roleColorHex(best.color) : null
}

/**
 * Builds the member sidebar groups (Discord "lazy guilds" sidebar model):
 * - Online members are grouped under their highest hoisted role, groups
 *   ordered by role position DESC; empty role groups are hidden.
 * - Online members with no hoisted role fall back to the "Online" group.
 * - Offline members all go to a single "Offline" group at the bottom,
 *   regardless of roles.
 * - Members within a group sort alphabetically by display name.
 */
export function buildMemberGroups(
  members: Member[],
  roles: Role[],
  presences: Map<string, PresenceStatus>,
): MemberGroup[] {
  const hoisted = roles
    .filter((r) => r.hoist)
    .sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))

  const byRole = new Map<string, Member[]>(hoisted.map((r) => [r.id, []]))
  const online: Member[] = []
  const offline: Member[] = []

  for (const member of members) {
    const status = presences.get(member.user.id)
    if (isOnline(status)) {
      const group = highestHoistedRole(member, hoisted)
      if (group) {
        byRole.get(group.id)!.push(member)
      } else {
        online.push(member)
      }
    } else {
      offline.push(member)
    }
  }

  const groups: MemberGroup[] = []
  for (const role of hoisted) {
    const list = byRole.get(role.id)!
    if (list.length === 0) continue
    groups.push({
      key: role.id,
      label: role.name,
      color: roleColorHex(role.color),
      members: sortByName(list),
    })
  }
  if (online.length > 0) {
    groups.push({ key: 'online', label: 'Online', color: null, members: sortByName(online) })
  }
  if (offline.length > 0) {
    groups.push({ key: 'offline', label: 'Offline', color: null, members: sortByName(offline) })
  }
  return groups
}

function sortByName(list: Member[]): Member[] {
  return [...list].sort((a, b) => displayName(a).localeCompare(displayName(b)))
}
