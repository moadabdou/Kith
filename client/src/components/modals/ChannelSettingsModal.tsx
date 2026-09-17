import { useEffect, useState } from 'react'
import { Check, Hash, Plus, Slash, Trash2, User, Users, X } from 'lucide-react'
import { api } from '../../api'
import { displayName, roleColorHex } from '../../lib/members'
import {
  ADD_REACTIONS,
  ATTACH_FILES,
  EMBED_LINKS,
  MANAGE_CHANNELS,
  MANAGE_MESSAGES,
  MENTION_EVERYONE,
  READ_MESSAGE_HISTORY,
  SEND_MESSAGES,
  VIEW_CHANNEL,
} from '../../lib/permissions'
import type { Channel, ChannelOverwrite, Guild, Member, Role } from '../../types'

interface ChannelSettingsModalProps {
  isOpen: boolean
  guild: Guild | null
  channel: Channel | null
  onClose: () => void
  onChannelUpdated?: () => void
  onChannelDeleted?: (channelId: string) => void
}

interface OverwriteDef {
  targetId: string
  targetType: 0 | 1 // 0 = role, 1 = member
  name: string
  color?: string | null
  isEveryone?: boolean
}

const CHANNEL_PERMS = [
  { flag: VIEW_CHANNEL, name: 'View Channel', description: 'Allows members to view this channel (and see message history if permitted).' },
  { flag: SEND_MESSAGES, name: 'Send Messages', description: 'Allows members to send messages in this text channel.' },
  { flag: ATTACH_FILES, name: 'Attach Files', description: 'Allows members to upload and share files or media in this channel.' },
  { flag: EMBED_LINKS, name: 'Embed Links', description: 'Links posted in this channel will display rich previews.' },
  { flag: ADD_REACTIONS, name: 'Add Reactions', description: 'Allows members to add new emoji reactions to messages.' },
  { flag: READ_MESSAGE_HISTORY, name: 'Read Message History', description: 'Allows members to read past messages sent in this channel.' },
  { flag: MENTION_EVERYONE, name: 'Mention @everyone', description: 'Allows members to trigger @everyone and @here notifications in this channel.' },
  { flag: MANAGE_MESSAGES, name: 'Manage Messages', description: 'Allows members to delete or pin messages by other users in this channel.' },
  { flag: MANAGE_CHANNELS, name: 'Manage Channel', description: 'Allows members to edit or delete this channel.' },
]

