import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import { AlertCircle, ArrowDown, Hash, Loader2, Pin } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useGateway } from '../../gateway/useGateway'
import { memberNameColor } from '../../lib/members'
import { ADD_REACTIONS, ATTACH_FILES, hasPermission, MANAGE_MESSAGES, MENTION_EVERYONE, resolveChannelPermissions, SEND_MESSAGES } from '../../lib/permissions'
import { applyMessageUpdate } from '../../lib/message-updates'
import { applyReactionAdd, applyReactionRemove, toggleReactionOptimistic } from '../../lib/reactions'
import { parseSearchQuery } from '../../lib/search'
import { MarkdownView } from '../../lib/markdown'
import { isMessageMentioningUser } from '../../lib/mentions'
import { findLastEditableMessage, shouldGroupConsecutiveMessage } from '../../lib/message-grouping'
import {
  MAX_PENDING_FILES,
  nextUploadKey,
  runPendingUpload,
  validateFile,
  type PendingUpload,
} from '../../lib/uploads'
import { remainingMs, removeTyper, typingDisplayName, typingIndicatorText } from '../../lib/typing'
import type { Channel, Guild, GuildEmoji, GuildSticker, Member, Message, Role, SearchFilters } from '../../types'
import { SearchBar } from '../search/SearchBar'
import { SearchResults } from '../search/SearchResults'
import { AttachmentView } from './AttachmentView'
import { ChatGifEmbed } from './ChatGifEmbed'
import { extractGifUrls, stripGifUrls } from '../../lib/gifs'
import { DeleteMessageModal } from './DeleteMessageModal'
import { MessageInput } from './MessageInput'
import { MessageToolbar } from './MessageToolbar'
import { ParentQuote } from './ParentQuote'
import { PinnedMessagesDrawer } from './PinnedMessagesDrawer'
import { ReactionPicker, type ServerEmojiGroup, type ServerStickerGroup } from './ReactionPicker'
import { ReactionPills } from './ReactionPills'
import { WelcomeHero } from './WelcomeHero'
import { ChatEmptyState } from './ChatEmptyState'

interface ChatAreaProps {
  currentGuild: Guild | null
  currentChannel: Channel | null
  channels?: Channel[]
  guilds?: Guild[]
  onSelectChannel?: (id: string) => void
  onSelectGuild?: (id: string) => void
  onOpenCreateGuildModal?: () => void
  // Pending jump-to-mention request from a sidebar badge click (Issue #122).
  // Consumed (via onMentionJumpConsumed) once handed to the channel-switch
  // loader, which jumps after history arrives.
  mentionJump?: { channelId: string; messageId: string } | null
  onMentionJumpConsumed?: () => void
}

interface ActiveTyper {
  channelId: string
  name: string
  expiresAt: number
}

