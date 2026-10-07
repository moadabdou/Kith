import { useState } from 'react'
import { Check, Shield, UserX, X } from 'lucide-react'
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
  canKickMembers?: boolean
  guildOwnerId?: string
  currentUserId?: string
  onClose: () => void
  onRolesUpdated: (userId: string, newRoles: string[]) => void
  onMemberKicked?: (userId: string) => void
}

export function MemberRoleModal({
  member,
  guildId,
  roles,
  callerHighestPosition,
  isOwner,
  canManageRoles,
  canKickMembers,
  guildOwnerId,
  currentUserId,
  onClose,
  onRolesUpdated,
  onMemberKicked,
}: MemberRoleModalProps) {
  const [currentRoles, setCurrentRoles] = useState<string[]>(member.roles)
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showKickConfirm, setShowKickConfirm] = useState(false)
  const [isKicking, setIsKicking] = useState(false)

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

  const targetHighestPosition = Math.max(
    0,
    ...member.roles.map((rId) => roles.find((r) => r.id === rId)?.position ?? 0)
  )
  const isTargetOwner = Boolean(guildOwnerId && member.user.id === guildOwnerId)
  const isTargetSelf = Boolean(currentUserId && member.user.id === currentUserId)
  const canKickTarget =
    Boolean(canKickMembers) &&
    !isTargetOwner &&
    !isTargetSelf &&
    (isOwner || callerHighestPosition > targetHighestPosition)

  const handleKickMember = async () => {
    setIsKicking(true)
    setError(null)
    try {
      await api.kickMember(guildId, member.user.id)
      onMemberKicked?.(member.user.id)
      onClose()
    } catch (err: any) {
      setError(err?.message || 'Failed to kick member')
      setIsKicking(false)
      setShowKickConfirm(false)
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
              {member.user.avatar ? (
                <img src={member.user.avatar} alt={name} className="member-avatar-img" />
              ) : (
                initialsOf(name)
              )}
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

        {showKickConfirm ? (
          <div className="modal-body" style={{ padding: '20px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-header)', marginBottom: 8 }}>
              Kick '{name}' from the server?
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 20 }}>
              Are you sure you want to kick <strong>{name}</strong> (@{member.user.username}#{member.user.discriminator})? They will be able to rejoin with a new invite link.
            </div>
            {error && (
              <div style={{ backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '8px 12px', borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => setShowKickConfirm(false)}
                disabled={isKicking}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'transparent',
                  color: 'var(--text-normal)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleKickMember}
                disabled={isKicking}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--danger, #da373c)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: isKicking ? 'not-allowed' : 'pointer',
                  opacity: isKicking ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <UserX size={15} />
                {isKicking ? 'Kicking...' : 'Kick Member'}
              </button>
            </div>
          </div>
        ) : (
          <>
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
                      backgroundColor: hasRole ? 'rgba(255, 255, 255, 0.15)' : 'var(--bg-hover)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled && !hasRole ? 0.45 : 1,
                      border: hasRole ? '1px solid rgba(255, 255, 255, 0.4)' : '1px solid transparent',
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
                        backgroundColor: hasRole ? '#ffffff' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#000000',
                      }}
                    >
                      {hasRole && <Check size={14} strokeWidth={3} color="#000000" />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {canKickTarget ? (
            <button
              type="button"
              onClick={() => setShowKickConfirm(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                backgroundColor: 'rgba(218, 55, 60, 0.12)',
                color: '#ff7b72',
                border: '1px solid rgba(218, 55, 60, 0.3)',
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <UserX size={15} />
              Kick Member
            </button>
          ) : <div />}

          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              backgroundColor: '#ffffff',
              color: '#000000',
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
        </>
        )}
      </div>
    </div>
  )
}
