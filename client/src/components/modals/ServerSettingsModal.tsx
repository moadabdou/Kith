import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Crown,
  Image as ImageIcon,
  Plus,
  Search,
  Shield,
  ShieldAlert,
  Sliders,
  Smile,
  Sticker as StickerIcon,
  Trash2,
  Upload,
  UserX,
  Users,
  X,
} from 'lucide-react'
import { api } from '../../api'
import { displayName, hexToRoleColor, initialsOf, roleColorHex } from '../../lib/members'
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
import type { Guild, GuildEmoji, GuildSticker, Member, Role } from '../../types'

import { useAuth } from '../../context/useAuth'

interface ServerSettingsModalProps {
  isOpen: boolean
  guild: Guild | null
  userPermissions?: bigint | null
  callerHighestPosition?: number
  isOwner?: boolean
  onClose: () => void
  onRolesChanged?: () => void
  onGuildUpdated?: (guild: Guild) => void
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

function readFileAsResizedDataUrl(
  file: File,
  maxWidth: number,
  maxHeight: number,
  quality = 0.88
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        let width = img.width
        let height = img.height
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height)
          width = Math.max(1, Math.round(width * ratio))
          height = Math.max(1, Math.round(height * ratio))
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(reader.result as string)
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
        resolve(canvas.toDataURL(mime, quality))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

export function ServerSettingsModal({
  isOpen,
  guild,
  userPermissions,
  callerHighestPosition,
  isOwner,
  onClose,
  onRolesChanged,
  onGuildUpdated,
}: ServerSettingsModalProps) {
  const { user } = useAuth()
  const effectiveIsOwner = isOwner ?? Boolean(guild && user && guild.owner_id === user.id)
  const [internalPermissions, setInternalPermissions] = useState<bigint | null>(userPermissions ?? null)
  const [internalCallerPos, setInternalCallerPos] = useState<number>(
    callerHighestPosition ?? (effectiveIsOwner ? Infinity : 0)
  )

  const [activeTab, setActiveTab] = useState<'overview' | 'roles' | 'emojis' | 'stickers' | 'members'>('overview')

  // Overview draft state
  const [overviewName, setOverviewName] = useState(guild?.name ?? '')
  const [overviewIcon, setOverviewIcon] = useState<string>(guild?.icon ?? '')
  const [overviewBanner, setOverviewBanner] = useState<string>(guild?.banner ?? '')
  const [isSavingOverview, setIsSavingOverview] = useState(false)
  const iconFileInputRef = useRef<HTMLInputElement | null>(null)
  const bannerFileInputRef = useRef<HTMLInputElement | null>(null)

  // Members state
  const [members, setMembers] = useState<Member[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [kickingMember, setKickingMember] = useState<Member | null>(null)
  const [isKicking, setIsKicking] = useState(false)

  const [roles, setRoles] = useState<Role[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [roleSubTab, setRoleSubTab] = useState<'display' | 'permissions'>('display')

  // Selected role draft state
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<number>(0)
  const [draftHoist, setDraftHoist] = useState(false)
  const [draftMentionable, setDraftMentionable] = useState(false)
  const [draftPermissions, setDraftPermissions] = useState<bigint>(0n)

  // Emojis & Stickers state
  const [emojis, setEmojis] = useState<GuildEmoji[]>([])
  const [stickers, setStickers] = useState<GuildSticker[]>([])
  const [emojiName, setEmojiName] = useState('')
  const [emojiFile, setEmojiFile] = useState<File | null>(null)
  const [emojiPreview, setEmojiPreview] = useState<string | null>(null)
  const [stickerName, setStickerName] = useState('')
  const [stickerFile, setStickerFile] = useState<File | null>(null)
  const [stickerPreview, setStickerPreview] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  const [uploadingItem, setUploadingItem] = useState(false)

  const canManageGuild =
    effectiveIsOwner ||
    (internalPermissions != null &&
      (hasPermission(internalPermissions, ADMINISTRATOR) ||
        hasPermission(internalPermissions, MANAGE_GUILD)))

  const canKickMembers =
    effectiveIsOwner ||
    (internalPermissions != null &&
      (hasPermission(internalPermissions, ADMINISTRATOR) ||
        hasPermission(internalPermissions, KICK_MEMBERS)))

  // Sync overview state when guild changes
  useEffect(() => {
    if (guild) {
      setOverviewName(guild.name)
      setOverviewIcon(guild.icon ?? '')
      setOverviewBanner(guild.banner ?? '')
    }
  }, [guild?.id, guild?.name, guild?.icon, guild?.banner])

  const fetchMembers = useCallback(async () => {
    if (!guild) return
    setLoadingMembers(true)
    try {
      const data = await api.getMembers(guild.id)
      setMembers(data)
    } catch (err: any) {
      setError(err?.message || 'Failed to load members')
    } finally {
      setLoadingMembers(false)
    }
  }, [guild])

  const fetchEmojis = useCallback(async () => {
    if (!guild) return
    setLoadingItems(true)
    try {
      const data = await api.getGuildEmojis(guild.id)
      setEmojis(data)
    } catch (err: any) {
      setError(err?.message || 'Failed to load emojis')
    } finally {
      setLoadingItems(false)
    }
  }, [guild])

  const fetchStickers = useCallback(async () => {
    if (!guild) return
    setLoadingItems(true)
    try {
      const data = await api.getGuildStickers(guild.id)
      setStickers(data)
    } catch (err: any) {
      setError(err?.message || 'Failed to load stickers')
    } finally {
      setLoadingItems(false)
    }
  }, [guild])

  // Automatically fetch emojis, stickers, or members when respective tab is active
  useEffect(() => {
    if (!isOpen || !guild) return
    setError(null)
    setSuccess(null)
    if (activeTab === 'emojis') {
      fetchEmojis()
    } else if (activeTab === 'stickers') {
      fetchStickers()
    } else if (activeTab === 'members') {
      fetchMembers()
    }
  }, [isOpen, guild, activeTab, fetchEmojis, fetchStickers, fetchMembers])

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setSuccess(null)
    if (file.size > 8 * 1024 * 1024) {
      setError(`Icon file size (${(file.size / 1024 / 1024).toFixed(1)} MB) exceeds the 8 MB limit`)
      e.target.value = ''
      return
    }
    try {
      const dataUrl = await readFileAsResizedDataUrl(file, 512, 512, 0.9)
      setOverviewIcon(dataUrl)
    } catch {
      setError('Failed to process image file')
    }
    e.target.value = ''
  }

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setSuccess(null)
    if (file.size > 10 * 1024 * 1024) {
      setError(`Banner file size (${(file.size / 1024 / 1024).toFixed(1)} MB) exceeds the 10 MB limit`)
      e.target.value = ''
      return
    }
    try {
      const dataUrl = await readFileAsResizedDataUrl(file, 960, 540, 0.85)
      setOverviewBanner(dataUrl)
    } catch {
      setError('Failed to process banner image file')
    }
    e.target.value = ''
  }

  const hasOverviewChanges =
    Boolean(guild) &&
    (overviewName.trim() !== (guild?.name ?? '') ||
      overviewIcon !== (guild?.icon ?? '') ||
      overviewBanner !== (guild?.banner ?? ''))

  const handleResetOverview = () => {
    if (!guild) return
    setOverviewName(guild.name)
    setOverviewIcon(guild.icon ?? '')
    setOverviewBanner(guild.banner ?? '')
    setError(null)
    setSuccess(null)
  }

  const handleSaveOverview = async () => {
    if (!guild || !canManageGuild || !overviewName.trim()) return
    setIsSavingOverview(true)
    setError(null)
    setSuccess(null)
    try {
      const updated = await api.updateGuild(guild.id, {
        name: overviewName.trim(),
        icon: overviewIcon || null,
        banner: overviewBanner || null,
      })
      onGuildUpdated?.(updated)
      setSuccess('Server overview changes saved!')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err?.message || 'Failed to update server')
    } finally {
      setIsSavingOverview(false)
    }
  }

