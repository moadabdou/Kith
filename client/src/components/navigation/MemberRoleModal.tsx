import { useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [hoveredRoleId, setHoveredRoleId] = useState<string | null>(null)
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

  const modalElement = (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-content"
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 32px)',
          background: '#121318',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.08)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          overflow: 'hidden',
          padding: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.04))',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 15,
                color: '#ffffff',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {member.user.avatar ? (
                <img src={member.user.avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                initialsOf(name)
              )}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: '#ffffff', letterSpacing: '-0.01em', lineHeight: 1.2 }}>
                {name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted, #949ba4)', marginTop: 2 }}>
                @{member.user.username}#{member.user.discriminator}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: 'var(--text-muted, #949ba4)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#fff'
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.12)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted, #949ba4)'
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'
            }}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        {showKickConfirm ? (
          <div style={{ padding: '24px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#ffffff', marginBottom: 8 }}>
              Kick '{name}' from the server?
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted, #949ba4)', marginBottom: 20, lineHeight: 1.5 }}>
              Are you sure you want to kick <strong>{name}</strong> (@{member.user.username}#{member.user.discriminator})? They will be able to rejoin with a new invite link.
            </div>
            {error && (
              <div style={{ backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid rgba(218, 55, 60, 0.3)', color: '#ff7b72', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
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
                  color: 'var(--text-normal, #dbdee1)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent'
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
                  backgroundColor: '#da373c',
                  color: 'white',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: isKicking ? 'not-allowed' : 'pointer',
                  opacity: isKicking ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: '0 2px 10px rgba(218, 55, 60, 0.3)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isKicking) e.currentTarget.style.backgroundColor = '#a1282c'
                }}
                onMouseLeave={(e) => {
                  if (!isKicking) e.currentTarget.style.backgroundColor = '#da373c'
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
            <div style={{ padding: '18px 24px', maxHeight: 380, overflowY: 'auto' }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text-muted, #949ba4)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Shield size={13} strokeWidth={2.5} />
                <span>Server Roles</span>
                <span
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: 11,
                    color: '#ffffff',
                    marginLeft: 2,
                  }}
                >
                  {assignableRoles.length}
                </span>
              </div>

              {error && (
                <div style={{ backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid rgba(218, 55, 60, 0.3)', color: '#ff7b72', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
                  {error}
                </div>
              )}

              {assignableRoles.length === 0 ? (
                <div style={{ color: 'var(--text-muted, #949ba4)', fontSize: 14, textAlign: 'center', padding: '24px 0' }}>
                  No custom roles created yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {assignableRoles.map((role) => {
                    const hasRole = currentRoles.includes(role.id)
                    const isHigherOrEqual = !isOwner && (role.position ?? 0) >= callerHighestPosition
                    const hex = roleColorHex(role.color) || 'var(--text-muted)'
                    const disabled = !canManageRoles || isHigherOrEqual || updatingRoleId === role.id
                    const isHovered = hoveredRoleId === role.id

                    return (
                      <div
                        key={role.id}
                        onClick={() => !disabled && handleToggleRole(role)}
                        onMouseEnter={() => setHoveredRoleId(role.id)}
                        onMouseLeave={() => setHoveredRoleId(null)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          borderRadius: 10,
                          backgroundColor: hasRole
                            ? isHovered
                              ? 'rgba(255, 255, 255, 0.12)'
                              : 'rgba(255, 255, 255, 0.08)'
                            : isHovered
                            ? 'rgba(255, 255, 255, 0.05)'
                            : 'rgba(255, 255, 255, 0.02)',
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled && !hasRole ? 0.45 : 1,
                          border: hasRole
                            ? '1px solid rgba(255, 255, 255, 0.22)'
                            : isHovered
                            ? '1px solid rgba(255, 255, 255, 0.12)'
                            : '1px solid rgba(255, 255, 255, 0.06)',
                          transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
                          transform: isHovered && !disabled ? 'translateY(-1px)' : 'none',
                        }}
                        title={
                          isHigherOrEqual
                            ? 'You cannot modify a role higher than or equal to your highest role'
                            : !canManageRoles
                            ? 'You do not have permission to manage roles'
                            : undefined
                        }
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                          <span
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: '50%',
                              backgroundColor: hex,
                              boxShadow: hasRole ? `0 0 8px ${hex}88` : 'none',
                              flexShrink: 0,
                              transition: 'box-shadow 0.2s',
                            }}
                          />
                          <span
                            style={{
                              fontWeight: 600,
                              fontSize: 14,
                              color: hex !== 'var(--text-muted)' ? hex : '#ffffff',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {role.name}
                          </span>
                        </div>

                        <div
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 6,
                            border: hasRole ? 'none' : '2px solid rgba(255, 255, 255, 0.25)',
                            backgroundColor: hasRole ? '#ffffff' : 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: hasRole ? '0 2px 6px rgba(0, 0, 0, 0.4)' : 'none',
                            transition: 'all 0.15s ease',
                            flexShrink: 0,
                          }}
                        >
                          {hasRole && <Check size={13} strokeWidth={3} color="#000000" />}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: '16px 24px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'rgba(0, 0, 0, 0.35)',
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
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
                    border: '1px solid rgba(218, 55, 60, 0.25)',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(218, 55, 60, 0.2)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(218, 55, 60, 0.12)'
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
                  padding: '8px 22px',
                  backgroundColor: '#ffffff',
                  color: '#090a0d',
                  border: 'none',
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'pointer',
                  boxShadow: '0 2px 10px rgba(255, 255, 255, 0.2)',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#eaeaea'
                  e.currentTarget.style.transform = 'translateY(-1px)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#ffffff'
                  e.currentTarget.style.transform = 'translateY(0)'
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

  if (typeof document === 'undefined') {
    return modalElement
  }

  return createPortal(modalElement, document.body)
}