export function ChatArea({
  currentGuild,
  currentChannel,
  channels = [],
  guilds = [],
  onSelectChannel,
  onSelectGuild,
  onOpenCreateGuildModal,
  mentionJump,
  onMentionJumpConsumed,
}: ChatAreaProps) {
  const { user } = useAuth()
  const {
    subscribeToMessages,
    subscribeToMessageUpdates,
    subscribeToMessageDeletes,
    subscribeToTyping,
    sendTyping,
    resetTypingThrottle,
    connected,
    onSessionReset,
    subscribeToRoleCreates,
    subscribeToRoleUpdates,
    subscribeToRoleDeletes,
    subscribeToMemberUpdates,
    subscribeToMessageReactionAdd,
    subscribeToMessageReactionRemove,
    subscribeToChannelPinsUpdate,
    subscribeToGuildEmojisUpdate,
    subscribeToGuildStickersUpdate,
  } = useGateway()
  const [messages, setMessages] = useState<Message[]>([])
  // Latest-state mirror so event callbacks can snapshot without stale closures.
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typers, setTypers] = useState<Map<string, ActiveTyper>>(new Map())
  const [activePicker, setActivePicker] = useState<{
    messageId: string
    position: { top?: number; bottom?: number; right?: number }
  } | null>(null)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)

  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  const [deletingMessage, setDeletingMessage] = useState<Message | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleStartReply = useCallback((targetMsg: Message) => {
    setReplyingTo(targetMsg)
    chatInputRef.current?.focus()
  }, [])

  // Pagination & Bi-directional Scroll State
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [loadingNewer, setLoadingNewer] = useState(false)
  const [isViewingHistory, setIsViewingHistory] = useState(false)
  const isViewingHistoryRef = useRef(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesInnerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isLoadingOlderRef = useRef(false)
  const isLoadingNewerRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const userJustSentRef = useRef(0)
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null)

  // Search State & Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Message[]>([])
  const [isPinsOpen, setIsPinsOpen] = useState(false)
  const [totalSearchResults, setTotalSearchResults] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [searchPage, setSearchPage] = useState(1)
  const [isSearchDrawerOpen, setIsSearchDrawerOpen] = useState(false)
  const [selectedChannelId, setSelectedChannelId] = useState<string>('')
  const [selectedAuthorId, setSelectedAuthorId] = useState<string>('')
  const [guildMembers, setGuildMembers] = useState<Member[]>([])
  const [guildRoles, setGuildRoles] = useState<Role[]>([])
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null)

  const [customEmojiGroups, setCustomEmojiGroups] = useState<ServerEmojiGroup[]>([])
  const [customStickerGroups, setCustomStickerGroups] = useState<ServerStickerGroup[]>([])

  useEffect(() => {
    if (!guilds || guilds.length === 0) {
      setCustomEmojiGroups([])
      setCustomStickerGroups([])
      return
    }

    let isCancelled = false

    Promise.allSettled(
      guilds.map(async (g) => {
        const [emojis, stickers] = await Promise.all([
          api.getGuildEmojis(g.id).catch(() => [] as GuildEmoji[]),
          api.getGuildStickers(g.id).catch(() => [] as GuildSticker[]),
        ])
        return { guild: g, emojis, stickers }
      })
    ).then((results) => {
      if (isCancelled) return
      const emojiGroups: ServerEmojiGroup[] = []
      const stickerGroups: ServerStickerGroup[] = []

      for (const res of results) {
        if (res.status === 'fulfilled') {
          const { guild, emojis, stickers } = res.value
          if (emojis && emojis.length > 0) {
            emojiGroups.push({
              guildId: guild.id,
              guildName: guild.name,
              guildIcon: guild.icon,
              emojis,
            })
          }
          if (stickers && stickers.length > 0) {
            stickerGroups.push({
              guildId: guild.id,
              guildName: guild.name,
              guildIcon: guild.icon,
              stickers,
            })
          }
        }
      }

      setCustomEmojiGroups(emojiGroups)
      setCustomStickerGroups(stickerGroups)
    })

    return () => {
      isCancelled = true
    }
  }, [guilds])

  useEffect(() => {
    const unsubEmoji = subscribeToGuildEmojisUpdate((payload) => {
      setCustomEmojiGroups((prev) => {
        const exists = prev.some((g) => g.guildId === payload.guild_id)
        if (!exists) {
          const guild = guilds.find((g) => g.id === payload.guild_id)
          if (!guild || payload.emojis.length === 0) return prev
          return [
            ...prev,
            {
              guildId: guild.id,
              guildName: guild.name,
              guildIcon: guild.icon,
              emojis: payload.emojis,
            },
          ]
        }
        if (payload.emojis.length === 0) {
          return prev.filter((g) => g.guildId !== payload.guild_id)
        }
        return prev.map((g) =>
          g.guildId === payload.guild_id ? { ...g, emojis: payload.emojis } : g
        )
      })
    })

    const unsubSticker = subscribeToGuildStickersUpdate((payload) => {
      setCustomStickerGroups((prev) => {
        const exists = prev.some((g) => g.guildId === payload.guild_id)
        if (!exists) {
          const guild = guilds.find((g) => g.id === payload.guild_id)
          if (!guild || payload.stickers.length === 0) return prev
          return [
            ...prev,
            {
              guildId: guild.id,
              guildName: guild.name,
              guildIcon: guild.icon,
              stickers: payload.stickers,
            },
          ]
        }
        if (payload.stickers.length === 0) {
          return prev.filter((g) => g.guildId !== payload.guild_id)
        }
        return prev.map((g) =>
          g.guildId === payload.guild_id ? { ...g, stickers: payload.stickers } : g
        )
      })
    })

    return () => {
      unsubEmoji()
      unsubSticker()
    }
  }, [subscribeToGuildEmojisUpdate, subscribeToGuildStickersUpdate, guilds])

  // Resolve channel-scoped permissions for the current user (null = unknown).
  // Declared before the upload logic: addFiles gates on canAttach.
  const channelPerms = useMemo<bigint | 'owner' | null>(() => {
    if (!currentGuild || !currentChannel || !user) return null
    // 1. Guild owner bypass
    if (currentGuild.owner_id === user.id) return 'owner'

    // 2. Identify member's assigned roles (plus @everyone role where id === guildId)
    const currentMember = guildMembers.find((m) => m.user.id === user.id)
    const assignedRoleIds = new Set(currentMember?.roles ?? [])

    const memberRoles = guildRoles.filter(
      (r) => r.id === currentGuild.id || assignedRoleIds.has(r.id)
    )

    return resolveChannelPermissions(
      currentGuild.id,
      currentGuild.owner_id,
      user.id,
      memberRoles,
      currentChannel.permission_overwrites ?? []
    )
  }, [currentGuild, currentChannel, user, guildMembers, guildRoles])

  const canSendMessages =
    channelPerms === 'owner' || (channelPerms != null && hasPermission(channelPerms, SEND_MESSAGES))
  const canAttach =
    canSendMessages &&
    (channelPerms === 'owner' || (channelPerms != null && hasPermission(channelPerms, ATTACH_FILES)))
  const canAddReactions =
    channelPerms === 'owner' || (channelPerms != null && hasPermission(channelPerms, ADD_REACTIONS))
  const canManageMessages =
    channelPerms === 'owner' || (channelPerms != null && hasPermission(channelPerms, MANAGE_MESSAGES))

  // Mention autocomplete data (Issue #123): guild members/roles shaped for
  // the composer, plus the broadcast gate mirroring the server's validation.
  const mentionMembers = useMemo(
    () =>
      guildMembers.map((m) => ({
        id: m.user.id,
        username: m.user.username,
        nick: m.nick,
        avatar: m.user.avatar ?? (user && m.user.id === user.id ? user.avatar : null),
      })),
    [guildMembers, user],
  )
  const mentionRoles = useMemo(
    () => guildRoles.map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
    [guildRoles],
  )
  const canMentionEveryone =
    channelPerms === 'owner' || (channelPerms != null && hasPermission(channelPerms, MENTION_EVERYONE))

  const EDIT_WINDOW_MS = 15 * 60 * 1000

  const isMessageAuthor = useCallback((msg: Message) => {
    return Boolean(user && msg.author && String(msg.author.id) === String(user.id))
  }, [user])

  const isWithinEditWindow = useCallback((msg: Message) => {
    if (!msg.timestamp) return true
    const created = new Date(msg.timestamp).getTime()
    if (Number.isNaN(created)) return true
    return Date.now() - created < EDIT_WINDOW_MS
  }, [])

  const canEditMessage = useCallback((msg: Message) => {
    return isMessageAuthor(msg) && isWithinEditWindow(msg)
  }, [isMessageAuthor, isWithinEditWindow])

  const canDeleteMessage = useCallback((msg: Message) => {
    return (isMessageAuthor(msg) && isWithinEditWindow(msg)) || canManageMessages
  }, [isMessageAuthor, isWithinEditWindow, canManageMessages])

  const [channelPinCount, setChannelPinCount] = useState<number>(0)

  const syncChannelPins = useCallback(async (channelId: string) => {
    try {
      const pins = await api.getPinnedMessages(channelId)
      setChannelPinCount(pins.length)
      const pinSet = new Set(pins.map((p) => p.id))
      setMessages((prev) =>
        prev.map((m) => ({ ...m, pinned: pinSet.has(m.id) }))
      )
    } catch {
      // ignore background sync errors
    }
  }, [])

  useEffect(() => {
    if (currentChannel) {
      syncChannelPins(currentChannel.id)
    } else {
      setChannelPinCount(0)
    }
  }, [currentChannel?.id, syncChannelPins])

  const handleTogglePin = useCallback(async (msg: Message) => {
    if (!currentChannel) return
    const wasPinned = Boolean(msg.pinned)
    // Optimistic toggle
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, pinned: !wasPinned } : m))
    )
    setChannelPinCount((prev) => (wasPinned ? Math.max(0, prev - 1) : prev + 1))
    try {
      if (wasPinned) {
        await api.unpinMessage(currentChannel.id, msg.id)
      } else {
        await api.pinMessage(currentChannel.id, msg.id)
      }
    } catch (err: any) {
      // Revert optimistic update
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, pinned: wasPinned } : m))
      )
      setChannelPinCount((prev) => (wasPinned ? prev + 1 : Math.max(0, prev - 1)))
      setError(err?.message || 'Failed to update pin')
    }
  }, [currentChannel])

  // Sync pinned state across visible messages on CHANNEL_PINS_UPDATE gateway event
  useEffect(() => {
    if (!currentChannel) return
    const unsub = subscribeToChannelPinsUpdate((payload) => {
      if (payload.channel_id === currentChannel.id) {
        syncChannelPins(currentChannel.id)
      }
    })
    return () => unsub()
  }, [currentChannel, subscribeToChannelPinsUpdate, syncChannelPins])


  // Current user's role IDs in active guild for mention detection
  const currentUserRoleIds = useMemo(() => {
    if (!user) return []
    const currentMember = guildMembers.find((m) => m.user?.id === user.id)
    return currentMember?.roles?.map((r) => String(r)) ?? []
  }, [user, guildMembers])

  // Pending attachment uploads (Discord-style presigned flow: PUT at selection,
  // complete at send). Scoped to the visible channel — switching channels drops them.
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [dragActive, setDragActive] = useState(false)
  const xhrByKey = useRef(new Map<string, { abort: () => void }>())
  const dragDepth = useRef(0)

  const patchPending = useCallback((key: string, p: Partial<PendingUpload>) => {
    setPending((prev) => prev.map((u) => (u.key === key ? { ...u, ...p } : u)))
  }, [])

  const kickUpload = useCallback(
    (channelId: string, key: string, file: File) => {
      runPendingUpload(
        channelId,
        file,
        (p) => patchPending(key, p),
        (h) => {
          if (h) xhrByKey.current.set(key, h)
          else xhrByKey.current.delete(key)
        }
      ).catch((err: any) => {
        if (err?.name === 'AbortError') {
          patchPending(key, { state: 'cancelled' })
        } else {
          patchPending(key, { state: 'error', error: err?.message || 'Upload failed' })
        }
      })
    },
    [patchPending]
  )

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (!currentChannel || !canAttach || incoming.length === 0) return
      const channelId = currentChannel.id
      const room = MAX_PENDING_FILES - pending.length
      if (room <= 0) {
        setError(`You can attach up to ${MAX_PENDING_FILES} files`)
        return
      }
      const accepted = incoming.slice(0, room)
      if (accepted.length < incoming.length) {
        setError(`You can attach up to ${MAX_PENDING_FILES} files`)
      }
      const starters: PendingUpload[] = accepted.map((file) => {
        const problem = validateFile(file)
        const base = {
          key: nextUploadKey(),
          file,
          filename: file.name || 'attachment',
          size: file.size,
          contentType: file.type || 'application/octet-stream',
          progress: 0,
        }
        return problem
          ? { ...base, state: 'error' as const, error: problem }
          : { ...base, state: 'presigning' as const }
      })
      setPending((prev) => [...prev, ...starters])
      for (const s of starters) {
        if (s.state !== 'error') void kickUpload(channelId, s.key, s.file)
      }
    },
    [currentChannel, canAttach, pending.length, kickUpload]
  )

  const removePending = useCallback((key: string) => {
    xhrByKey.current.get(key)?.abort()
    xhrByKey.current.delete(key)
    setPending((prev) => prev.filter((u) => u.key !== key))
  }, [])

  // Dropping pending uploads when the visible channel changes: staging rows
  // belong to the channel they were presigned for (complete is channel-scoped).
  useEffect(() => {
    for (const h of xhrByKey.current.values()) {
      try {
        h.abort()
      } catch {
        // ignore
      }
    }
    xhrByKey.current.clear()
    setPending([])
    setReplyingTo(null)
    setIsPinsOpen(false)
    setDragActive(false)
    dragDepth.current = 0
  }, [currentGuild?.id, currentChannel?.id])

  const scrollToBottom = useCallback((smooth = false) => {
    const container = scrollContainerRef.current
    if (container) {
      if (smooth) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      } else {
        container.scrollTop = container.scrollHeight
      }
    }
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const pinToBottom = useCallback((smooth = false) => {
    isAtBottomRef.current = true
    scrollToBottom(smooth)
    requestAnimationFrame(() => scrollToBottom(smooth))
    setTimeout(() => {
      if (isAtBottomRef.current || Date.now() < userJustSentRef.current) scrollToBottom(false)
    }, 80)
    setTimeout(() => {
      if (isAtBottomRef.current || Date.now() < userJustSentRef.current) scrollToBottom(false)
    }, 250)
  }, [scrollToBottom])

  // Auto-follow content height expansions (GIFs, attachments, stickers loading)
  useEffect(() => {
    const inner = messagesInnerRef.current
    const container = scrollContainerRef.current
    if (!inner || !container) return

    let prevHeight = inner.offsetHeight || container.scrollHeight

    const handleContentResize = () => {
      const currentHeight = inner.offsetHeight || container.scrollHeight
      const grew = currentHeight > prevHeight
      prevHeight = currentHeight

      if (isAtBottomRef.current || Date.now() < userJustSentRef.current) {
        if (grew) {
          container.scrollTop = container.scrollHeight
        }
      }
    }

    const ro = new ResizeObserver(handleContentResize)
    ro.observe(inner)

    // Capture media element load events as images & GIFs finish decoding
    const handleMediaLoad = () => {
      if (isAtBottomRef.current || Date.now() < userJustSentRef.current) {
        container.scrollTop = container.scrollHeight
      }
    }
    container.addEventListener('load', handleMediaLoad, { capture: true })

    return () => {
      ro.disconnect()
      container.removeEventListener('load', handleMediaLoad, { capture: true })
    }
  }, [])

  // Jump highlight helper
  const flashHighlight = useCallback((targetId: string) => {
    setHighlightedMessageId(targetId)
    setTimeout(() => {
      setHighlightedMessageId((prev) => (prev === targetId ? null : prev))
    }, 2500)
  }, [])

  // Load guild members and roles when server changes
  useEffect(() => {
    if (!currentGuild) {
      setGuildMembers([])
      setGuildRoles([])
      return
    }
    let active = true
    const reloadMembers = () => {
      api.getMembers(currentGuild.id)
        .then((m) => {
          if (active) setGuildMembers(m)
        })
        .catch((err) => console.error('Failed to load guild members for search:', err))
    }

    const reloadRoles = () => {
      api.getRoles(currentGuild.id)
        .then((r) => {
          if (active) setGuildRoles(r)
        })
        .catch((err) => console.error('Failed to load guild roles for permissions:', err))
    }

    reloadMembers()
    reloadRoles()
    window.addEventListener('focus', reloadRoles)

    const uRoleCreate = subscribeToRoleCreates((p) => {
      if (p.guild_id === currentGuild.id) reloadRoles()
    })
    const uRoleUpdate = subscribeToRoleUpdates((p) => {
      if (p.guild_id === currentGuild.id) reloadRoles()
    })
    const uRoleDelete = subscribeToRoleDeletes((p) => {
      if (p.guild_id === currentGuild.id) reloadRoles()
    })
    const uMemberUpdate = subscribeToMemberUpdates((p) => {
      if (p.guild_id === currentGuild.id && p.user?.id) {
        setGuildMembers((prev) =>
          prev.map((m) =>
            m.user.id === p.user.id
              ? { ...m, user: { ...m.user, ...p.user }, roles: p.roles ?? m.roles, nick: p.nick !== undefined ? p.nick : m.nick }
              : m
          )
        )
        setMessages((prev) =>
          prev.map((m) =>
            m.author?.id === p.user.id
              ? { ...m, author: { ...m.author, ...p.user } }
              : m
          )
        )
      }
    })

    return () => {
      active = false
      window.removeEventListener('focus', reloadRoles)
      uRoleCreate()
      uRoleUpdate()
      uRoleDelete()
      uMemberUpdate()
    }
  }, [
    currentGuild,
    currentChannel?.id,
    subscribeToRoleCreates,
    subscribeToRoleUpdates,
    subscribeToRoleDeletes,
    subscribeToMemberUpdates,
  ])

  // Fast author member lookup for message history role colors and nicknames
  const memberByUserId = useMemo(() => {
    const map = new Map<string, Member>()
    for (const m of guildMembers) {
      map.set(m.user.id, m)
    }
    return map
  }, [guildMembers])

  // Reset to latest present messages
  const resetToLatestMessages = useCallback(async () => {
    if (!currentGuild || !currentChannel) return
    try {
      setLoadingOlder(true)
      const msgs = await api.getMessages(currentGuild.id, currentChannel.id)
      setMessages([...msgs].reverse())
      setHasMore(msgs.length >= 50)
      setHasNewer(false)
      setIsViewingHistory(false)
      isViewingHistoryRef.current = false
      setFirstUnreadMessageId(null)
      isAtBottomRef.current = true
      userJustSentRef.current = Date.now() + 3000
      pinToBottom(true)
    } catch (err: any) {
      console.error('Failed to reset to latest messages:', err)
    } finally {
      setLoadingOlder(false)
    }
  }, [currentGuild, currentChannel, pinToBottom])

  // Jump to targeted message in current channel (with bi-directional context window)
  const jumpToTargetInCurrentChannel = useCallback(async (targetId: string) => {
    if (!currentGuild || !currentChannel) return

    // 1. If message already exists in rendered state, scroll straight to it
    const existingEl = document.getElementById(`msg-${targetId}`)
    if (existingEl) {
      existingEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flashHighlight(targetId)
      return
    }

    // 2. Fetch context window around targetId: 30 older + target + 30 newer
    try {
      setLoadingOlder(true)
      const beforeCursor = (BigInt(targetId) + 1n).toString()
      const [olderMsgs, newerMsgs] = await Promise.all([
        api.getMessages(currentGuild.id, currentChannel.id, beforeCursor, 30),
        api.getMessages(currentGuild.id, currentChannel.id, undefined, 30, targetId),
      ])

      const reversedOlder = [...olderMsgs].reverse()
      const combined = [...reversedOlder, ...newerMsgs]

      if (combined.length > 0) {
        setMessages(combined)
        setHasMore(olderMsgs.length >= 30)
        setHasNewer(newerMsgs.length >= 30)
        setIsViewingHistory(newerMsgs.length > 0)

        setTimeout(() => {
          const el = document.getElementById(`msg-${targetId}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            flashHighlight(targetId)
          }
        }, 100)
      }
    } catch (err) {
      console.error('Failed to jump to message:', err)
    } finally {
      setLoadingOlder(false)
    }
  }, [currentGuild, currentChannel, flashHighlight])

  // Debounce search input (450ms - Discord style pacing to protect 1 req/s rate limit)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim())
    }, 450)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const SEARCH_PAGE_SIZE = 25

  // Execute full-text search query with channel, author, offset, and inline filter tokens
  useEffect(() => {
    const parsed = parseSearchQuery(debouncedQuery)
    const cleanText = parsed.text.trim()

    // Resolve channel: dropdown selection takes precedence, else inline in: token
    let channelId = selectedChannelId || undefined
    if (!channelId && parsed.in) {
      const match = channels.find((c) => c.name.toLowerCase() === parsed.in?.toLowerCase())
      if (match) channelId = match.id
    }

    // Resolve author: dropdown selection takes precedence, else inline from: token
    let authorId = selectedAuthorId || undefined
    if (!authorId && parsed.from) {
      const match = guildMembers.find(
        (m) =>
          m.user.username.toLowerCase() === parsed.from?.toLowerCase() ||
          m.nick?.toLowerCase() === parsed.from?.toLowerCase()
      )
      if (match) authorId = match.user.id
    }

    // Check if there is ANY query or filter active
    const hasSearchActive = !!(cleanText || channelId || authorId)
    if (!currentGuild || !hasSearchActive) {
      setSearchResults([])
      setTotalSearchResults(0)
      return
    }

    const abortController = new AbortController()
    setIsSearching(true)

    const offset = (searchPage - 1) * SEARCH_PAGE_SIZE
    const filters: SearchFilters = {
      channelId,
      authorId,
      limit: SEARCH_PAGE_SIZE,
      offset,
      signal: abortController.signal,
    }

    api.searchMessages(currentGuild.id, cleanText, filters)
      .then((res) => {
        if (abortController.signal.aborted) return
        const msgs = res.messages ?? []
        setSearchResults(msgs)
        setTotalSearchResults(res.total_results ?? msgs.length)
      })
      .catch((err) => {
        if (err.name === 'AbortError' || abortController.signal.aborted) return
        console.error('Search request failed:', err)
        setSearchResults([])
        setTotalSearchResults(0)
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsSearching(false)
        }
      })

    return () => {
      abortController.abort()
    }
  }, [currentGuild, debouncedQuery, selectedChannelId, selectedAuthorId, searchPage, channels, guildMembers])

  // Clear search results when query is cleared (unless filter is still selected)
  const handleSearchChange = (val: string) => {
    setSearchQuery(val)
    setSearchPage(1)
    if (!val.trim()) {
      setDebouncedQuery('')
      if (!selectedChannelId && !selectedAuthorId) {
        setSearchResults([])
        setTotalSearchResults(0)
      }
    }
  }

  const handleSelectChannelFilter = (id: string) => {
    setSelectedChannelId(id)
    setSearchPage(1)
  }

  const handleSelectAuthorFilter = (id: string) => {
    setSelectedAuthorId(id)
    setSearchPage(1)
  }

  // Jump-to-mention request from a sidebar badge click (Issue #122): hand it
  // to the channel-switch loader below, which jumps after history arrives.
  useEffect(() => {
    if (mentionJump && currentChannel && mentionJump.channelId === currentChannel.id) {
      setPendingJumpId(mentionJump.messageId)
      onMentionJumpConsumed?.()
    }
  }, [mentionJump, currentChannel, onMentionJumpConsumed])

  // Fetch initial message history on channel change
  useEffect(() => {
    if (!currentGuild || !currentChannel) {
      return
    }

    const guildId = currentGuild.id
    const channelId = currentChannel.id
    let active = true

    setIsViewingHistory(false)
    isViewingHistoryRef.current = false
    setHasNewer(false)
    setFirstUnreadMessageId(null)

    Promise.all([
      api.getMessages(guildId, channelId),
      api.getChannelReadState(channelId).catch(() => null),
    ])
      .then(([msgs, readState]) => {
        if (!active) return
        const reversed = [...msgs].reverse()
        setMessages(reversed)
        setHasMore(msgs.length >= 50)
        setLoadingOlder(false)
        setError(null)

        // If there is a pending jump message waiting for channel switch
        if (pendingJumpId) {
          const target = pendingJumpId
          setPendingJumpId(null)
          setTimeout(() => jumpToTargetInCurrentChannel(target), 50)
          return
        }

        // Discord-style unread resume: check if user has unread messages
        const lastReadId = readState?.last_read_message_id
        let targetUnreadId: string | null = null

        if (lastReadId && reversed.length > 0) {
          const lastReadIdx = reversed.findIndex((m) => m.id === lastReadId)
          if (lastReadIdx !== -1 && lastReadIdx < reversed.length - 1) {
            targetUnreadId = reversed[lastReadIdx + 1].id
          }
        }

        if (targetUnreadId) {
          // Scroll up to last read and allow scrolling down to read the rest
          setFirstUnreadMessageId(targetUnreadId)
          isAtBottomRef.current = false
          setTimeout(() => {
            if (!active) return
            const targetEl = document.getElementById(`msg-${targetUnreadId}`) || document.getElementById('unread-divider')
            targetEl?.scrollIntoView({ behavior: 'auto', block: 'start' })
          }, 60)
        } else {
          // Fully caught up / on refresh: show the lowest part of the messages
          setFirstUnreadMessageId(null)
          isAtBottomRef.current = true
          if (msgs.length > 0) {
            api.ackMessage(channelId, msgs[0].id).catch(() => {})
          }
          pinToBottom(false)
        }
      })
      .catch((err: any) => {
        if (!active) return
        setError(err.message || 'Failed to fetch messages')
      })
      .finally(() => {
        if (active) setLoadingOlder(false)
      })

    return () => {
      active = false
    }
  }, [currentGuild, currentChannel, pendingJumpId, jumpToTargetInCurrentChannel, pinToBottom])

  // Refetch messages on session reset (Op 9 INVALID_SESSION) when resumption was rejected
  useEffect(() => {
    if (!currentGuild || !currentChannel) return
    const guildId = currentGuild.id
    const channelId = currentChannel.id

    return onSessionReset(() => {
      console.log('[ChatArea] session reset received — refetching message history')
      api.getMessages(guildId, channelId)
        .then((msgs) => {
          setMessages([...msgs].reverse())
          setHasMore(msgs.length >= 50)
          setHasNewer(false)
          setIsViewingHistory(false)
          setError(null)
        })
        .catch((err: any) => {
          setError(err.message || 'Failed to fetch messages')
        })
    })
  }, [currentGuild, currentChannel, onSessionReset])

  // Backward infinite scroll loader: smoothly prepends older messages across 10-day bucket partitions
  const loadOlderMessages = async () => {
    if (!currentGuild || !currentChannel || !hasMore || isLoadingOlderRef.current || messages.length === 0) {
      return
    }

    const container = scrollContainerRef.current
    if (!container) return

    isLoadingOlderRef.current = true
    setLoadingOlder(true)

    const oldestMsg = messages[0]
    const prevScrollHeight = container.scrollHeight
    const prevScrollTop = container.scrollTop

    try {
      const olderMsgs = await api.getMessages(currentGuild.id, currentChannel.id, oldestMsg.id, 50)
      if (olderMsgs.length < 50) {
        setHasMore(false)
      }
      if (olderMsgs.length > 0) {
        const existingIds = new Set(messages.map((m) => m.id))
        const uniqueOlder = olderMsgs.filter((m) => !existingIds.has(m.id))

        if (uniqueOlder.length > 0) {
          const reversed = [...uniqueOlder].reverse()
          setMessages((prev) => [...reversed, ...prev])

          // Preserve exact visual scroll position
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              const diff = scrollContainerRef.current.scrollHeight - prevScrollHeight
              scrollContainerRef.current.scrollTop = prevScrollTop + diff
            }
          })
        }
      }
    } catch (err: any) {
      console.error('Failed to load older messages:', err)
    } finally {
      // Discord-style inertial scroll cooldown (250ms) to prevent burst 429s on rapid wheeling
      setTimeout(() => {
        isLoadingOlderRef.current = false
        setLoadingOlder(false)
      }, 250)
    }
  }

  // Forward infinite scroll loader: smoothly appends newer messages when scrolling down in history
  const loadNewerMessages = async () => {
    if (!currentGuild || !currentChannel || !hasNewer || isLoadingNewerRef.current || messages.length === 0) {
      return
    }

    isLoadingNewerRef.current = true
    setLoadingNewer(true)
    const newestMsg = messages[messages.length - 1]

    try {
      const newerMsgs = await api.getMessages(currentGuild.id, currentChannel.id, undefined, 50, newestMsg.id)
      if (newerMsgs.length < 50) {
        setHasNewer(false)
      }
      if (newerMsgs.length > 0) {
        const existingIds = new Set(messages.map((m) => m.id))
        const uniqueNewer = newerMsgs.filter((m) => !existingIds.has(m.id))

        if (uniqueNewer.length > 0) {
          setMessages((prev) => [...prev, ...uniqueNewer])
        }
      }
    } catch (err: any) {
      console.error('Failed to load newer messages:', err)
    } finally {
      setTimeout(() => {
        isLoadingNewerRef.current = false
        setLoadingNewer(false)
      }, 250)
    }
  }

  const handleScroll = () => {
    const container = scrollContainerRef.current
    if (!container) return

    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const atBottom = scrollBottom <= 100
    isAtBottomRef.current = atBottom

    if (scrollBottom <= 20 && !hasNewer && isViewingHistory) {
      setIsViewingHistory(false)
      isViewingHistoryRef.current = false
    }

    // If user scrolled to the bottom while unread banner was visible, ack and clear
    if (scrollBottom <= 30 && firstUnreadMessageId && messages.length > 0 && currentChannel) {
      const latest = messages[messages.length - 1]
      api.ackMessage(currentChannel.id, latest.id).catch(() => {})
      setFirstUnreadMessageId(null)
    }

    // Trigger infinite scroll upwards when within 80px of top (synchronously single-flight guarded)
    if (container.scrollTop <= 80 && hasMore && !isLoadingOlderRef.current) {
      loadOlderMessages()
      return
    }

    // Trigger infinite scroll downwards when within 80px of bottom (synchronously single-flight guarded)
    if (scrollBottom <= 80 && hasNewer && !isLoadingNewerRef.current) {
      loadNewerMessages()
      return
    }
  }

  // Real-time Gateway WebSocket subscription
  useEffect(() => {
    if (!currentChannel) return
    const channelId = currentChannel.id

    const unsubscribe = subscribeToMessages((newMsg: Message) => {
      if (newMsg.channel_id === channelId) {
        setTypers((prev) => removeTyper(prev, newMsg.author.id))
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) {
            return prev
          }
          return [...prev, newMsg]
        })

        // Auto-scroll if user is at bottom or sent by self and not viewing history
        const container = scrollContainerRef.current
        const scrollBottom = container ? container.scrollHeight - container.scrollTop - container.clientHeight : 0
        const isNearBottom = container ? scrollBottom < 240 : true
        const isSentBySelf = newMsg.author.id === user?.id

        if (isSentBySelf || (!isViewingHistoryRef.current && (isNearBottom || isAtBottomRef.current))) {
          isAtBottomRef.current = true
          if (isSentBySelf) {
            userJustSentRef.current = Date.now() + 5000
          }
          requestAnimationFrame(() => {
            scrollToBottom(false)
            api.ackMessage(channelId, newMsg.id).catch(() => {})
          })
        }
      }
    })

    return unsubscribe
  }, [currentChannel, subscribeToMessages, user?.id, scrollToBottom])

  // Live processing-completion updates: the media worker publishes
  // MESSAGE_UPDATE when an attachment flips terminal, so tiles render
  // without a refresh (stale pending tiles otherwise hang forever).
  useEffect(() => {
    if (!currentChannel) return
    const channelId = currentChannel.id

    return subscribeToMessageUpdates((payload) => {
      if (!payload || payload.channel_id !== channelId || !payload.id) return
      setMessages((prev) => applyMessageUpdate(prev, payload))
      const cached = messagesRef.current.find((m) => m.id === payload.id)
      const stale = (cached?.attachments ?? []).filter(
        (a) => a.status !== 'ready' && a.status !== 'failed'
      )
      for (const att of stale) {
        api
          .getAttachment(channelId, att.id)
          .then((fresh) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === payload.id
                  ? {
                      ...m,
                      attachments: (m.attachments ?? []).map((a) =>
                        a.id === fresh.id ? fresh : a
                      ),
                    }
                  : m
              )
            )
          })
          .catch(() => {})
      }
    })
  }, [currentChannel, subscribeToMessageUpdates])

  // Real-time Gateway reaction updates
  useEffect(() => {
    if (!currentChannel) return
    const channelId = currentChannel.id

    const unsubAdd = subscribeToMessageReactionAdd((event) => {
      if (event.channel_id !== channelId) return
      const isMe = event.user_id === user?.id
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.message_id
            ? { ...m, reactions: applyReactionAdd(m.reactions, event.emoji, isMe) }
            : m
        )
      )
    })

    const unsubRemove = subscribeToMessageReactionRemove((event) => {
      if (event.channel_id !== channelId) return
      const isMe = event.user_id === user?.id
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.message_id
            ? { ...m, reactions: applyReactionRemove(m.reactions, event.emoji, isMe) }
            : m
        )
      )
    })

    return () => {
      unsubAdd()
      unsubRemove()
    }
  }, [currentChannel, subscribeToMessageReactionAdd, subscribeToMessageReactionRemove, user?.id])

  // Real-time message delete synchronization
  useEffect(() => {
    return subscribeToMessageDeletes((payload) => {
      if (currentChannel && payload.channel_id === currentChannel.id) {
        setMessages((prev) => prev.filter((m) => m.id !== payload.id))
      }
    })
  }, [currentChannel, subscribeToMessageDeletes])

  // Focus and adjust height when entering edit mode
  useEffect(() => {
    if (editingMessageId && editTextareaRef.current) {
      editTextareaRef.current.focus()
      editTextareaRef.current.setSelectionRange(
        editTextareaRef.current.value.length,
        editTextareaRef.current.value.length
      )
      editTextareaRef.current.style.height = 'auto'
      editTextareaRef.current.style.height = `${editTextareaRef.current.scrollHeight}px`
    }
  }, [editingMessageId])

  // Keyboard shortcut 'e' to edit hovered message
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      if ((e.key === 'e' || e.key === 'E') && hoveredMessageId && !editingMessageId && !deletingMessage) {
        const targetMsg = messagesRef.current.find((m) => m.id === hoveredMessageId)
        if (targetMsg && canEditMessage(targetMsg)) {
          e.preventDefault()
          setEditingMessageId(targetMsg.id)
          setEditingContent(targetMsg.content)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hoveredMessageId, editingMessageId, deletingMessage, canEditMessage])

  // Power-user ergonomics (Issue #126): Up arrow in empty input triggers edit of user's last sent message
  const handleEditLastMessage = useCallback(() => {
    if (editingMessageId || deletingMessage || !user) return
    const target = findLastEditableMessage(messagesRef.current, user.id, canEditMessage)
    if (target) {
      setEditingMessageId(target.id)
      setEditingContent(target.content)
      const el = document.getElementById(`msg-${target.id}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [editingMessageId, deletingMessage, user, canEditMessage])

  const handleSaveEdit = async () => {
    if (!currentChannel || !editingMessageId || isSavingEdit) return
    const trimmed = editingContent.trim()
    if (!trimmed) return

    const targetMsg = messagesRef.current.find((m) => m.id === editingMessageId)
    if (!targetMsg) return

    if (trimmed === targetMsg.content) {
      setEditingMessageId(null)
      setEditingContent('')
      return
    }

    const prevContent = targetMsg.content
    const prevEdited = targetMsg.edited_timestamp
    const nowIso = new Date().toISOString()
    const editingId = editingMessageId

    // Optimistic update
    setMessages((prev) =>
      prev.map((m) =>
        m.id === editingId
          ? { ...m, content: trimmed, edited_timestamp: nowIso }
          : m
      )
    )
    setEditingMessageId(null)
    setEditingContent('')

    setIsSavingEdit(true)
    try {
      await api.editMessage(currentChannel.id, editingId, trimmed)
    } catch (err: any) {
      console.error('Failed to edit message:', err)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === editingId
            ? { ...m, content: prevContent, edited_timestamp: prevEdited }
            : m
        )
      )
      setError(err?.message || 'Failed to edit message')
    } finally {
      setIsSavingEdit(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!currentChannel || !deletingMessage || isDeleting) return
    const msgToDelete = deletingMessage
    const messageId = msgToDelete.id
    const prevMessages = messagesRef.current

    setIsDeleting(true)
    // Optimistic removal
    setMessages((prev) => prev.filter((m) => m.id !== messageId))
    setDeletingMessage(null)

    try {
      await api.deleteMessage(currentChannel.id, messageId)
    } catch (err: any) {
      console.error('Failed to delete message:', err)
      setMessages(prevMessages)
      setError(err?.message || 'Failed to delete message')
    } finally {
      setIsDeleting(false)
    }
  }

  const openPickerForMessage = (messageId: string, event?: React.MouseEvent) => {
    if (activePicker?.messageId === messageId) {
      setActivePicker(null)
      return
    }
    const isLowerHalf = event ? event.clientY > window.innerHeight * 0.55 : false
    const position = isLowerHalf
      ? { bottom: 28, right: 16 }
      : { top: 24, right: 16 }
    setActivePicker({ messageId, position })
  }

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    if (!currentGuild || !currentChannel || !user) return

    const targetMsg = messagesRef.current.find((m) => m.id === messageId)
    if (!targetMsg) return

    const prevReactions = targetMsg.reactions ?? []
    const { nextReactions, wasMe } = toggleReactionOptimistic(prevReactions, emoji)

    // Optimistically update message reactions in local state
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, reactions: nextReactions } : m))
    )

    try {
      if (wasMe) {
        await api.removeReaction(currentChannel.id, messageId, emoji)
      } else {
        await api.addReaction(currentChannel.id, messageId, emoji)
      }
    } catch (err: any) {
      console.error('Failed to toggle reaction:', err)
      // Rollback to previous reactions on failure
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions: prevReactions } : m))
      )
      setError(err?.message || 'Failed to update reaction')
    }
  }

  const handleJumpToMessage = (msg: Message) => {
    // If message is in another channel, switch to that channel first
    if (currentChannel && msg.channel_id !== currentChannel.id) {
      if (onSelectChannel) {
        setPendingJumpId(msg.id)
        onSelectChannel(msg.channel_id)
        return
      }
    }

    jumpToTargetInCurrentChannel(msg.id)
  }

  // Typing indicators
  useEffect(() => {
    if (!currentChannel) return
    const channelId = currentChannel.id

    return subscribeToTyping((typing) => {
      if (typing.channel_id !== channelId) return
      if (typing.user_id === user?.id) return

      const remaining = remainingMs(typing)
      if (remaining <= 0) return

      setTypers((prev) => {
        const next = new Map(prev)
        next.set(typing.user_id, {
          channelId,
          name: typingDisplayName(typing),
          expiresAt: Date.now() + remaining,
        })
        return next
      })
    })
  }, [currentChannel, subscribeToTyping, user?.id])

  // Expiry sweep
  useEffect(() => {
    const sweep = setInterval(() => {
      setTypers((prev) => {
        const now = Date.now()
        let changed = false
        const next = new Map<string, ActiveTyper>()
        for (const [userId, typer] of prev) {
          if (typer.expiresAt > now) {
            next.set(userId, typer)
          } else {
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 500)
    return () => clearInterval(sweep)
  }, [])

  // Channel switch reset
  useEffect(() => {
    setTypers(new Map())
  }, [currentChannel?.id])

  // Session reset
  useEffect(() => {
    return onSessionReset(() => setTypers(new Map()))
  }, [onSessionReset])

  const readyUploads = pending.filter((p) => p.state === 'uploaded')
  const uploadsBlocked = pending.some((p) => p.state === 'presigning' || p.state === 'uploading')

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    if ((!inputText.trim() && readyUploads.length === 0) || !currentGuild || !currentChannel || sending || uploadsBlocked) return

    const content = inputText.trim()
    const guildId = currentGuild.id
    const channelId = currentChannel.id

    setSending(true)
    setError(null)

    try {
      const attIDs = readyUploads.map((p) => {
        if (!p.attachmentId) throw new Error(`Attachment ${p.filename} was never uploaded`)
        return p.attachmentId
      })
      const messageReference = replyingTo ? { message_id: replyingTo.id } : undefined
      const sent = await api.sendMessage(
        guildId,
        channelId,
        content,
        attIDs.length > 0 ? attIDs : undefined,
        messageReference
      )
      setInputText('')
      setPending([])
      setReplyingTo(null)
      resetTypingThrottle(channelId)
      if (user) setTypers((prev) => removeTyper(prev, user.id))
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        return [...prev, sent]
      })
      setIsViewingHistory(false)
      isViewingHistoryRef.current = false
      setHasNewer(false)
      isAtBottomRef.current = true
      userJustSentRef.current = Date.now() + 5000
      pinToBottom(true)
    } catch (err: any) {
      setError(err.message || 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const handleSendSticker = async (sticker: GuildSticker) => {
    if (!currentGuild || !currentChannel || sending) return
    setSending(true)
    setError(null)
    try {
      const messageReference = replyingTo ? { message_id: replyingTo.id } : undefined
      const sent = await api.sendMessage(
        currentGuild.id,
        currentChannel.id,
        '',
        undefined,
        messageReference,
        [sticker.id]
      )
      setReplyingTo(null)
      resetTypingThrottle(currentChannel.id)
      if (user) setTypers((prev) => removeTyper(prev, user.id))
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        return [...prev, sent]
      })
      setIsViewingHistory(false)
      isViewingHistoryRef.current = false
      setHasNewer(false)
      isAtBottomRef.current = true
      userJustSentRef.current = Date.now() + 5000
      pinToBottom(true)
    } catch (err: any) {
      setError(err.message || 'Failed to send sticker')
    } finally {
      setSending(false)
    }
  }

  const handleSendGif = async (gifUrl: string) => {
    if (!currentGuild || !currentChannel || sending) return
    setSending(true)
    setError(null)
    try {
      const messageReference = replyingTo ? { message_id: replyingTo.id } : undefined
      const sent = await api.sendMessage(
        currentGuild.id,
        currentChannel.id,
        gifUrl,
        undefined,
        messageReference
      )
      setReplyingTo(null)
      resetTypingThrottle(currentChannel.id)
      if (user) setTypers((prev) => removeTyper(prev, user.id))
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        return [...prev, sent]
      })
      setIsViewingHistory(false)
      isViewingHistoryRef.current = false
      setHasNewer(false)
      isAtBottomRef.current = true
      userJustSentRef.current = Date.now() + 5000
      pinToBottom(true)
    } catch (err: any) {
      setError(err.message || 'Failed to send GIF')
    } finally {
      setSending(false)
    }
  }

  // Drag-drop + paste support (Discord-style). Container-level so drops
  // anywhere over the chat surface attach to the visible channel.
  const handleDragEnter = (e: DragEvent) => {
    if (!canAttach || !e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const handleDragOver = (e: DragEvent) => {
    if (!canAttach) return
    e.preventDefault()
  }
  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    if (!canAttach) return
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
    if (files.length > 0) addFiles(files)
  }
  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach) return
    const files = e.clipboardData?.files ? Array.from(e.clipboardData.files) : []
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  const handleInputChange = (value: string) => {
    setInputText(value)
    if (value.length > 0 && currentChannel && canSendMessages) {
      sendTyping(currentChannel.id)
    }
  }

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ts
    }
  }

  const formatFullDateTime = (ts?: string | null) => {
    if (!ts) return ''
    try {
      const d = new Date(ts)
      return d.toLocaleString([], {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return ts
    }
  }

  const typingText = typingIndicatorText(
    Array.from(typers.values())
      .filter((t) => currentChannel && t.channelId === currentChannel.id)
      .map((t) => t.name),
  )

  if (!currentGuild || !currentChannel) {
    return (
      <ChatEmptyState
        currentGuild={currentGuild}
        channels={channels}
        guilds={guilds}
        onSelectChannel={onSelectChannel}
        onSelectGuild={onSelectGuild}
        onOpenCreateGuildModal={onOpenCreateGuildModal}
      />
    )
  }

  return (
    <div
      className="chat-area"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {dragActive && canAttach && (
        <div className="chat-drop-overlay">
          <span>Drop files to upload to #{currentChannel.name}</span>
        </div>
      )}
      {/* Channel Header with Search Bar */}
      <div className="chat-header">
        <Hash size={24} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontWeight: 700 }}>{currentChannel.name}</span>
        <span className="chat-header-desc">Welcome to the #{currentChannel.name} channel!</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Real-time Status Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: connected ? '#23a55a' : '#f0b232',
                display: 'inline-block',
              }}
              title={connected ? 'Real-time Gateway Connected' : 'Gateway Connecting...'}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {connected ? 'Live' : 'Connecting...'}
            </span>
          </div>

          {/* Pinned Messages Drawer Toggle */}
          <button
            type="button"
            className={`chat-header-icon-btn ${isPinsOpen ? 'active' : ''} ${channelPinCount > 0 ? 'has-pins' : ''}`}
            title={isPinsOpen ? "Close Pinned Messages" : (channelPinCount > 0 ? `${channelPinCount} Pinned Message${channelPinCount === 1 ? '' : 's'}` : "Pinned Messages")}
            aria-label="Pinned Messages"
            onClick={() => {
              setIsPinsOpen((prev) => !prev)
              if (!isPinsOpen) setIsSearchDrawerOpen(false)
            }}
          >
            <Pin size={20} fill={isPinsOpen || channelPinCount > 0 ? "currentColor" : "none"} />
            {channelPinCount > 0 && (
              <span className="chat-header-pin-badge">{channelPinCount}</span>
            )}
          </button>

          {/* Search Bar in Channel Header */}
          <SearchBar
            query={searchQuery}
            onChange={handleSearchChange}
            onOpenDrawer={() => setIsSearchDrawerOpen(true)}
            channelName={currentChannel.name}
            members={guildMembers}
            channels={channels}
          />
        </div>
      </div>

      {/* Main Body: Messages and Slide-Out Search Results Drawer */}
      <div className="chat-main-container">
        <div className="chat-messages-container">
          {/* Scrollable Messages Container */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="messages-scroll"
          >
            {/* Top Loading Indicator when fetching older messages */}
            {loadingOlder && (
              <div className="messages-loading-top">
                <Loader2 size={16} className="spin" />
                <span>Loading older messages...</span>
              </div>
            )}

            <div ref={messagesInnerRef} className="messages-inner-stream">
            {/* Channel Welcome Banner (rendered only when user scrolled to true beginning) */}
            {!hasMore && (
              <WelcomeHero channel={currentChannel} empty={messages.length === 0} />
            )}

            {/* Message List */}
            {messages.map((msg, idx) => {
              const prevMsg = idx > 0 ? messages[idx - 1] : null
              const isHighlighted = highlightedMessageId === msg.id
              const authorMember = msg.author ? memberByUserId.get(msg.author.id) : undefined
              const authorColor = authorMember ? memberNameColor(authorMember, guildRoles) : null
              const authorName = authorMember?.nick || msg.author?.username || 'Unknown'
              const isPickerOpen = activePicker?.messageId === msg.id
              const isReply = Boolean(msg.type === 19 || msg.reply_to)
              const isEditing = editingMessageId === msg.id
              const isMentioned = Boolean(
                user && isMessageMentioningUser(msg.content, user.id, currentUserRoleIds)
              )
              const isFirstUnread = firstUnreadMessageId === msg.id
              const isConsecutive = shouldGroupConsecutiveMessage(prevMsg, msg, { isFirstUnread })

              return (
                <Fragment key={msg.id}>
                  {firstUnreadMessageId === msg.id && (
                    <div id="unread-divider" className="unread-divider" role="separator" aria-label="New Messages">
                      <div className="unread-divider-line" />
                      <span className="unread-divider-badge">NEW MESSAGES</span>
                      <div className="unread-divider-line" />
                    </div>
                  )}
                  <div
                    id={`msg-${msg.id}`}
                    className={`message-card ${isConsecutive ? 'is-consecutive' : 'has-header'} ${msg.pinned ? 'is-pinned' : ''} ${isHighlighted ? 'message-highlighted' : ''} ${isReply ? 'is-reply' : ''} ${isEditing ? 'is-editing' : ''} ${isMentioned ? 'message-mentioned' : ''}`}
                    onMouseEnter={() => setHoveredMessageId(msg.id)}
                    onMouseLeave={() => setHoveredMessageId((prev) => (prev === msg.id ? null : prev))}
                  >
                  {/* Floating Action Toolbar on hover */}
                  {!isEditing && (
                    <MessageToolbar
                      message={msg}
                      canEdit={canEditMessage(msg)}
                      canDelete={canDeleteMessage(msg)}
                      canPin={canManageMessages}
                      canReply={canSendMessages}
                      canAddReaction={canAddReactions}
                      onQuickReaction={(emoji) => handleToggleReaction(msg.id, emoji)}
                      onOpenReactionPicker={(e) => openPickerForMessage(msg.id, e)}
                      onReply={() => handleStartReply(msg)}
                      onEdit={() => {
                        setEditingMessageId(msg.id)
                        setEditingContent(msg.content)
                      }}
                      onPin={() => handleTogglePin(msg)}
                      onDelete={() => setDeletingMessage(msg)}
                    />
                  )}

                  {isPickerOpen && (
                    <ReactionPicker
                      onSelectEmoji={(emoji) => handleToggleReaction(msg.id, emoji)}
                      onSelectCustomEmoji={(customEmoji) =>
                        handleToggleReaction(msg.id, `${customEmoji.name}:${customEmoji.id}`)
                      }
                      onClose={() => setActivePicker(null)}
                      position={activePicker?.position}
                      customEmojiGroups={customEmojiGroups}
                    />
                  )}

                  {isReply && msg.reply_to && (
                    <ParentQuote
                      replyToId={msg.reply_to}
                      referencedMessage={msg.referenced_message}
                      onJump={jumpToTargetInCurrentChannel}
                    />
                  )}

                  <div className="message-main-row">
                    {isConsecutive ? (
                      <div className="message-gutter-time" title={formatFullDateTime(msg.timestamp)}>
                        {formatTime(msg.timestamp)}
                      </div>
                    ) : (
                      <div className="message-avatar" title={authorName}>
                        {msg.author?.avatar ? (
                          <img src={msg.author.avatar} alt={authorName} className="message-avatar-img" />
                        ) : (
                          msg.author?.username?.substring(0, 2).toUpperCase() ?? 'U'
                        )}
                      </div>
                    )}
                    <div className="message-content-wrap">
                      {!isConsecutive && (
                        <div className="message-meta">
                          <span
                            className="message-author"
                            style={authorColor ? { color: authorColor } : undefined}
                          >
                            {authorName}
                          </span>
                          <span className="message-time" title={formatFullDateTime(msg.timestamp)}>
                            {formatTime(msg.timestamp)}
                          </span>
                          {msg.pinned && (
                            <span className="message-pinned-badge" title="This message is pinned to the channel">
                              <Pin size={11} fill="currentColor" />
                              <span>Pinned</span>
                            </span>
                          )}
                        </div>
                      )}

                      {isEditing ? (
                        <div className="message-inline-editor">
                          <textarea
                            ref={editTextareaRef}
                            className="message-edit-textarea"
                            value={editingContent}
                            onChange={(e) => {
                              setEditingContent(e.target.value)
                              e.target.style.height = 'auto'
                              e.target.style.height = `${e.target.scrollHeight}px`
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                handleSaveEdit()
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                setEditingMessageId(null)
                                setEditingContent('')
                              }
                            }}
                            disabled={isSavingEdit}
                            rows={1}
                          />
                          <div className="message-edit-operations">
                            <span>
                              escape to{' '}
                              <button
                                type="button"
                                className="edit-link-btn"
                                onClick={() => {
                                  setEditingMessageId(null)
                                  setEditingContent('')
                                }}
                              >
                                cancel
                              </button>{' '}
                              • enter to{' '}
                              <button
                                type="button"
                                className="edit-link-btn"
                                onClick={handleSaveEdit}
                                disabled={isSavingEdit}
                              >
                                save
                              </button>
                            </span>
                          </div>
                        </div>
                      ) : (() => {
                        const gifUrls = extractGifUrls(msg.content)
                        const textContent = gifUrls.length > 0 ? stripGifUrls(msg.content) : msg.content
                        if (!textContent && !msg.edited_timestamp) return null
                        return (
                          <div className="message-text">
                            {textContent && (
                              <MarkdownView
                                content={textContent}
                                members={guildMembers}
                                roles={guildRoles}
                              />
                            )}
                            {msg.edited_timestamp && (
                              <span
                                className="message-edited-tag"
                                title={formatFullDateTime(msg.edited_timestamp)}
                              >
                                (edited)
                              </span>
                            )}
                          </div>
                        )
                      })()}

                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="message-attachments">
                          {msg.attachments.map((a) => (
                            <AttachmentView key={a.id} attachment={a} channelId={msg.channel_id} />
                          ))}
                        </div>
                      )}
                      {msg.sticker_ids && msg.sticker_ids.length > 0 && (
                        <div className="message-stickers">
                          {msg.sticker_ids.map((sId) => (
                            <img
                              key={sId}
                              src={`/stickers/${sId}.png`}
                              alt="sticker"
                              className="chat-message-sticker"
                            />
                          ))}
                        </div>
                      )}
                      {(() => {
                        const gifUrls = extractGifUrls(msg.content)
                        if (gifUrls.length === 0) return null
                        return (
                          <div className="message-gif-embeds">
                            {gifUrls.map((url, idx) => (
                              <ChatGifEmbed
                                key={idx}
                                url={url}
                                onMediaLoad={() => {
                                  if (isAtBottomRef.current || Date.now() < userJustSentRef.current) {
                                    scrollToBottom(false)
                                  }
                                }}
                              />
                            ))}
                          </div>
                        )
                      })()}
                      {msg.reactions && msg.reactions.length > 0 && (
                        <ReactionPills
                          reactions={msg.reactions}
                          onToggleReaction={(emoji) => handleToggleReaction(msg.id, emoji)}
                          onOpenPicker={(e) => openPickerForMessage(msg.id, e)}
                          canAddReaction={canAddReactions}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </Fragment>
            )
          })}

            {/* Bottom Loading Indicator when scrolling down to fetch newer messages */}
            {loadingNewer && (
              <div
                className="messages-loading-bottom"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 0',
                  color: 'var(--text-muted)',
                  fontSize: 13,
                }}
              >
                <Loader2 size={16} className="spin" />
                <span>Loading newer messages...</span>
              </div>
            )}

            </div>
            <div ref={messagesEndRef} style={{ height: 0, margin: 0, padding: 0 }} />
          </div>

          {/* Viewing History Banner with Jump to Present button */}
          {isViewingHistory && (
            <div className="chat-history-banner">
              <span className="chat-history-banner-text">
                You are viewing older messages
              </span>
              <button
                type="button"
                className="chat-jump-present-btn"
                onClick={resetToLatestMessages}
                title="Jump to Present"
              >
                <span>Jump to Present</span>
                <ArrowDown size={14} />
              </button>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="error-banner">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Typing Indicator */}
          <div className={`typing-indicator ${typingText ? 'is-typing' : ''}`} aria-live="polite">
            {typingText && (
              <span className="typing-indicator-text">
                {typingText}
                <span className="typing-dots" aria-hidden="true">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
              </span>
            )}
          </div>

          {/* Message Input Box */}
          <MessageInput
            channelName={currentChannel.name}
            canSend={canSendMessages}
            inputText={inputText}
            onChange={handleInputChange}
            onSend={handleSend}
            sending={sending}
            canAttach={canAttach}
            pending={pending}
            hasReadyUploads={readyUploads.length > 0}
            uploadsBlocked={uploadsBlocked}
            onPickFiles={addFiles}
            onRemovePending={removePending}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            inputRef={chatInputRef}
            customEmojiGroups={customEmojiGroups}
            customStickerGroups={customStickerGroups}
            onSelectSticker={handleSendSticker}
            onSendGif={handleSendGif}
            mentionMembers={mentionMembers}
            mentionRoles={mentionRoles}
            canMentionEveryone={canMentionEveryone}
            onEditLastMessage={handleEditLastMessage}
          />
        </div>

        {/* Search Results Drawer */}
        <SearchResults
          isOpen={isSearchDrawerOpen}
          onClose={() => setIsSearchDrawerOpen(false)}
          query={debouncedQuery}
          results={searchResults}
          totalResults={totalSearchResults}
          loading={isSearching}
          currentPage={searchPage}
          pageSize={SEARCH_PAGE_SIZE}
          onPageChange={setSearchPage}
          channels={channels}
          members={guildMembers}
          roles={guildRoles}
          currentChannel={currentChannel}
          selectedChannelId={selectedChannelId}
          onSelectChannelFilter={handleSelectChannelFilter}
          selectedAuthorId={selectedAuthorId}
          onSelectAuthorFilter={handleSelectAuthorFilter}
          onJumpToMessage={handleJumpToMessage}
        />

        {/* Pinned Messages Slide-Over Drawer */}
        <PinnedMessagesDrawer
          isOpen={isPinsOpen}
          onClose={() => setIsPinsOpen(false)}
          channel={currentChannel}
          canManageMessages={canManageMessages}
          onJumpToMessage={jumpToTargetInCurrentChannel}
        />

        {/* Delete Confirmation Modal */}
        {deletingMessage && (
          <DeleteMessageModal
            message={deletingMessage}
            isDeleting={isDeleting}
            onConfirm={handleConfirmDelete}
            onClose={() => {
              if (!isDeleting) setDeletingMessage(null)
            }}
          />
        )}
      </div>
    </div>
  )
}