  const handleConfirmKick = async () => {
    if (!guild || !kickingMember) return
    setIsKicking(true)
    setError(null)
    try {
      await api.kickMember(guild.id, kickingMember.user.id)
      setMembers((prev) => prev.filter((m) => m.user.id !== kickingMember.user.id))
      setSuccess(`Kicked @${kickingMember.user.username} from the server`)
      setKickingMember(null)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: any) {
      setError(err?.message || 'Failed to kick member')
    } finally {
      setIsKicking(false)
    }
  }

  const handleEmojiFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setSuccess(null)
    if (file.size > 256 * 1024) {
      setError(`Emoji file size (${(file.size / 1024).toFixed(1)} KB) exceeds the 256 KB limit`)
      e.target.value = ''
      return
    }
    setEmojiFile(file)
    const baseName = file.name
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toLowerCase()
      .slice(0, 32)
    setEmojiName(baseName || 'custom_emoji')
    const reader = new FileReader()
    reader.onload = () => setEmojiPreview(reader.result as string)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleUploadEmoji = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!guild || !emojiFile || !emojiName.trim()) return
    setUploadingItem(true)
    setError(null)
    setSuccess(null)
    try {
      await api.uploadGuildEmoji(guild.id, emojiName.trim(), emojiFile)
      setEmojiName('')
      setEmojiFile(null)
      setEmojiPreview(null)
      setSuccess('Emoji uploaded successfully!')
      fetchEmojis()
    } catch (err: any) {
      setError(err?.message || 'Failed to upload emoji')
    } finally {
      setUploadingItem(false)
    }
  }

  const handleDeleteEmoji = async (emojiId: string) => {
    if (!guild) return
    try {
      await api.deleteGuildEmoji(guild.id, emojiId)
      setEmojis((prev) => prev.filter((e) => e.id !== emojiId))
      setSuccess('Emoji deleted')
    } catch (err: any) {
      setError(err?.message || 'Failed to delete emoji')
    }
  }

  const handleStickerFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setSuccess(null)
    if (file.size > 512 * 1024) {
      setError(`Sticker file size (${(file.size / 1024).toFixed(1)} KB) exceeds the 512 KB limit`)
      e.target.value = ''
      return
    }
    setStickerFile(file)
    const baseName = file.name
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_ -]/g, '')
      .trim()
      .slice(0, 30)
    setStickerName(baseName || 'custom sticker')
    const reader = new FileReader()
    reader.onload = () => setStickerPreview(reader.result as string)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleUploadSticker = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!guild || !stickerFile || !stickerName.trim()) return
    setUploadingItem(true)
    setError(null)
    setSuccess(null)
    try {
      await api.uploadGuildSticker(guild.id, stickerName.trim(), stickerFile)
      setStickerName('')
      setStickerFile(null)
      setStickerPreview(null)
      setSuccess('Sticker uploaded successfully!')
      fetchStickers()
    } catch (err: any) {
      setError(err?.message || 'Failed to upload sticker')
    } finally {
      setUploadingItem(false)
    }
  }

  const handleDeleteSticker = async (stickerId: string) => {
    if (!guild) return
    try {
      await api.deleteGuildSticker(guild.id, stickerId)
      setStickers((prev) => prev.filter((s) => s.id !== stickerId))
      setSuccess('Sticker deleted')
    } catch (err: any) {
      setError(err?.message || 'Failed to delete sticker')
    }
  }

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Fetch permissions and member info when opened
  useEffect(() => {
    if (!isOpen || !guild || !user) return

    let active = true

    if (effectiveIsOwner) {
      setInternalPermissions(ALL_PERMISSIONS)
      setInternalCallerPos(Infinity)
      api.getMembers(guild.id).then((list) => {
        if (active) setMembers(list)
      }).catch(console.error)
      return () => {
        active = false
      }
    }

    Promise.all([
      api.getMyPermissions(guild.id),
      api.getRoles(guild.id),
      api.getMembers(guild.id),
    ])
      .then(([permRes, rolesList, membersList]) => {
        if (!active) return
        setInternalPermissions(BigInt(permRes.permissions))
        setMembers(membersList)
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
                gap: 8,
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
              <Sliders size={16} /> Overview
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
            <button
              type="button"
              onClick={() => setActiveTab('members')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'members' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'members' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'members' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Users size={16} /> Members
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('emojis')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'emojis' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'emojis' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'emojis' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Smile size={16} /> Emoji
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stickers')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 4,
                border: 'none',
                background: activeTab === 'stickers' ? 'var(--bg-hover)' : 'transparent',
                color: activeTab === 'stickers' ? 'var(--text-header)' : 'var(--text-muted)',
                fontWeight: activeTab === 'stickers' ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <StickerIcon size={16} /> Stickers
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
                {activeTab === 'overview'
                  ? 'Server Overview'
                  : activeTab === 'roles'
                  ? 'Server Roles'
                  : activeTab === 'members'
                  ? 'Server Members'
                  : activeTab === 'emojis'
                  ? 'Server Emojis'
                  : 'Server Stickers'}
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
            <div style={{ padding: '24px 32px', overflowY: 'auto', flex: 1 }}>
              {error && (
                <div style={{ backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}
              {success && (
                <div style={{ backgroundColor: 'rgba(35, 165, 89, 0.15)', border: '1px solid #23a559', color: '#23a559', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
                  {success}
                </div>
              )}

              <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 28 }}>
                {/* Server Icon and Server Name section */}
                <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
                  {/* Icon Uploader */}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 8 }}>
                      Server Icon
                    </label>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                      <div
                        onClick={() => canManageGuild && iconFileInputRef.current?.click()}
                        style={{
                          width: 96,
                          height: 96,
                          borderRadius: '50%',
                          backgroundColor: 'rgba(255, 255, 255, 0.08)',
                          border: '2px dashed var(--border-subtle)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          cursor: canManageGuild ? 'pointer' : 'default',
                          position: 'relative',
                        }}
                        title={canManageGuild ? 'Click to upload server icon' : undefined}
                      >
                        {overviewIcon ? (
                          <img
                            src={overviewIcon}
                            alt="Server Icon"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-header)' }}>
                            {initialsOf(overviewName || guild.name)}
                          </div>
                        )}
                        {canManageGuild && (
                          <div
                            className="overview-upload-overlay"
                            style={{
                              position: 'absolute',
                              inset: 0,
                              backgroundColor: 'rgba(0,0,0,0.6)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              opacity: 0,
                              transition: 'opacity 0.15s ease',
                              color: '#ffffff',
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              gap: 2,
                            }}
                          >
                            <Upload size={18} />
                            Change
                          </div>
                        )}
                      </div>

                      <input
                        ref={iconFileInputRef}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleIconUpload}
                        disabled={!canManageGuild}
                      />

                      <div style={{ display: 'flex', gap: 6 }}>
                        {canManageGuild && (
                          <button
                            type="button"
                            onClick={() => iconFileInputRef.current?.click()}
                            style={{
                              padding: '5px 12px',
                              backgroundColor: '#ffffff',
                              color: '#000000',
                              border: 'none',
                              borderRadius: 4,
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Upload
                          </button>
                        )}
                        {canManageGuild && overviewIcon && (
                          <button
                            type="button"
                            onClick={() => setOverviewIcon('')}
                            style={{
                              padding: '5px 8px',
                              backgroundColor: 'transparent',
                              color: '#ff7b72',
                              border: '1px solid rgba(218, 55, 60, 0.3)',
                              borderRadius: 4,
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: 'pointer',
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Server Name Input */}
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 8 }}>
                      Server Name
                    </label>
                    <input
                      type="text"
                      value={overviewName}
                      onChange={(e) => setOverviewName(e.target.value)}
                      disabled={!canManageGuild}
                      maxLength={100}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        backgroundColor: 'rgba(0,0,0,0.25)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 4,
                        color: 'var(--text-header)',
                        fontSize: 15,
                        fontWeight: 500,
                        outline: 'none',
                      }}
                      placeholder="Enter server name..."
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                      Give your server a distinctive name so your friends recognize it.
                    </div>
                  </div>
                </div>

                {/* Server Banner Section */}
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 20 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                    Server Banner Background
                  </label>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                    This image displays at the top of your channel sidebar as the server header background.
                  </div>

                  <div
                    style={{
                      width: '100%',
                      maxWidth: 480,
                      height: 160,
                      borderRadius: 8,
                      overflow: 'hidden',
                      position: 'relative',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {overviewBanner ? (
                      <>
                        <img
                          src={overviewBanner}
                          alt="Server Banner Preview"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.7) 100%)',
                            pointerEvents: 'none',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 12,
                            left: 14,
                            color: '#ffffff',
                            fontWeight: 700,
                            fontSize: 14,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          {overviewIcon ? (
                            <img
                              src={overviewIcon}
                              alt=""
                              style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover' }}
                            />
                          ) : null}
                          {overviewName || guild.name}
                        </div>
                      </>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
                        <ImageIcon size={32} opacity={0.6} />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>No banner set</span>
                      </div>
                    )}
                  </div>

                  <input
                    ref={bannerFileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleBannerUpload}
                    disabled={!canManageGuild}
                  />

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                    {canManageGuild && (
                      <button
                        type="button"
                        onClick={() => bannerFileInputRef.current?.click()}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '7px 14px',
                          backgroundColor: '#ffffff',
                          color: '#000000',
                          border: 'none',
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        <Upload size={14} color="#000000" /> Upload Banner
                      </button>
                    )}
                    {canManageGuild && overviewBanner && (
                      <button
                        type="button"
                        onClick={() => setOverviewBanner('')}
                        style={{
                          padding: '7px 12px',
                          backgroundColor: 'transparent',
                          color: '#ff7b72',
                          border: '1px solid rgba(218, 55, 60, 0.3)',
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                        }}
                      >
                        Remove Banner
                      </button>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      16:9 ratio recommended (max 4 MB)
                    </span>
                  </div>
                </div>

                {/* Server Metadata */}
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 20, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Server ID
                    </label>
                    <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text-normal)', marginTop: 4 }}>
                      {guild.id}
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Server Owner
                    </label>
                    <div style={{ fontSize: 13, color: 'var(--text-normal)', marginTop: 4 }}>
                      {effectiveIsOwner ? 'You (Owner)' : `Owner ID: ${guild.owner_id}`}
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Members
                    </label>
                    <div style={{ fontSize: 13, color: 'var(--text-normal)', marginTop: 4 }}>
                      {members.length} total members
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                      Roles
                    </label>
                    <div style={{ fontSize: 13, color: 'var(--text-normal)', marginTop: 4 }}>
                      {roles.length} configured roles
                    </div>
                  </div>
                </div>

                {/* Unsaved changes bar */}
                {hasOverviewChanges && (
                  <div
                    style={{
                      position: 'sticky',
                      bottom: 0,
                      backgroundColor: 'rgba(17, 18, 20, 0.95)',
                      backdropFilter: 'blur(10px)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 6,
                      padding: '12px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                      marginTop: 8,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                      Careful — you have unsaved changes!
                    </span>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        type="button"
                        onClick={handleResetOverview}
                        disabled={isSavingOverview}
                        style={{
                          padding: '7px 14px',
                          backgroundColor: 'transparent',
                          color: 'var(--text-header)',
                          border: 'none',
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                        }}
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveOverview}
                        disabled={isSavingOverview || !overviewName.trim()}
                        style={{
                          padding: '7px 16px',
                          backgroundColor: '#23a559',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: isSavingOverview ? 'not-allowed' : 'pointer',
                          opacity: isSavingOverview ? 0.7 : 1,
                        }}
                      >
                        {isSavingOverview ? 'Saving...' : 'Save Changes'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab: Members */}
          {activeTab === 'members' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Members Header / Search Bar */}
              <div
                style={{
                  padding: '16px 24px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                }}
              >
                <div style={{ position: 'relative', width: 280 }}>
                  <Search
                    size={16}
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--text-muted)',
                    }}
                  />
                  <input
                    type="text"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="Search members..."
                    style={{
                      width: '100%',
                      padding: '7px 12px 7px 34px',
                      backgroundColor: 'rgba(0,0,0,0.2)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 4,
                      color: 'var(--text-header)',
                      fontSize: 13,
                      outline: 'none',
                    }}
                  />
                </div>

                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
                  {members.filter((m) => {
                    const q = memberSearch.trim().toLowerCase()
                    if (!q) return true
                    return (
                      m.user.username.toLowerCase().includes(q) ||
                      (m.nick && m.nick.toLowerCase().includes(q))
                    )
                  }).length}{' '}
                  Members
                </div>
              </div>

              {error && (
                <div style={{ margin: '12px 24px 0', backgroundColor: 'rgba(218, 55, 60, 0.15)', border: '1px solid var(--danger)', color: '#ff7b72', padding: '10px 14px', borderRadius: 6, fontSize: 13 }}>
                  {error}
                </div>
              )}
              {success && (
                <div style={{ margin: '12px 24px 0', backgroundColor: 'rgba(35, 165, 89, 0.15)', border: '1px solid #23a559', color: '#23a559', padding: '10px 14px', borderRadius: 6, fontSize: 13 }}>
                  {success}
                </div>
              )}

              {/* Members Scroll List */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
                {loadingMembers ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                    Loading members...
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {members
                      .filter((m) => {
                        const q = memberSearch.trim().toLowerCase()
                        if (!q) return true
                        return (
                          m.user.username.toLowerCase().includes(q) ||
                          (m.nick && m.nick.toLowerCase().includes(q))
                        )
                      })
                      .map((member) => {
                        const isOwnerMember = member.user.id === guild.owner_id
                        const isSelf = member.user.id === user?.id
                        const name = displayName(member)
                        const targetHighest = Math.max(
                          0,
                          ...member.roles.map((rId) => roles.find((r) => r.id === rId)?.position ?? 0)
                        )
                        const canKickThisMember =
                          canKickMembers &&
                          !isOwnerMember &&
                          !isSelf &&
                          (effectiveIsOwner || effectiveCallerHighestPos > targetHighest)

                        return (
                          <div
                            key={member.user.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '10px 14px',
                              borderRadius: 6,
                              backgroundColor: 'rgba(255, 255, 255, 0.02)',
                              border: '1px solid rgba(255, 255, 255, 0.04)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 200 }}>
                              <div
                                style={{
                                  width: 36,
                                  height: 36,
                                  borderRadius: '50%',
                                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: 14,
                                  fontWeight: 600,
                                  color: 'var(--text-header)',
                                  flexShrink: 0,
                                }}
                              >
                                {initialsOf(name)}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                                    {name}
                                  </span>
                                  {isOwnerMember && (
                                    <span
                                      title="Server Owner"
                                      style={{ display: 'flex', alignItems: 'center', color: '#f1c40f' }}
                                    >
                                      <Crown size={14} />
                                    </span>
                                  )}
                                </div>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                  @{member.user.username}#{member.user.discriminator}
                                </span>
                              </div>
                            </div>

                            {/* Roles badges */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, margin: '0 16px' }}>
                              {member.roles
                                .filter((rId) => rId !== guild.id)
                                .map((rId) => {
                                  const role = roles.find((r) => r.id === rId)
                                  if (!role) return null
                                  const hex = roleColorHex(role.color) || '#99aab5'
                                  return (
                                    <span
                                      key={role.id}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 5,
                                        padding: '2px 8px',
                                        borderRadius: 4,
                                        backgroundColor: 'rgba(255, 255, 255, 0.06)',
                                        border: '1px solid rgba(255, 255, 255, 0.08)',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        color: hex,
                                      }}
                                    >
                                      <span
                                        style={{
                                          width: 7,
                                          height: 7,
                                          borderRadius: '50%',
                                          backgroundColor: hex,
                                        }}
                                      />
                                      {role.name}
                                    </span>
                                  )
                                })}
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {canKickThisMember ? (
                                <button
                                  type="button"
                                  onClick={() => setKickingMember(member)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    padding: '6px 12px',
                                    backgroundColor: 'rgba(218, 55, 60, 0.12)',
                                    color: '#ff7b72',
                                    border: '1px solid rgba(218, 55, 60, 0.25)',
                                    borderRadius: 4,
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                  }}
                                  title={`Kick ${name} from ${guild.name}`}
                                >
                                  <UserX size={14} /> Kick
                                </button>
                              ) : isOwnerMember ? (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, padding: '4px 8px' }}>
                                  Owner
                                </span>
                              ) : isSelf ? (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, padding: '4px 8px' }}>
                                  You
                                </span>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>

              {/* Kick Confirmation Dialog */}
              {kickingMember && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    backdropFilter: 'blur(4px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 100,
                  }}
                  onClick={() => !isKicking && setKickingMember(null)}
                >
                  <div
                    style={{
                      width: 440,
                      maxWidth: '90%',
                      backgroundColor: 'var(--bg-chat)',
                      borderRadius: 8,
                      border: '1px solid var(--border-subtle)',
                      boxShadow: '0 16px 40px rgba(0,0,0,0.8)',
                      padding: 24,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)', marginBottom: 8 }}>
                      Kick '{displayName(kickingMember)}' from {guild.name}?
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 20 }}>
                      Are you sure you want to kick <strong>{displayName(kickingMember)}</strong> (@{kickingMember.user.username}#{kickingMember.user.discriminator})? They will be able to rejoin with a new invite link.
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                      <button
                        type="button"
                        onClick={() => setKickingMember(null)}
                        disabled={isKicking}
                        style={{
                          padding: '8px 16px',
                          backgroundColor: 'transparent',
                          color: 'var(--text-header)',
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
                        onClick={handleConfirmKick}
                        disabled={isKicking}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 18px',
                          backgroundColor: 'var(--danger, #da373c)',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 4,
                          fontSize: 14,
                          fontWeight: 600,
                          cursor: isKicking ? 'not-allowed' : 'pointer',
                          opacity: isKicking ? 0.7 : 1,
                        }}
                      >
                        <UserX size={15} />
                        {isKicking ? 'Kicking...' : 'Kick'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
                    backgroundColor: canCreateRole ? '#ffffff' : 'rgba(255,255,255,0.05)',
                    color: canCreateRole ? '#000000' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: canCreateRole ? 'pointer' : 'not-allowed',
                    marginBottom: 12,
                  }}
                  title={!canCreateRole ? 'You do not have permission to manage roles' : undefined}
                >
                  <Plus size={16} color={canCreateRole ? '#000000' : 'var(--text-muted)'} /> Create Role
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
                                  value={selectedColorHex || '#ffffff'}
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

          {/* Tab: Emojis */}
          {activeTab === 'emojis' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-header)', marginBottom: 6 }}>
                  Emoji Management
                </h3>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 640 }}>
                  Upload custom emojis for your server. Members of this server can use them anywhere across Kith
                  with the <code>USE_EXTERNAL_EMOJIS</code> permission. Slots: {emojis.length} / 50.
                </p>
              </div>

              {error && (
                <div
                  style={{
                    backgroundColor: 'rgba(218, 55, 60, 0.15)',
                    border: '1px solid var(--danger)',
                    color: '#ff7b72',
                    padding: '10px 14px',
                    borderRadius: 6,
                    fontSize: 13,
                    maxWidth: 640,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#ff7b72',
                      cursor: 'pointer',
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              {success && (
                <div
                  style={{
                    backgroundColor: 'rgba(35, 165, 90, 0.15)',
                    border: '1px solid #23a55a',
                    color: '#57f287',
                    padding: '10px 14px',
                    borderRadius: 6,
                    fontSize: 13,
                    maxWidth: 640,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>{success}</span>
                  <button
                    type="button"
                    onClick={() => setSuccess(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#57f287',
                      cursor: 'pointer',
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {canManageGuild ? (
                <form
                  onSubmit={handleUploadEmoji}
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    maxWidth: 640,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                    Upload New Emoji
                  </div>

                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 8,
                        border: '2px dashed var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'var(--bg-chat)',
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      {emojiPreview ? (
                        <img src={emojiPreview} alt="Preview" style={{ width: 44, height: 44, objectFit: 'contain' }} />
                      ) : (
                        <Smile size={28} style={{ color: 'var(--text-muted)' }} />
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                      <input
                        type="file"
                        id="emoji-file-input"
                        accept=".png,.jpg,.jpeg,.gif,.webp"
                        onChange={handleEmojiFileChange}
                        style={{ display: 'none' }}
                      />
                      <label
                        htmlFor="emoji-file-input"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 14px',
                          backgroundColor: '#ffffff',
                          color: '#000000',
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                          width: 'fit-content',
                        }}
                      >
                        <Upload size={14} color="#000000" /> Choose Image
                      </label>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Recommended size 128x128. Max 256 KB. Supported formats: PNG, JPG, GIF, WebP.
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                      <label
                        htmlFor="emoji-name-input"
                        style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}
                      >
                        Emoji Name
                      </label>
                      <input
                        id="emoji-name-input"
                        type="text"
                        value={emojiName}
                        onChange={(e) => setEmojiName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                        placeholder="e.g. pepe_happy"
                        maxLength={32}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          backgroundColor: 'var(--bg-chat)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 4,
                          color: 'var(--text-normal)',
                          fontSize: 14,
                        }}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={uploadingItem || !emojiFile || !emojiName.trim() || emojiName.trim().length < 2}
                      style={{
                        alignSelf: 'flex-end',
                        padding: '8px 18px',
                        backgroundColor: '#23a55a',
                        color: 'white',
                        border: 'none',
                        borderRadius: 4,
                        fontWeight: 600,
                        fontSize: 13,
                        cursor:
                          uploadingItem || !emojiFile || !emojiName.trim() || emojiName.trim().length < 2
                            ? 'not-allowed'
                            : 'pointer',
                        opacity:
                          uploadingItem || !emojiFile || !emojiName.trim() || emojiName.trim().length < 2 ? 0.5 : 1,
                      }}
                    >
                      {uploadingItem ? 'Uploading…' : 'Upload'}
                    </button>
                  </div>
                </form>
              ) : (
                <div
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '12px 16px',
                    fontSize: 13,
                    color: 'var(--text-muted)',
                  }}
                >
                  You need the <strong>Manage Server</strong> permission to upload or delete emojis.
                </div>
              )}

              {/* Emoji List Grid */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Uploaded Emojis ({emojis.length})
                </div>

                {loadingItems ? (
                  <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading emojis…</div>
                ) : emojis.length === 0 ? (
                  <div
                    style={{
                      padding: 32,
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: 8,
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 14,
                    }}
                  >
                    No custom emojis uploaded yet.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {emojis.map((emoji) => (
                      <div
                        key={emoji.id}
                        style={{
                          backgroundColor: 'var(--bg-secondary)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 6,
                          padding: '10px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          justifyContent: 'space-between',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                          <img
                            src={emoji.url || `/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`}
                            alt={emoji.name}
                            style={{ width: 36, height: 36, objectFit: 'contain', flexShrink: 0 }}
                          />
                          <div style={{ overflow: 'hidden' }}>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: 'var(--text-header)',
                                textOverflow: 'ellipsis',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                              }}
                              title={`:${emoji.name}:`}
                            >
                              :{emoji.name}:
                            </div>
                            {emoji.animated && (
                              <span style={{ fontSize: 10, color: 'var(--brand)', fontWeight: 700 }}>ANIMATED</span>
                            )}
                          </div>
                        </div>
                        {canManageGuild && (
                          <button
                            type="button"
                            onClick={() => handleDeleteEmoji(emoji.id)}
                            title="Delete Emoji"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              padding: 4,
                              borderRadius: 4,
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = '#da373c')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab: Stickers */}
          {activeTab === 'stickers' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-header)', marginBottom: 6 }}>
                  Sticker Management
                </h3>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 640 }}>
                  Upload custom stickers for your server. Members of this server can send them in chat across Kith.
                  Slots: {stickers.length} / 50.
                </p>
              </div>

              {error && (
                <div
                  style={{
                    backgroundColor: 'rgba(218, 55, 60, 0.15)',
                    border: '1px solid var(--danger)',
                    color: '#ff7b72',
                    padding: '10px 14px',
                    borderRadius: 6,
                    fontSize: 13,
                    maxWidth: 640,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#ff7b72',
                      cursor: 'pointer',
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              {success && (
                <div
                  style={{
                    backgroundColor: 'rgba(35, 165, 90, 0.15)',
                    border: '1px solid #23a55a',
                    color: '#57f287',
                    padding: '10px 14px',
                    borderRadius: 6,
                    fontSize: 13,
                    maxWidth: 640,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>{success}</span>
                  <button
                    type="button"
                    onClick={() => setSuccess(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#57f287',
                      cursor: 'pointer',
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {canManageGuild ? (
                <form
                  onSubmit={handleUploadSticker}
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    maxWidth: 640,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                    Upload New Sticker
                  </div>

                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div
                      style={{
                        width: 80,
                        height: 80,
                        borderRadius: 8,
                        border: '2px dashed var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'var(--bg-chat)',
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      {stickerPreview ? (
                        <img src={stickerPreview} alt="Preview" style={{ width: 64, height: 64, objectFit: 'contain' }} />
                      ) : (
                        <StickerIcon size={32} style={{ color: 'var(--text-muted)' }} />
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                      <input
                        type="file"
                        id="sticker-file-input"
                        accept=".png,.webp"
                        onChange={handleStickerFileChange}
                        style={{ display: 'none' }}
                      />
                      <label
                        htmlFor="sticker-file-input"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 14px',
                          backgroundColor: '#ffffff',
                          color: '#000000',
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                          width: 'fit-content',
                        }}
                      >
                        <Upload size={14} color="#000000" /> Choose Image
                      </label>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Recommended size 320x320. Max 512 KB. Supported formats: PNG, WebP.
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ flex: 1 }}>
                      <label
                        htmlFor="sticker-name-input"
                        style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}
                      >
                        Sticker Name
                      </label>
                      <input
                        id="sticker-name-input"
                        type="text"
                        value={stickerName}
                        onChange={(e) => setStickerName(e.target.value)}
                        placeholder="e.g. dancing cat"
                        maxLength={30}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          backgroundColor: 'var(--bg-chat)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 4,
                          color: 'var(--text-normal)',
                          fontSize: 14,
                        }}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={uploadingItem || !stickerFile || !stickerName.trim() || stickerName.trim().length < 2}
                      style={{
                        alignSelf: 'flex-end',
                        padding: '8px 18px',
                        backgroundColor: '#23a55a',
                        color: 'white',
                        border: 'none',
                        borderRadius: 4,
                        fontWeight: 600,
                        fontSize: 13,
                        cursor:
                          uploadingItem || !stickerFile || !stickerName.trim() || stickerName.trim().length < 2
                            ? 'not-allowed'
                            : 'pointer',
                        opacity:
                          uploadingItem || !stickerFile || !stickerName.trim() || stickerName.trim().length < 2 ? 0.5 : 1,
                      }}
                    >
                      {uploadingItem ? 'Uploading…' : 'Upload'}
                    </button>
                  </div>
                </form>
              ) : (
                <div
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '12px 16px',
                    fontSize: 13,
                    color: 'var(--text-muted)',
                  }}
                >
                  You need the <strong>Manage Server</strong> permission to upload or delete stickers.
                </div>
              )}

              {/* Stickers List Grid */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Uploaded Stickers ({stickers.length})
                </div>

                {loadingItems ? (
                  <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading stickers…</div>
                ) : stickers.length === 0 ? (
                  <div
                    style={{
                      padding: 32,
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: 8,
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 14,
                    }}
                  >
                    No custom stickers uploaded yet.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 16,
                    }}
                  >
                    {stickers.map((sticker) => (
                      <div
                        key={sticker.id}
                        style={{
                          backgroundColor: 'var(--bg-secondary)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 8,
                          padding: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 10,
                          position: 'relative',
                        }}
                      >
                        <img
                          src={sticker.url || `/stickers/${sticker.id}.png`}
                          alt={sticker.name}
                          style={{ width: 80, height: 80, objectFit: 'contain' }}
                        />
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--text-header)',
                            textAlign: 'center',
                            width: '100%',
                            textOverflow: 'ellipsis',
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                          }}
                          title={sticker.name}
                        >
                          {sticker.name}
                        </div>
                        {canManageGuild && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSticker(sticker.id)}
                            title="Delete Sticker"
                            style={{
                              position: 'absolute',
                              top: 8,
                              right: 8,
                              background: 'rgba(0,0,0,0.4)',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              padding: 4,
                              borderRadius: 4,
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = '#da373c')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
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
