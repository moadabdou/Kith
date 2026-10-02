/**
 * Mention parsing and highlight detection utilities for Discord-flavor messaging.
 */

const EVERYONE_HERE_REGEX = /(?:^|\s)@(everyone|here)(?:\b|[.,!?;:])/

/**
 * Checks if a message contains a user mention for the specific userId (<@id> or <@!id>).
 */
export function hasUserMention(content: string, userId: string): boolean {
  if (!content || !userId) return false
  const userRegex = new RegExp(`<@!?${userId}>`)
  return userRegex.test(content)
}

/**
 * Checks if a message contains a role mention for any of the given roleIds (<@&id>).
 */
export function hasRoleMention(content: string, roleIds: string[]): boolean {
  if (!content || !roleIds || roleIds.length === 0) return false
  return roleIds.some((roleId) => {
    const roleRegex = new RegExp(`<@&${roleId}>`)
    return roleRegex.test(content)
  })
}

/**
 * Checks if a message contains an @everyone or @here broadcast mention.
 */
export function hasEveryoneMention(content: string): boolean {
  if (!content) return false
  return EVERYONE_HERE_REGEX.test(content)
}

/**
 * Determines whether a message directly mentions the given user, one of the user's roles,
 * or broadcasts to everyone/here.
 */
export function isMessageMentioningUser(
  content: string,
  userId?: string,
  userRoleIds?: string[]
): boolean {
  if (!content) return false
  if (userId && hasUserMention(content, userId)) return true
  if (userRoleIds && hasRoleMention(content, userRoleIds)) return true
  return hasEveryoneMention(content)
}
