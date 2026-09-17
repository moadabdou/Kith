import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronUp, Plus, Shield, ShieldAlert, Trash2, X } from 'lucide-react'
import { api } from '../../api'
import { hexToRoleColor, roleColorHex } from '../../lib/members'
import {
  ADMINISTRATOR,
  ALL_PERMISSIONS,
  ATTACH_FILES,
  BAN_MEMBERS,
  CHANGE_NICKNAME,
  CONNECT,
  CREATE_INSTANT_INVITE,
  DEAFEN_MEMBERS,
  EMBED_LINKS,
  hasPermission,
  KICK_MEMBERS,
  MANAGE_CHANNELS,
  MANAGE_GUILD,
  MANAGE_MESSAGES,
  MANAGE_NICKNAMES,
  MANAGE_ROLES,
  MENTION_EVERYONE,
  MOVE_MEMBERS,
  MUTE_MEMBERS,
  PRIORITY_SPEAKER,
  READ_MESSAGE_HISTORY,
  SEND_MESSAGES,
  SEND_TTS_MESSAGES,
  SPEAK,
  STREAM,
  USE_EXTERNAL_EMOJIS,
  USE_VAD,
  VIEW_AUDIT_LOG,
  VIEW_CHANNEL,
  VIEW_GUILD_INSIGHTS,
} from '../../lib/permissions'
import type { Guild, Role } from '../../types'

import { useAuth } from '../../context/useAuth'

interface ServerSettingsModalProps {
  isOpen: boolean
  guild: Guild | null
  userPermissions?: bigint | null
  callerHighestPosition?: number
  isOwner?: boolean
  onClose: () => void
  onRolesChanged?: () => void
}

interface PermissionDef {
  flag: bigint
  name: string
  description: string
  category: 'general' | 'membership' | 'text' | 'voice'
  dangerous?: boolean
}

const PERMISSIONS_CATALOG: PermissionDef[] = [
  // General & Advanced
  { flag: ADMINISTRATOR, name: 'Administrator', description: 'Grants all permissions and bypasses channel overwrites. Dangerous!', category: 'general', dangerous: true },
  { flag: MANAGE_GUILD, name: 'Manage Server', description: 'Allows changing server name, regions, or viewing invites.', category: 'general' },
  { flag: MANAGE_ROLES, name: 'Manage Roles', description: 'Allows creating, editing, and deleting roles lower than this role.', category: 'general' },
  { flag: MANAGE_CHANNELS, name: 'Manage Channels', description: 'Allows creating, editing, or deleting channels.', category: 'general' },
  { flag: VIEW_AUDIT_LOG, name: 'View Audit Log', description: 'Allows viewing audit logs of server actions.', category: 'general' },
  { flag: VIEW_GUILD_INSIGHTS, name: 'View Server Insights', description: 'Allows viewing server insights.', category: 'general' },

  // Membership
  { flag: KICK_MEMBERS, name: 'Kick Members', description: 'Allows kicking members lower than this role.', category: 'membership' },
  { flag: BAN_MEMBERS, name: 'Ban Members', description: 'Allows banning members lower than this role.', category: 'membership' },
  { flag: CREATE_INSTANT_INVITE, name: 'Create Invite', description: 'Allows creating invite links to this server.', category: 'membership' },
  { flag: CHANGE_NICKNAME, name: 'Change Nickname', description: 'Allows changing own nickname in this server.', category: 'membership' },
  { flag: MANAGE_NICKNAMES, name: 'Manage Nicknames', description: 'Allows changing nicknames of other members.', category: 'membership' },

  // Text
  { flag: VIEW_CHANNEL, name: 'View Channels', description: 'Allows viewing text and voice channels by default.', category: 'text' },
  { flag: SEND_MESSAGES, name: 'Send Messages', description: 'Allows sending messages in text channels.', category: 'text' },
  { flag: EMBED_LINKS, name: 'Embed Links', description: 'Links posted will render embedded content.', category: 'text' },
  { flag: ATTACH_FILES, name: 'Attach Files', description: 'Allows uploading images and documents.', category: 'text' },
  { flag: READ_MESSAGE_HISTORY, name: 'Read Message History', description: 'Allows viewing previous messages in channels.', category: 'text' },
  { flag: MENTION_EVERYONE, name: 'Mention @everyone', description: 'Allows mentioning @everyone and @here.', category: 'text' },
  { flag: USE_EXTERNAL_EMOJIS, name: 'Use External Emojis', description: 'Allows using emojis from other servers.', category: 'text' },
  { flag: MANAGE_MESSAGES, name: 'Manage Messages', description: 'Allows deleting messages from other members.', category: 'text' },
  { flag: SEND_TTS_MESSAGES, name: 'Send TTS Messages', description: 'Allows sending text-to-speech messages.', category: 'text' },

  // Voice
  { flag: CONNECT, name: 'Connect', description: 'Allows joining voice channels.', category: 'voice' },
  { flag: SPEAK, name: 'Speak', description: 'Allows speaking in voice channels.', category: 'voice' },
  { flag: STREAM, name: 'Video / Stream', description: 'Allows sharing video or screen streaming.', category: 'voice' },
  { flag: MUTE_MEMBERS, name: 'Mute Members', description: 'Allows muting members in voice channels.', category: 'voice' },
  { flag: DEAFEN_MEMBERS, name: 'Deafen Members', description: 'Allows deafening members in voice channels.', category: 'voice' },
  { flag: MOVE_MEMBERS, name: 'Move Members', description: 'Allows moving members between voice channels.', category: 'voice' },
  { flag: USE_VAD, name: 'Use Voice Activity', description: 'Allows speaking without Push-to-Talk.', category: 'voice' },
  { flag: PRIORITY_SPEAKER, name: 'Priority Speaker', description: 'Allows speaking with priority volume.', category: 'voice' },
]

