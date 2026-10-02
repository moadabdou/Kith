import { describe, it, expect } from 'vitest'
import {
  hasUserMention,
  hasRoleMention,
  hasEveryoneMention,
  isMessageMentioningUser,
} from './mentions'

describe('mentions utility', () => {
  it('detects user mentions correctly with <@id> and <@!id>', () => {
    expect(hasUserMention('Hey <@12345> how are you?', '12345')).toBe(true)
    expect(hasUserMention('Hey <@!12345> nickname mention!', '12345')).toBe(true)
    expect(hasUserMention('Hey <@99999> other user', '12345')).toBe(false)
    expect(hasUserMention('No mention here', '12345')).toBe(false)
  })

  it('detects role mentions correctly with <@&id>', () => {
    expect(hasRoleMention('Attention <@&admin_role>!', ['admin_role', 'mod_role'])).toBe(true)
    expect(hasRoleMention('Attention <@&mod_role>!', ['admin_role', 'mod_role'])).toBe(true)
    expect(hasRoleMention('Attention <@&guest_role>!', ['admin_role'])).toBe(false)
    expect(hasRoleMention('No role mention', ['admin_role'])).toBe(false)
  })

  it('detects broadcast mentions @everyone and @here', () => {
    expect(hasEveryoneMention('Hello @everyone!')).toBe(true)
    expect(hasEveryoneMention('Stand up @here please.')).toBe(true)
    expect(hasEveryoneMention('@everyone')).toBe(true)
    expect(hasEveryoneMention('not_an_email@everyone.com')).toBe(false)
    expect(hasEveryoneMention('Normal chat message')).toBe(false)
  })

  it('evaluates whether a message mentions a specific user', () => {
    const userId = 'user_abc'
    const roleIds = ['role_vip', 'role_team']

    // User direct mention
    expect(isMessageMentioningUser('Check this <@user_abc>', userId, roleIds)).toBe(true)
    // Role mention
    expect(isMessageMentioningUser('Notice for <@&role_vip>', userId, roleIds)).toBe(true)
    // Everyone mention
    expect(isMessageMentioningUser('Alert @everyone', userId, roleIds)).toBe(true)
    // Here mention
    expect(isMessageMentioningUser('Meeting @here', userId, roleIds)).toBe(true)
    // Unrelated message
    expect(isMessageMentioningUser('Talking to <@other_user> and <@&other_role>', userId, roleIds)).toBe(false)
  })
})