export function ChannelSettingsModal({
  isOpen,
  guild,
  channel,
  onClose,
  onChannelUpdated,
  onChannelDeleted,
}: ChannelSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'permissions'>('permissions')
  const [channelName, setChannelName] = useState('')
  const [savingChannel, setSavingChannel] = useState(false)

  // Roles, Members, Overwrites
  const [roles, setRoles] = useState<Role[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [overwrites, setOverwrites] = useState<ChannelOverwrite[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false)

  // Draft state for selected overwrite
  const [draftAllow, setDraftAllow] = useState<bigint>(0n)
  const [draftDeny, setDraftDeny] = useState<bigint>(0n)
  const [savingOverwrite, setSavingOverwrite] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Load channel data, roles, and members
  const loadData = async () => {
    if (!guild || !channel) return
    setChannelName(channel.name)
    try {
      const [rList, mList, owList] = await Promise.all([
        api.getRoles(guild.id),
        api.getMembers(guild.id),
        api.getChannelOverwrites(channel.id),
      ])
      setRoles(rList)
      setMembers(mList)
      setOverwrites(owList)
      setSelectedTargetId(guild.id) // default to @everyone
    } catch (err: any) {
      console.error('Failed to load channel permissions data:', err)
      setError(err.message || 'Failed to load permissions')
    }
  }

  useEffect(() => {
    if (isOpen && guild && channel) {
      loadData()
    }
  }, [isOpen, guild, channel])

  // Sync draft when selected target changes
  useEffect(() => {
    if (!selectedTargetId) return
    const curOw = overwrites.find((ow) => ow.target_id === selectedTargetId)
    if (curOw) {
      setDraftAllow(BigInt(curOw.allow || '0'))
      setDraftDeny(BigInt(curOw.deny || '0'))
    } else {
      setDraftAllow(0n)
      setDraftDeny(0n)
    }
    setError(null)
    setSuccess(null)
  }, [selectedTargetId, overwrites])

  if (!isOpen || !guild || !channel) return null

  // Active overwrite object
  const activeOverwrite = overwrites.find((ow) => ow.target_id === selectedTargetId) ?? null
  const originalAllow = activeOverwrite ? BigInt(activeOverwrite.allow || '0') : 0n
  const originalDeny = activeOverwrite ? BigInt(activeOverwrite.deny || '0') : 0n
  const hasChanges = draftAllow !== originalAllow || draftDeny !== originalDeny

  // Resolve target metadata for display
  const getTargetMeta = (targetId: string): OverwriteDef => {
    if (targetId === guild.id) {
      return { targetId, targetType: 0, name: '@everyone', isEveryone: true }
    }
    const role = roles.find((r) => r.id === targetId)
    if (role) {
      return { targetId, targetType: 0, name: role.name, color: roleColorHex(role.color) }
    }
    const member = members.find((m) => m.user.id === targetId)
    if (member) {
      return { targetId, targetType: 1, name: displayName(member) }
    }
    return { targetId, targetType: 0, name: `ID: ${targetId}` }
  }

  // Active targets list with @everyone always first
  const overwriteTargetIds = Array.from(new Set([guild.id, ...overwrites.map((o) => o.target_id)]))

  // Available roles/members to add (those without an overwrite yet)
  const availableRoles = roles.filter((r) => r.id !== guild.id && !overwrites.some((o) => o.target_id === r.id))
  const availableMembers = members.filter((m) => !overwrites.some((o) => o.target_id === m.user.id))

  const handleSelectPermState = (flag: bigint, state: 'allow' | 'neutral' | 'deny') => {
    if (state === 'allow') {
      setDraftAllow((prev) => prev | flag)
      setDraftDeny((prev) => prev & ~flag)
    } else if (state === 'deny') {
      setDraftDeny((prev) => prev | flag)
      setDraftAllow((prev) => prev & ~flag)
    } else {
      // Neutral
      setDraftAllow((prev) => prev & ~flag)
      setDraftDeny((prev) => prev & ~flag)
    }
  }

  const handleReset = () => {
    setDraftAllow(originalAllow)
    setDraftDeny(originalDeny)
    setError(null)
    setSuccess(null)
  }

  const handleSaveOverwrite = async () => {
    if (!selectedTargetId) return
    setSavingOverwrite(true)
    setError(null)
    setSuccess(null)

    const meta = getTargetMeta(selectedTargetId)
    try {
      await api.setChannelOverwrite(channel.id, selectedTargetId, {
        type: meta.targetType,
        allow: draftAllow.toString(),
        deny: draftDeny.toString(),
      })

      // Update local overwrites
      const next = overwrites.filter((ow) => ow.target_id !== selectedTargetId)
      next.push({
        channel_id: channel.id,
        target_id: selectedTargetId,
        type: meta.targetType,
        allow: draftAllow.toString(),
        deny: draftDeny.toString(),
      })
      setOverwrites(next)
      setSuccess(`Permissions for ${meta.name} saved!`)
      onChannelUpdated?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to save channel permissions')
    } finally {
      setSavingOverwrite(false)
    }
  }

  const handleDeleteOverwrite = async (targetId: string) => {
    if (targetId === guild.id) return // cannot delete @everyone overwrite
    setError(null)
    setSuccess(null)

    try {
      await api.deleteChannelOverwrite(channel.id, targetId)
      setOverwrites((prev) => prev.filter((o) => o.target_id !== targetId))
      if (selectedTargetId === targetId) {
        setSelectedTargetId(guild.id)
      }
      setSuccess('Overwrite removed!')
      onChannelUpdated?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to delete overwrite')
    }
  }

  const handleAddOverwrite = async (targetId: string, targetType: 0 | 1) => {
    setIsAddMenuOpen(false)
    setSelectedTargetId(targetId)
    // If not in overwrites list, save a default 0/0 overwrite immediately
    if (!overwrites.some((o) => o.target_id === targetId)) {
      try {
        await api.setChannelOverwrite(channel.id, targetId, {
          type: targetType,
          allow: '0',
          deny: '0',
        })
        setOverwrites((prev) => [
          ...prev,
          { channel_id: channel.id, target_id: targetId, type: targetType, allow: '0', deny: '0' },
        ])
        onChannelUpdated?.()
      } catch (err: any) {
        setError(err.message || 'Failed to add overwrite')
      }
    }
  }

  const handleSaveOverview = async () => {
    const trimmed = channelName.trim().toLowerCase().replace(/\s+/g, '-')
    if (!trimmed) return
    setSavingChannel(true)
    setError(null)
    setSuccess(null)
    try {
      await api.updateChannel(channel.id, { name: trimmed })
      setSuccess('Channel updated successfully!')
      onChannelUpdated?.()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to update channel')
    } finally {
      setSavingChannel(false)
    }
  }

  const handleDeleteChannel = async () => {
    if (!confirm(`Are you sure you want to delete #${channel.name}? This cannot be undone.`)) return
    try {
      await api.deleteChannel(channel.id)
      onClose()
      onChannelDeleted?.(channel.id)
      onChannelUpdated?.()
    } catch (err: any) {
      setError(err.message || 'Failed to delete channel')
    }
  }

  const currentMeta = selectedTargetId ? getTargetMeta(selectedTargetId) : null

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 920,
          maxWidth: '95vw',
          height: '80vh',
          maxHeight: 780,
          display: 'flex',
          flexDirection: 'row',
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: 'var(--bg-chat)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        }}
      >
        {/* Left Sidebar */}
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
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--text-header)',
              padding: '0 10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Hash size={16} /> #{channel.name}
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
              onClick={() => setActiveTab('permissions')}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'permissions' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'permissions' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'permissions' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Permissions
            </button>
          </div>

          <div style={{ marginTop: 'auto', padding: '0 10px' }}>
            <button
              type="button"
              onClick={handleDeleteChannel}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'none',
                border: 'none',
                color: '#ff7b72',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                padding: 0,
              }}
            >
              <Trash2 size={14} /> Delete Channel
            </button>
          </div>
        </div>

        {/* Right Content Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Top Bar with ESC */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 24px',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)' }}>
              {activeTab === 'overview' ? 'Channel Overview' : 'Channel Permissions'}
            </span>
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
            >
              ESC <X size={14} />
            </button>
          </div>

          {/* Feedback banners */}
          {error && (
            <div style={{ margin: '12px 24px 0', backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '8px 12px', borderRadius: 4, fontSize: 13 }}>
              {error}
            </div>
          )}
          {success && (
            <div style={{ margin: '12px 24px 0', backgroundColor: 'rgba(35, 165, 90, 0.15)', border: '1px solid #23a55a', color: '#57f287', padding: '8px 12px', borderRadius: 4, fontSize: 13 }}>
              {success}
            </div>
          )}

          {/* Tab: Overview */}
          {activeTab === 'overview' && (
            <div style={{ padding: 24, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ maxWidth: 460 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                  Channel Name
                </label>
                <input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
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
                <button
                  type="button"
                  disabled={savingChannel || !channelName.trim()}
                  onClick={handleSaveOverview}
                  style={{
                    marginTop: 16,
                    padding: '8px 16px',
                    backgroundColor: 'var(--brand)',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: savingChannel ? 'not-allowed' : 'pointer',
                  }}
                >
                  {savingChannel ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* Tab: Permissions */}
          {activeTab === 'permissions' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
              {/* Overwrite Targets List */}
              <div
                style={{
                  width: 220,
                  backgroundColor: 'rgba(0,0,0,0.1)',
                  borderRight: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 12,
                  overflowY: 'auto',
                  position: 'relative',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    Roles / Members
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsAddMenuOpen((prev) => !prev)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                    }}
                    title="Add Role or Member Overwrite"
                  >
                    <Plus size={16} />
                  </button>
                </div>

                {/* Add Overwrite Dropdown Menu */}
                {isAddMenuOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 36,
                      left: 12,
                      right: 12,
                      backgroundColor: 'var(--bg-modal)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                      zIndex: 20,
                      maxHeight: 240,
                      overflowY: 'auto',
                      padding: 6,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '4px 8px', textTransform: 'uppercase' }}>
                      Roles
                    </div>
                    {availableRoles.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>No roles to add</div>
                    ) : (
                      availableRoles.map((r) => (
                        <div
                          key={r.id}
                          onClick={() => handleAddOverwrite(r.id, 0)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 13,
                            color: 'var(--text-normal)',
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: roleColorHex(r.color) || 'var(--text-muted)' }} />
                          {r.name}
                        </div>
                      ))
                    )}

                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '8px 8px 4px', textTransform: 'uppercase' }}>
                      Members
                    </div>
                    {availableMembers.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>No members to add</div>
                    ) : (
                      availableMembers.map((m) => (
                        <div
                          key={m.user.id}
                          onClick={() => handleAddOverwrite(m.user.id, 1)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 13,
                            color: 'var(--text-normal)',
                          }}
                        >
                          <User size={12} />
                          {displayName(m)}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Overwrite items list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {overwriteTargetIds.map((targetId) => {
                    const meta = getTargetMeta(targetId)
                    const isSelected = selectedTargetId === targetId
                    return (
                      <div
                        key={targetId}
                        onClick={() => {
                          setSelectedTargetId(targetId)
                          setIsAddMenuOpen(false)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '7px 10px',
                          borderRadius: 4,
                          backgroundColor: isSelected ? 'var(--bg-hover)' : 'transparent',
                          color: isSelected ? 'var(--text-header)' : 'var(--text-normal)',
                          fontWeight: isSelected ? 600 : 500,
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                          {meta.isEveryone ? (
                            <Users size={14} color="var(--text-muted)" />
                          ) : meta.targetType === 0 ? (
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                backgroundColor: meta.color || 'var(--text-muted)',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <User size={14} color="var(--text-muted)" />
                          )}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {meta.name}
                          </span>
                        </div>

                        {!meta.isEveryone && isSelected && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteOverwrite(targetId)
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              padding: 2,
                              display: 'flex',
                            }}
                            title="Remove Overwrite"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Right 3-State Permission Grid */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
                {currentMeta ? (
                  <>
                    <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-header)' }}>
                        Permissions for {currentMeta.name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        ✕ Deny (Red) &bull; / Inherit (Grey) &bull; ✓ Allow (Green)
                      </div>
                    </div>

                    <div style={{ flex: 1, padding: 24, overflowY: 'auto', paddingBottom: hasChanges ? 80 : 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {CHANNEL_PERMS.map((p) => {
                        const isAllow = (draftAllow & p.flag) === p.flag
                        const isDeny = (draftDeny & p.flag) === p.flag
                        const isNeutral = !isAllow && !isDeny

                        return (
                          <div
                            key={p.name}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '10px 14px',
                              backgroundColor: 'rgba(0,0,0,0.12)',
                              borderRadius: 6,
                              gap: 16,
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-header)' }}>
                                {p.name}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                {p.description}
                              </div>
                            </div>

                            {/* 3-State Segmented Control */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                backgroundColor: '#1e1f22',
                                borderRadius: 4,
                                border: '1px solid var(--border-subtle)',
                                overflow: 'hidden',
                              }}
                            >
                              {/* DENY (✕) */}
                              <button
                                type="button"
                                onClick={() => handleSelectPermState(p.flag, 'deny')}
                                style={{
                                  width: 32,
                                  height: 28,
                                  border: 'none',
                                  backgroundColor: isDeny ? '#da373c' : 'transparent',
                                  color: isDeny ? 'white' : 'var(--text-muted)',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'all 0.15s ease',
                                }}
                                title="Deny"
                              >
                                <X size={16} strokeWidth={isDeny ? 3 : 2} />
                              </button>

                              {/* NEUTRAL (/) */}
                              <button
                                type="button"
                                onClick={() => handleSelectPermState(p.flag, 'neutral')}
                                style={{
                                  width: 32,
                                  height: 28,
                                  border: 'none',
                                  borderLeft: '1px solid var(--border-subtle)',
                                  borderRight: '1px solid var(--border-subtle)',
                                  backgroundColor: isNeutral ? '#4e5058' : 'transparent',
                                  color: isNeutral ? 'white' : 'var(--text-muted)',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'all 0.15s ease',
                                }}
                                title="Neutral / Inherit"
                              >
                                <Slash size={14} strokeWidth={isNeutral ? 3 : 2} />
                              </button>

                              {/* ALLOW (✓) */}
                              <button
                                type="button"
                                onClick={() => handleSelectPermState(p.flag, 'allow')}
                                style={{
                                  width: 32,
                                  height: 28,
                                  border: 'none',
                                  backgroundColor: isAllow ? '#23a55a' : 'transparent',
                                  color: isAllow ? 'white' : 'var(--text-muted)',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'all 0.15s ease',
                                }}
                                title="Allow"
                              >
                                <Check size={16} strokeWidth={isAllow ? 3 : 2} />
                              </button>
                            </div>
                          </div>
                        )
                      })}
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
                            disabled={savingOverwrite}
                            onClick={handleSaveOverwrite}
                            style={{
                              padding: '8px 16px',
                              backgroundColor: '#23a55a',
                              color: 'white',
                              border: 'none',
                              borderRadius: 4,
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: savingOverwrite ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {savingOverwrite ? 'Saving…' : 'Save Changes'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 14, textAlign: 'center' }}>
                    Select a role or member on the left to edit its channel permissions.
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
