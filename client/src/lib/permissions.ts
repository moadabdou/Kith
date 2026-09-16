// Canonical Discord permission bit constants (1n << 0n through 1n << 28n)
// Reference: plan/06-permissions.md and Discord API Permissions specification
export const CREATE_INSTANT_INVITE = 1n << 0n
export const KICK_MEMBERS          = 1n << 1n
export const BAN_MEMBERS           = 1n << 2n
export const ADMINISTRATOR         = 1n << 3n
export const MANAGE_CHANNELS       = 1n << 4n
export const MANAGE_GUILD          = 1n << 5n
export const ADD_REACTIONS         = 1n << 6n
export const VIEW_AUDIT_LOG        = 1n << 7n
export const PRIORITY_SPEAKER      = 1n << 8n
export const STREAM                = 1n << 9n
export const VIEW_CHANNEL          = 1n << 10n
export const SEND_MESSAGES         = 1n << 11n
export const SEND_TTS_MESSAGES     = 1n << 12n
export const MANAGE_MESSAGES       = 1n << 13n
export const EMBED_LINKS           = 1n << 14n
export const ATTACH_FILES          = 1n << 15n
export const READ_MESSAGE_HISTORY  = 1n << 16n
export const MENTION_EVERYONE      = 1n << 17n
export const USE_EXTERNAL_EMOJIS   = 1n << 18n
export const VIEW_GUILD_INSIGHTS   = 1n << 19n
export const CONNECT               = 1n << 20n
export const SPEAK                 = 1n << 21n
export const MUTE_MEMBERS          = 1n << 22n
export const DEAFEN_MEMBERS        = 1n << 23n
export const MOVE_MEMBERS          = 1n << 24n
export const USE_VAD               = 1n << 25n
export const CHANGE_NICKNAME       = 1n << 26n
export const MANAGE_NICKNAMES      = 1n << 27n
export const MANAGE_ROLES          = 1n << 28n

// Mask of all 29 canonical permissions (0x1FFFFFFF = 536870911)
export const ALL_PERMISSIONS = (1n << 29n) - 1n

export type TargetType = 0 | 1 // 0 = role, 1 = member

export interface RoleLike {
  id: string | number | bigint
  guild_id?: string | number | bigint
  name?: string
  position?: number
  permissions: string | number | bigint
}

export interface OverwriteLike {
  channel_id?: string | number | bigint
  target_id: string | number | bigint
  target_type: TargetType | number
  allow: string | number | bigint
  deny: string | number | bigint
}

export function toBigInt(val: string | number | bigint | null | undefined): bigint {
  if (val == null) return 0n
  return BigInt(val)
}

/**
 * Resolves base guild permissions for a member.
 * Returns ALL_PERMISSIONS if the user is the guild owner or has ADMINISTRATOR.
 */
export function resolveGuildPermissions(
  guildId: string | number | bigint,
  ownerId: string | number | bigint,
  userId: string | number | bigint,
  roles: RoleLike[]
): bigint {
  const uId = toBigInt(userId)
  const oId = toBigInt(ownerId)

  // 1. Owner bypass
  if (uId === oId) {
    return ALL_PERMISSIONS
  }

  // 2. Base permissions: bitwise OR of all member roles (including @everyone)
  let base = 0n
  for (const role of roles) {
    base |= toBigInt(role.permissions)
  }

  // 3. Administrator bypass
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) {
    return ALL_PERMISSIONS
  }

  return base
}

/**
 * Resolves effective channel permissions for a member.
 * Implements Discord's exact hierarchical override resolution:
 * 1. Owner has ALL_PERMISSIONS.
 * 2. Base permissions = OR of all member roles.
 * 3. ADMINISTRATOR bypasses all channel overwrites (ALL_PERMISSIONS).
 * 4. Channel overwrites:
 *    a. @everyone overwrite: (perms & ~deny) | allow
 *    b. Member role overwrites: union all denies, union all allows, stack without position bias
 *    c. Member-specific overwrite applied last
 */
export function resolveChannelPermissions(
  guildId: string | number | bigint,
  ownerId: string | number | bigint,
  userId: string | number | bigint,
  roles: RoleLike[],
  overwrites: OverwriteLike[]
): bigint {
  const gId = toBigInt(guildId)
  const oId = toBigInt(ownerId)
  const uId = toBigInt(userId)

  // 1. Owner bypass
  if (uId === oId) {
    return ALL_PERMISSIONS
  }

  // 2. Base permissions
  const base = resolveGuildPermissions(gId, oId, uId, roles)
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) {
    return ALL_PERMISSIONS
  }

  let perms = base

  // 4a. Apply @everyone overwrite (target_type === 0 && target_id === guild_id)
  const everyoneOw = overwrites.find(
    (ow) => Number(ow.target_type) === 0 && toBigInt(ow.target_id) === gId
  )
  if (everyoneOw) {
    perms = (perms & ~toBigInt(everyoneOw.deny)) | toBigInt(everyoneOw.allow)
  }

  // 4b. Apply member role overwrites
  // Collect role IDs the member has (excluding @everyone which was handled in 4a)
  const roleIds = new Set(
    roles
      .map((r) => toBigInt(r.id))
      .filter((id) => id !== gId)
  )

  let roleDeny = 0n
  let roleAllow = 0n
  for (const ow of overwrites) {
    if (Number(ow.target_type) === 0 && toBigInt(ow.target_id) !== gId) {
      if (roleIds.has(toBigInt(ow.target_id))) {
        roleDeny |= toBigInt(ow.deny)
        roleAllow |= toBigInt(ow.allow)
      }
    }
  }
  perms = (perms & ~roleDeny) | roleAllow

  // 4c. Apply member-specific overwrite (target_type === 1 && target_id === user_id)
  const memberOw = overwrites.find(
    (ow) => Number(ow.target_type) === 1 && toBigInt(ow.target_id) === uId
  )
  if (memberOw) {
    perms = (perms & ~toBigInt(memberOw.deny)) | toBigInt(memberOw.allow)
  }

  return perms
}

/**
 * Checks whether the given permission bitmask includes the required permission(s).
 */
export function hasPermission(
  perms: string | number | bigint,
  permission: string | number | bigint
): boolean {
  const p = toBigInt(perms)
  const req = toBigInt(permission)
  return (p & req) === req
}
