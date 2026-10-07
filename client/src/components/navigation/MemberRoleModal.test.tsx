import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemberRoleModal } from './MemberRoleModal'
import type { Member, Role } from '../../types'

describe('MemberRoleModal', () => {
  const mockMember: Member = {
    user: {
      id: 'user1',
      username: 'moadabdou',
      discriminator: '5501',
    },
    nick: null,
    roles: ['role1'],
    joined_at: '2026-01-01T00:00:00Z',
  }

  const mockRoles: Role[] = [
    { id: 'role1', guild_id: 'guild1', name: 'nerd', color: 0x3498db, position: 2, permissions: '0', hoist: false, mentionable: false, created_at: '2026-01-01T00:00:00Z' },
    { id: 'role2', guild_id: 'guild1', name: 'moderators', color: 0xf1c40f, position: 1, permissions: '0', hoist: false, mentionable: false, created_at: '2026-01-01T00:00:00Z' },
  ]

  it('renders member header with name, discriminator, and roles count', () => {
    const html = renderToStaticMarkup(
      <MemberRoleModal
        member={mockMember}
        guildId="guild1"
        roles={mockRoles}
        callerHighestPosition={10}
        isOwner={true}
        canManageRoles={true}
        onClose={vi.fn()}
        onRolesUpdated={vi.fn()}
      />
    )

    expect(html).toContain('moadabdou')
    expect(html).toContain('@moadabdou#5501')
    expect(html).toContain('Server Roles')
    expect(html).toContain('nerd')
    expect(html).toContain('moderators')
    expect(html).toContain('Done')
  })
})