const PALETTE_COLORS = [
  '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63',
  '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b',
]

export function ServerSettingsModal({
  isOpen,
  guild,
  userPermissions,
  callerHighestPosition,
  isOwner,
  onClose,
  onRolesChanged,
}: ServerSettingsModalProps) {
  const { user } = useAuth()
  const effectiveIsOwner = isOwner ?? Boolean(guild && user && guild.owner_id === user.id)
  const [internalPermissions, setInternalPermissions] = useState<bigint | null>(userPermissions ?? null)
  const [internalCallerPos, setInternalCallerPos] = useState<number>(
    callerHighestPosition ?? (effectiveIsOwner ? Infinity : 0)
  )

  const [activeTab, setActiveTab] = useState<'overview' | 'roles'>('roles')
  const [roles, setRoles] = useState<Role[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [roleSubTab, setRoleSubTab] = useState<'display' | 'permissions'>('display')

  // Selected role draft state
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<number>(0)
  const [draftHoist, setDraftHoist] = useState(false)
  const [draftMentionable, setDraftMentionable] = useState(false)
  const [draftPermissions, setDraftPermissions] = useState<bigint>(0n)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Fetch permissions and member info when opened
  useEffect(() => {
    if (!isOpen || !guild || !user) return

    if (effectiveIsOwner) {
      setInternalPermissions(ALL_PERMISSIONS)
      setInternalCallerPos(Infinity)
      return
    }

    let active = true
    Promise.all([
      api.getMyPermissions(guild.id),
      api.getRoles(guild.id),
      api.getMembers(guild.id),
    ])
      .then(([permRes, rolesList, membersList]) => {
        if (!active) return
        setInternalPermissions(BigInt(permRes.permissions))
        const me = membersList.find((m) => m.user.id === user.id)
        if (me) {
          const highest = Math.max(
            0,
            ...me.roles.map((rId) => rolesList.find((r) => r.id === rId)?.position ?? 0)
          )
          setInternalCallerPos(highest)
        }
      })
      .catch((err) => console.error('Failed to load modal permissions/members:', err))

    return () => {
      active = false
    }
  }, [isOpen, guild, user, effectiveIsOwner])

  const effectivePerms = userPermissions ?? internalPermissions
  const effectiveCallerHighestPos = callerHighestPosition ?? internalCallerPos

  // Load roles on open or guild change
  const loadRoles = async () => {
    if (!guild) return
    try {
      const list = await api.getRoles(guild.id)
      setRoles(list)
      if (list.length > 0 && (!selectedRoleId || !list.some((r) => r.id === selectedRoleId))) {
        // default to first non-everyone role or everyone
        const sorted = [...list].sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        setSelectedRoleId(sorted[0].id)
      }
    } catch (err: any) {
      console.error('Failed to load roles:', err)
      setError(err.message || 'Failed to load roles')
    }
  }

  useEffect(() => {
    if (isOpen && guild) {
      loadRoles()
    }
  }, [isOpen, guild])

  // Sync draft when selected role changes
  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? null

  useEffect(() => {
    if (selectedRole) {
      setDraftName(selectedRole.name)
      setDraftColor(selectedRole.color ?? 0)
      setDraftHoist(selectedRole.hoist ?? false)
      setDraftMentionable(selectedRole.mentionable ?? false)
      setDraftPermissions(BigInt(selectedRole.permissions || '0'))
      setError(null)
      setSuccess(null)
    }
  }, [selectedRoleId])

  if (!isOpen || !guild) return null

  const isEveryoneRole = selectedRole?.id === guild.id
  const isRoleReadOnly =
    !effectiveIsOwner &&
    selectedRole != null &&
    !isEveryoneRole &&
    (selectedRole.position ?? 0) >= effectiveCallerHighestPos

  const canCreateRole =
    effectiveIsOwner ||
    (effectivePerms != null &&
      (hasPermission(effectivePerms, ADMINISTRATOR) ||
        hasPermission(effectivePerms, MANAGE_ROLES)))

  // Check if draft has unsaved changes
  const hasChanges =
    selectedRole != null &&
    (draftName !== selectedRole.name ||
      draftColor !== (selectedRole.color ?? 0) ||
      draftHoist !== (selectedRole.hoist ?? false) ||
      draftMentionable !== (selectedRole.mentionable ?? false) ||
      draftPermissions.toString() !== (selectedRole.permissions || '0'))

  const handleReset = () => {
    if (!selectedRole) return
    setDraftName(selectedRole.name)
    setDraftColor(selectedRole.color ?? 0)
    setDraftHoist(selectedRole.hoist ?? false)
    setDraftMentionable(selectedRole.mentionable ?? false)
    setDraftPermissions(BigInt(selectedRole.permissions || '0'))
    setError(null)
    setSuccess(null)
  }

  const handleSaveChanges = async () => {
    if (!selectedRole || isRoleReadOnly) return
    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const updated = await api.updateRole(guild.id, selectedRole.id, {
        name: isEveryoneRole ? undefined : draftName.trim() || undefined,
        color: draftColor,
        hoist: isEveryoneRole ? undefined : draftHoist,
        mentionable: isEveryoneRole ? undefined : draftMentionable,
        permissions: draftPermissions.toString(),
      })

      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
      setSuccess('Role changes saved successfully!')
      onRolesChanged?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to update role')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateRole = async () => {
    if (!canCreateRole) return
    setError(null)
    setSuccess(null)

    try {
      const newRole = await api.createRole(guild.id, {
        name: 'new role',
        color: 0,
        hoist: false,
        permissions: '0',
      })
      setRoles((prev) => [...prev, newRole])
      setSelectedRoleId(newRole.id)
      setRoleSubTab('display')
      setSuccess('Created new role!')
      onRolesChanged?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to create role')
    }
  }

  const handleDeleteRole = async () => {
    if (!selectedRole || isEveryoneRole || isRoleReadOnly) return
    if (!confirm(`Are you sure you want to delete the role "${selectedRole.name}"?`)) return

    setError(null)
    setSuccess(null)
    try {
      await api.deleteRole(guild.id, selectedRole.id)
      const remaining = roles.filter((r) => r.id !== selectedRole.id)
      setRoles(remaining)
      if (remaining.length > 0) {
        setSelectedRoleId(remaining[0].id)
      } else {
        setSelectedRoleId(null)
      }
      setSuccess('Role deleted!')
      onRolesChanged?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to delete role')
    }
  }

  const togglePermission = (flag: bigint) => {
    if (isRoleReadOnly) return
    // Hierarchy check: non-owners cannot grant permissions they do not possess
    if (!effectiveIsOwner && effectivePerms != null && (effectivePerms & flag) !== flag) {
      setError('You cannot grant a permission that you do not possess.')
      return
    }

    setDraftPermissions((prev) => {
      if ((prev & flag) === flag) {
        return prev & ~flag
      }
      return prev | flag
    })
  }

  const handleMoveRole = async (role: Role, direction: 'up' | 'down') => {
    if (role.id === guild.id) return // cannot move @everyone
    const curIdx = sortedRoles.findIndex((r) => r.id === role.id)
    if (curIdx === -1) return
    const targetIdx = direction === 'up' ? curIdx - 1 : curIdx + 1
    if (targetIdx < 0 || targetIdx >= sortedRoles.length) return
    const targetRole = sortedRoles[targetIdx]
    if (targetRole.id === guild.id) return // cannot swap with @everyone

    if (!effectiveIsOwner) {
      if (
        (role.position ?? 0) >= effectiveCallerHighestPos ||
        (targetRole.position ?? 0) >= effectiveCallerHighestPos
      ) {
        setError('You cannot reorder roles at or above your highest role.')
        return
      }
    }

    let newRolePos = targetRole.position ?? 0
    let newTargetPos = role.position ?? 0

    if (newRolePos === newTargetPos) {
      if (direction === 'up') {
        newRolePos = newTargetPos + 1
      } else {
        newTargetPos = newRolePos + 1
      }
    }

    const previousRoles = [...roles]
    setRoles((prev) =>
      prev.map((r) => {
        if (r.id === role.id) return { ...r, position: newRolePos }
        if (r.id === targetRole.id) return { ...r, position: newTargetPos }
        return r
      })
    )
    setError(null)

    try {
      await Promise.all([
        api.updateRole(guild.id, role.id, { position: newRolePos }),
        api.updateRole(guild.id, targetRole.id, { position: newTargetPos }),
      ])
      setSuccess(`Reordered ${role.name}`)
      onRolesChanged?.()
      setTimeout(() => setSuccess(null), 2500)
    } catch (err: any) {
      setRoles(previousRoles)
      setError(err.message || 'Failed to reorder roles')
    }
  }

  const sortedRoles = [...roles].sort((a, b) => {
    if (b.id === guild.id) return -1
    if (a.id === guild.id) return 1
    const diff = (b.position ?? 0) - (a.position ?? 0)
    if (diff !== 0) return diff
    return b.id.localeCompare(a.id)
  })
  const selectedColorHex = roleColorHex(draftColor)

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 960,
          maxWidth: '95vw',
          height: '85vh',
          maxHeight: 820,
          display: 'flex',
          flexDirection: 'row',
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: 'var(--bg-chat)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Left Navigation Rail */}
        <div
          style={{
            width: 210,
            backgroundColor: 'var(--bg-channels)',
            display: 'flex',
            flexDirection: 'column',
            padding: '24px 12px',
            borderRight: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              padding: '0 10px 10px',
              letterSpacing: '0.05em',
            }}
          >
            {guild.name}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'overview' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'overview' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'overview' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('roles')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'roles' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'roles' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'roles' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Shield size={16} /> Roles
            </button>
          </div>

          <div style={{ marginTop: 'auto', padding: '0 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.6 }}>
              Press ESC or Close to exit
            </div>
          </div>
        </div>

        {/* Right Main Content Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Top Bar with ESC */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 24px',
              borderBottom: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-chat)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)' }}>
                {activeTab === 'overview' ? 'Server Overview' : 'Server Roles'}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                padding: '4px 8px',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
              title="Close Settings"
            >
              ESC <X size={14} />
            </button>
          </div>

          {/* Tab: Overview */}
          {activeTab === 'overview' && (
            <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
              <div style={{ maxWidth: 500, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    Server Name
                  </label>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-header)', marginTop: 4 }}>
                    {guild.name}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    Server ID
                  </label>
                  <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: 4 }}>
                    {guild.id}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    Owner
                  </label>
                  <div style={{ fontSize: 14, color: 'var(--text-normal)', marginTop: 4 }}>
                    {isOwner ? 'You are the server owner' : `Owner ID: ${guild.owner_id}`}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    Configured Roles
                  </label>
                  <div style={{ fontSize: 14, color: 'var(--text-normal)', marginTop: 4 }}>
                    {roles.length} roles total
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab: Roles */}
          {activeTab === 'roles' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
              {/* Middle Roles Column */}
              <div
                style={{
                  width: 220,
                  backgroundColor: 'rgba(0,0,0,0.1)',
                  borderRight: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 12,
                  overflowY: 'auto',
                }}
              >
                <button
                  type="button"
                  disabled={!canCreateRole}
                  onClick={handleCreateRole}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '8px 12px',
                    backgroundColor: canCreateRole ? 'var(--brand)' : 'rgba(255,255,255,0.05)',
                    color: canCreateRole ? 'white' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: canCreateRole ? 'pointer' : 'not-allowed',
                    marginBottom: 12,
                  }}
                  title={!canCreateRole ? 'You do not have permission to manage roles' : undefined}
                >
                  <Plus size={16} /> Create Role
                </button>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {sortedRoles.map((role, idx) => {
                    const isSelected = selectedRoleId === role.id
                    const hex = roleColorHex(role.color) || 'var(--text-muted)'
                    const isEveryone = role.id === guild.id
                    const canMoveUp =
                      !isEveryone &&
                      idx > 0 &&
                      (effectiveIsOwner ||
                        ((role.position ?? 0) < effectiveCallerHighestPos &&
                          (sortedRoles[idx - 1].position ?? 0) < effectiveCallerHighestPos))
                    const canMoveDown =
                      !isEveryone &&
                      idx < sortedRoles.length - 2 &&
                      (effectiveIsOwner || (role.position ?? 0) < effectiveCallerHighestPos)

                    return (
                      <div
                        key={role.id}
                        onClick={() => setSelectedRoleId(role.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '7px 8px',
                          borderRadius: 4,
                          backgroundColor: isSelected ? 'var(--bg-hover)' : 'transparent',
                          cursor: 'pointer',
                          color: isSelected ? 'var(--text-header)' : 'var(--text-normal)',
                          fontWeight: isSelected ? 600 : 500,
                          fontSize: 13,
                          transition: 'background 0.15s ease',
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            backgroundColor: hex,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {isEveryone ? '@everyone' : role.name}
                        </span>

                        {!isEveryone && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              disabled={!canMoveUp}
                              onClick={() => handleMoveRole(role, 'up')}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: canMoveUp ? 'var(--text-muted)' : 'rgba(255,255,255,0.1)',
                                cursor: canMoveUp ? 'pointer' : 'not-allowed',
                                padding: 2,
                                display: 'flex',
                              }}
                              title="Move Up in Hierarchy"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              disabled={!canMoveDown}
                              onClick={() => handleMoveRole(role, 'down')}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: canMoveDown ? 'var(--text-muted)' : 'rgba(255,255,255,0.1)',
                                cursor: canMoveDown ? 'pointer' : 'not-allowed',
                                padding: 2,
                                display: 'flex',
                              }}
                              title="Move Down in Hierarchy"
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                        )}

                        {isSelected && <ChevronRight size={14} color="var(--text-muted)" />}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Right Role Editor Column */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
                {selectedRole ? (
                  <>
                    {/* Sub-tabs: Display vs Permissions */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 20,
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--border-subtle)',
                        backgroundColor: 'var(--bg-chat)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setRoleSubTab('display')}
                        style={{
                          background: 'none',
                          border: 'none',
                          borderBottom: roleSubTab === 'display' ? '2px solid var(--brand)' : '2px solid transparent',
                          padding: '4px 0',
                          color: roleSubTab === 'display' ? 'var(--text-header)' : 'var(--text-muted)',
                          fontWeight: 600,
                          fontSize: 14,
                          cursor: 'pointer',
                        }}
                      >
                        Display
                      </button>
                      <button
                        type="button"
                        onClick={() => setRoleSubTab('permissions')}
                        style={{
                          background: 'none',
                          border: 'none',
                          borderBottom: roleSubTab === 'permissions' ? '2px solid var(--brand)' : '2px solid transparent',
                          padding: '4px 0',
                          color: roleSubTab === 'permissions' ? 'var(--text-header)' : 'var(--text-muted)',
                          fontWeight: 600,
                          fontSize: 14,
                          cursor: 'pointer',
                        }}
                      >
                        Permissions
                      </button>
                    </div>

                    {/* Messages */}
                    {error && (
                      <div style={{ margin: '16px 24px 0', backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '8px 12px', borderRadius: 4, fontSize: 13 }}>
                        {error}
                      </div>
                    )}
                    {success && (
                      <div style={{ margin: '16px 24px 0', backgroundColor: 'rgba(35, 165, 90, 0.15)', border: '1px solid #23a55a', color: '#57f287', padding: '8px 12px', borderRadius: 4, fontSize: 13 }}>
                        {success}
                      </div>
                    )}
                    {isRoleReadOnly && (
                      <div style={{ margin: '16px 24px 0', backgroundColor: 'rgba(240, 178, 50, 0.15)', border: '1px solid #f0b232', color: '#f0b232', padding: '8px 12px', borderRadius: 4, fontSize: 13 }}>
                        You cannot edit this role because it is higher than or equal to your highest role.
                      </div>
                    )}

                    {/* Sub-tab content */}
                    <div style={{ flex: 1, padding: 24, overflowY: 'auto', paddingBottom: hasChanges ? 80 : 24 }}>
                      {roleSubTab === 'display' && (
                        <div style={{ maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 24 }}>
                          {/* Role Name */}
                          <div>
                            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                              Role Name
                            </label>
                            <input
                              type="text"
                              disabled={isEveryoneRole || isRoleReadOnly}
                              value={draftName}
                              onChange={(e) => setDraftName(e.target.value)}
                              placeholder="Role Name"
                              style={{
                                width: '100%',
                                padding: '10px 12px',
                                backgroundColor: 'var(--bg-chat-input)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 4,
                                color: 'var(--text-header)',
                                fontSize: 14,
                                outline: 'none',
                              }}
                            />
                            {isEveryoneRole && (
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                The @everyone role cannot be renamed.
                              </div>
                            )}
                          </div>

                          {/* Role Color */}
                          <div>
                            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                              Role Color
                            </label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                              <div
                                style={{
                                  width: 36,
                                  height: 36,
                                  borderRadius: 4,
                                  backgroundColor: selectedColorHex || '#4f545c',
                                  border: '1px solid var(--border-subtle)',
                                }}
                              />
                              <div style={{ fontSize: 14, fontWeight: 600, color: selectedColorHex || 'var(--text-muted)' }}>
                                {selectedColorHex ? selectedColorHex.toUpperCase() : 'Default (No Color)'}
                              </div>
                              <button
                                type="button"
                                disabled={isRoleReadOnly}
                                onClick={() => setDraftColor(0)}
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: 4,
                                  border: '1px solid var(--border-subtle)',
                                  background: 'transparent',
                                  color: 'var(--text-muted)',
                                  fontSize: 12,
                                  cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                }}
                              >
                                Clear Color
                              </button>
                            </div>

                            {/* Color Palette Grid */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                              {PALETTE_COLORS.map((hex) => {
                                const isCur = selectedColorHex?.toLowerCase() === hex.toLowerCase()
                                return (
                                  <button
                                    key={hex}
                                    type="button"
                                    disabled={isRoleReadOnly}
                                    onClick={() => setDraftColor(hexToRoleColor(hex))}
                                    style={{
                                      width: 32,
                                      height: 32,
                                      borderRadius: 4,
                                      backgroundColor: hex,
                                      border: isCur ? '2px solid white' : '1px solid transparent',
                                      cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    {isCur && <Check size={16} color="white" />}
                                  </button>
                                )
                              })}

                              {/* Custom Color Picker input */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                                <input
                                  type="color"
                                  disabled={isRoleReadOnly}
                                  value={selectedColorHex || '#5865f2'}
                                  onChange={(e) => setDraftColor(hexToRoleColor(e.target.value))}
                                  style={{
                                    width: 32,
                                    height: 32,
                                    border: 'none',
                                    borderRadius: 4,
                                    cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                    backgroundColor: 'transparent',
                                  }}
                                  title="Pick custom color"
                                />
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Custom</span>
                              </div>
                            </div>
                          </div>

                          {/* Role Hierarchy Section */}
                          {!isEveryoneRole && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 0', borderTop: '1px solid var(--border-subtle)' }}>
                              <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                                Role Hierarchy & Position
                              </label>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.12)', padding: '12px 14px', borderRadius: 6 }}>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                                    Position: #{selectedRole.position ?? 1}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                    Higher roles override lower roles in permissions and member name color.
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <button
                                    type="button"
                                    disabled={isRoleReadOnly || sortedRoles.findIndex((r) => r.id === selectedRole.id) === 0}
                                    onClick={() => handleMoveRole(selectedRole, 'up')}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 4,
                                      padding: '6px 12px',
                                      backgroundColor: 'var(--bg-modifier-hover)',
                                      border: '1px solid var(--border-subtle)',
                                      borderRadius: 4,
                                      color: 'var(--text-normal)',
                                      fontSize: 13,
                                      cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    <ArrowUp size={14} /> Move Up
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      isRoleReadOnly ||
                                      sortedRoles.findIndex((r) => r.id === selectedRole.id) >= sortedRoles.length - 2
                                    }
                                    onClick={() => handleMoveRole(selectedRole, 'down')}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 4,
                                      padding: '6px 12px',
                                      backgroundColor: 'var(--bg-modifier-hover)',
                                      border: '1px solid var(--border-subtle)',
                                      borderRadius: 4,
                                      color: 'var(--text-normal)',
                                      fontSize: 13,
                                      cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    <ArrowDown size={14} /> Move Down
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Hoist Toggle */}
                          {!isEveryoneRole && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--border-subtle)' }}>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                                  Display role members separately from online members
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                  Hoists this role into its own section in the right-hand member sidebar.
                                </div>
                              </div>
                              <input
                                type="checkbox"
                                disabled={isRoleReadOnly}
                                checked={draftHoist}
                                onChange={(e) => setDraftHoist(e.target.checked)}
                                style={{ width: 18, height: 18, cursor: isRoleReadOnly ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          )}

                          {/* Mentionable Toggle */}
                          {!isEveryoneRole && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderTop: '1px solid var(--border-subtle)' }}>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                                  Allow anyone to @mention this role
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                  Enables members to ping anyone holding this role.
                                </div>
                              </div>
                              <input
                                type="checkbox"
                                disabled={isRoleReadOnly}
                                checked={draftMentionable}
                                onChange={(e) => setDraftMentionable(e.target.checked)}
                                style={{ width: 18, height: 18, cursor: isRoleReadOnly ? 'not-allowed' : 'pointer' }}
                              />
                            </div>
                          )}

                          {/* Delete Role Button */}
                          {!isEveryoneRole && (
                            <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                              <button
                                type="button"
                                disabled={isRoleReadOnly}
                                onClick={handleDeleteRole}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: '8px 14px',
                                  backgroundColor: 'rgba(218, 55, 60, 0.1)',
                                  border: '1px solid var(--danger)',
                                  borderRadius: 4,
                                  color: '#ff7b72',
                                  fontWeight: 600,
                                  fontSize: 13,
                                  cursor: isRoleReadOnly ? 'not-allowed' : 'pointer',
                                }}
                              >
                                <Trash2 size={16} /> Delete Role
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {roleSubTab === 'permissions' && (
                        <div style={{ maxWidth: 580, display: 'flex', flexDirection: 'column', gap: 20 }}>
                          {['general', 'membership', 'text', 'voice'].map((cat) => {
                            const perms = PERMISSIONS_CATALOG.filter((p) => p.category === cat)
                            const catTitle =
                              cat === 'general'
                                ? 'General Server Permissions'
                                : cat === 'membership'
                                ? 'Membership Permissions'
                                : cat === 'text'
                                ? 'Text Channel Permissions'
                                : 'Voice Channel Permissions'

                            return (
                              <div key={cat} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  {catTitle}
                                </div>

                                {perms.map((p) => {
                                  const isEnabled = (draftPermissions & p.flag) === p.flag
                                  const callerHas =
                                    effectiveIsOwner ||
                                    (effectivePerms != null && (effectivePerms & p.flag) === p.flag)
                                  const disabled = isRoleReadOnly || !callerHas

                                  return (
                                    <div
                                      key={p.name}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '12px 14px',
                                        backgroundColor: 'rgba(0,0,0,0.12)',
                                        borderRadius: 6,
                                        gap: 16,
                                        opacity: disabled && !isEnabled ? 0.5 : 1,
                                      }}
                                    >
                                      <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-header)' }}>
                                            {p.name}
                                          </span>
                                          {p.dangerous && (
                                            <span
                                              style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 4,
                                                fontSize: 10,
                                                fontWeight: 700,
                                                backgroundColor: 'rgba(218, 55, 60, 0.2)',
                                                color: '#ff7b72',
                                                padding: '2px 6px',
                                                borderRadius: 4,
                                                textTransform: 'uppercase',
                                              }}
                                            >
                                              <ShieldAlert size={12} /> Dangerous
                                            </span>
                                          )}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                          {p.description}
                                        </div>
                                        {!callerHas && !effectiveIsOwner && (
                                          <div style={{ fontSize: 11, color: '#f0b232', marginTop: 2 }}>
                                            You do not possess this permission and cannot grant it.
                                          </div>
                                        )}
                                      </div>

                                      <input
                                        type="checkbox"
                                        disabled={disabled}
                                        checked={isEnabled}
                                        onChange={() => togglePermission(p.flag)}
                                        style={{ width: 18, height: 18, cursor: disabled ? 'not-allowed' : 'pointer' }}
                                      />
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/* Unsaved Changes Bottom Floating Bar */}
                    {hasChanges && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: 12,
                          left: 16,
                          right: 16,
                          backgroundColor: '#111214',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 8,
                          padding: '12px 18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                          zIndex: 10,
                          animation: 'fadeIn 0.15s ease',
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                          Careful — you have unsaved changes!
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <button
                            type="button"
                            onClick={handleReset}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: 'pointer',
                              padding: '6px 12px',
                            }}
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={handleSaveChanges}
                            style={{
                              padding: '8px 16px',
                              backgroundColor: '#23a55a',
                              color: 'white',
                              border: 'none',
                              borderRadius: 4,
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: saving ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {saving ? 'Saving…' : 'Save Changes'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 14, textAlign: 'center' }}>
                    No role selected.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
