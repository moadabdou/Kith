import { useState } from 'react'
import { Check, Shield, X } from 'lucide-react'
import { api } from '../../api'
import { displayName, initialsOf, roleColorHex } from '../../lib/members'
import type { Member, Role } from '../../types'

interface MemberRoleModalProps {
  member: Member
  guildId: string
  roles: Role[]
  callerHighestPosition: number
  isOwner: boolean
  canManageRoles: boolean
  onClose: () => void
  onRolesUpdated: (userId: string, newRoles: string[]) => void
}

export function MemberRoleModal({
  member,
  guildId,
  roles,
  callerHighestPosition,
  isOwner,
  canManageRoles,
  onClose,
  onRolesUpdated,
}: MemberRoleModalProps) {
  const [currentRoles, setCurrentRoles] = useState<string[]>(member.roles)
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Filter out @everyone (id === guildId) and sort descending by position
  const assignableRoles = roles
    .filter((r) => r.id !== guildId)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))

  const handleToggleRole = async (role: Role) => {
    if (!canManageRoles) return
    const hasRole = currentRoles.includes(role.id)
    const isHigherOrEqual = !isOwner && (role.position ?? 0) >= callerHighestPosition
    if (isHigherOrEqual) {
      setError('You cannot modify a role higher than or equal to your highest role.')
      return
    }

    setUpdatingRoleId(role.id)
    setError(null)

    const nextRoles = hasRole
      ? currentRoles.filter((id) => id !== role.id)
      : [...currentRoles, role.id]

    // Optimistic update
    setCurrentRoles(nextRoles)
    onRolesUpdated(member.user.id, nextRoles)

    try {
      if (hasRole) {
        await api.unassignMemberRole(guildId, member.user.id, role.id)
      } else {
        await api.assignMemberRole(guildId, member.user.id, role.id)
      }
    } catch (err: any) {
      // Revert on error
      setCurrentRoles(currentRoles)
      onRolesUpdated(member.user.id, currentRoles)
      setError(err.message || 'Failed to update role')
    } finally {
      setUpdatingRoleId(null)
    }
  }

  const name = displayName(member)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 440, width: '90%' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="member-avatar" style={{ width: 36, height: 36, fontSize: 14 }}>
              {initialsOf(name)}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-header)' }}>{name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                @{member.user.username}#{member.user.discriminator}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Roles Body */}
        <div className="modal-body" style={{ padding: '16px 20px', maxHeight: 360, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Shield size={14} /> Server Roles ({assignableRoles.length})
          </div>

          {error && (
            <div style={{ backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '8px 12px', borderRadius: 4, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {assignableRoles.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '16px 0' }}>
              No custom roles created yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {assignableRoles.map((role) => {
                const hasRole = currentRoles.includes(role.id)
                const isHigherOrEqual = !isOwner && (role.position ?? 0) >= callerHighestPosition
                const hex = roleColorHex(role.color) || 'var(--text-muted)'
                const disabled = !canManageRoles || isHigherOrEqual || updatingRoleId === role.id

                return (
                  <div
                    key={role.id}
                    onClick={() => !disabled && handleToggleRole(role)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: 6,
                      backgroundColor: hasRole ? 'rgba(88, 101, 242, 0.12)' : 'var(--bg-hover)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled && !hasRole ? 0.45 : 1,
                      border: hasRole ? '1px solid rgba(88, 101, 242, 0.4)' : '1px solid transparent',
                      transition: 'all 0.15s ease',
                    }}
                    title={
                      isHigherOrEqual
                        ? 'You cannot modify a role higher than or equal to your highest role'
                        : !canManageRoles
                        ? 'You do not have permission to manage roles'
                        : undefined
                    }
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          backgroundColor: hex,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 600, fontSize: 14, color: hex !== 'var(--text-muted)' ? hex : 'var(--text-normal)' }}>
                        {role.name}
                      </span>
                    </div>

                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 4,
                        border: hasRole ? 'none' : '2px solid var(--text-muted)',
                        backgroundColor: hasRole ? 'var(--brand)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                      }}
                    >
                      {hasRole && <Check size={14} strokeWidth={3} />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ padding: '12px 20px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              backgroundColor: 'var(--brand)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
