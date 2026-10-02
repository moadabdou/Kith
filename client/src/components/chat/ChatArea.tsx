import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import { AlertCircle, ArrowDown, Hash, Loader2, Reply, SmilePlus } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useGateway } from '../../gateway/useGateway'
import { memberNameColor } from '../../lib/members'
import { ADD_REACTIONS, ATTACH_FILES, hasPermission, resolveChannelPermissions, SEND_MESSAGES } from '../../lib/permissions'
import { applyMessageUpdate } from '../../lib/message-updates'
import { applyReactionAdd, applyReactionRemove, toggleReactionOptimistic } from '../../lib/reactions'
import { parseSearchQuery } from '../../lib/search'
import {
  MAX_PENDING_FILES,
  nextUploadKey,
  runPendingUpload,
  validateFile,
  type PendingUpload,
} from '../../lib/uploads'
import { remainingMs, typingDisplayName, typingIndicatorText } from '../../lib/typing'
import type { Channel, Guild, Member, Message, Role, SearchFilters } from '../../types'
import { SearchBar } from '../search/SearchBar'
import { SearchResults } from '../search/SearchResults'
import { AttachmentView } from './AttachmentView'
import { MessageInput } from './MessageInput'
import { ParentQuote } from './ParentQuote'
import { ReactionPicker } from './ReactionPicker'
import { ReactionPills } from './ReactionPills'

interface ChatAreaProps {
  currentGuild: Guild | null
  currentChannel: Channel | null
  channels?: Channel[]
  onSelectChannel?: (id: string) => void
}

interface ActiveTyper {
  channelId: string
  name: string
  expiresAt: number
}

export function ChatArea({ currentGuild, currentChannel, channels = [], onSelectChannel }: ChatAreaProps) {
  const { user } = useAuth()
  const {
    subscribeToMessages,
    subscribeToMessageUpdates,
    subscribeToTyping,
    sendTyping,
    connected,
    onSessionReset,
    subscribeToRoleCreates,
    subscribeToRoleUpdates,
    subscribeToRoleDeletes,
    subscribeToMemberUpdates,
    subscribeToMessageReactionAdd,
    subscribeToMessageReactionRemove,
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
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isLoadingOlderRef = useRef(false)
  const isLoadingNewerRef = useRef(false)

  // Search State & Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Message[]>([])
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
    setDragActive(false)
    dragDepth.current = 0
  }, [currentGuild?.id, currentChannel?.id])

  const scrollToBottom = (smooth = false) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  }

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
      if (p.guild_id === currentGuild.id) {
        setGuildMembers((prev) =>
          prev.map((m) =>
            m.user.id === p.user?.id
              ? { ...m, roles: p.roles ?? m.roles, nick: p.nick !== undefined ? p.nick : m.nick }
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
      requestAnimationFrame(() => scrollToBottom(false))
    } catch (err: any) {
      console.error('Failed to reset to latest messages:', err)
    } finally {
      setLoadingOlder(false)
    }
  }, [currentGuild, currentChannel])

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
    if (!currentGuild || !debouncedQuery) {
      setSearchResults([])
      setTotalSearchResults(0)
      return
    }

    const abortController = new AbortController()
    setIsSearching(true)

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

    const offset = (searchPage - 1) * SEARCH_PAGE_SIZE
    const filters: SearchFilters = {
      channelId,
      authorId,
      limit: SEARCH_PAGE_SIZE,
      offset,
      signal: abortController.signal,
    }

    api.searchMessages(currentGuild.id, cleanText || debouncedQuery, filters)
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

  // Clear search results when query is cleared
  const handleSearchChange = (val: string) => {
    setSearchQuery(val)
    setSearchPage(1)
    if (!val.trim()) {
      setDebouncedQuery('')
      setSearchResults([])
      setTotalSearchResults(0)
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

  // Fetch initial message history on channel change
  useEffect(() => {
    if (!currentGuild || !currentChannel) {
      return
    }

    const guildId = currentGuild.id
    const channelId = currentChannel.id
    let active = true

    setIsViewingHistory(false)
    setHasNewer(false)

    api.getMessages(guildId, channelId)
      .then((msgs) => {
        if (!active) return
        setMessages([...msgs].reverse())
        setHasMore(msgs.length >= 50)
        setLoadingOlder(false)
        setError(null)

        if (msgs.length > 0) {
          api.ackMessage(channelId, msgs[0].id).catch(() => {})
        }

        // If there is a pending jump message waiting for channel switch
        if (pendingJumpId) {
          const target = pendingJumpId
          setPendingJumpId(null)
          setTimeout(() => jumpToTargetInCurrentChannel(target), 50)
        } else {
          requestAnimationFrame(() => scrollToBottom(false))
        }
      })
      .catch((err: any) => {
        if (!active) return
        setError(err.message || 'Failed to fetch messages')
      })

    return () => {
      active = false
    }
  }, [currentGuild, currentChannel, pendingJumpId, jumpToTargetInCurrentChannel])

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
    if (scrollBottom <= 20 && !hasNewer && isViewingHistory) {
      setIsViewingHistory(false)
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
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) {
            return prev
          }
          return [...prev, newMsg]
        })

        // Auto-scroll only if user is already near bottom or sent by self and not viewing history
        const container = scrollContainerRef.current
        const isNearBottom = container
          ? container.scrollHeight - container.scrollTop - container.clientHeight < 160
          : true

        if (!isViewingHistory && (isNearBottom || newMsg.author.id === user?.id)) {
          requestAnimationFrame(() => scrollToBottom(true))
        }
      }
    })

    return unsubscribe
  }, [currentChannel, subscribeToMessages, user?.id, isViewingHistory])

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
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        return [...prev, sent]
      })
      setIsViewingHistory(false)
      setHasNewer(false)
      requestAnimationFrame(() => scrollToBottom(true))
    } catch (err: any) {
      setError(err.message || 'Failed to send message')
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

  const typingText = typingIndicatorText(
    Array.from(typers.values())
      .filter((t) => currentChannel && t.channelId === currentChannel.id)
      .map((t) => t.name),
  )

  if (!currentGuild || !currentChannel) {
    return (
      <div className="chat-area" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Select a server and channel to start chatting</p>
      </div>
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

          {/* Search Bar in Channel Header */}
          <SearchBar
            query={searchQuery}
            onChange={handleSearchChange}
            onOpenDrawer={() => setIsSearchDrawerOpen(true)}
            channelName={currentChannel.name}
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

            {/* Channel Welcome Banner (rendered only when user scrolled to true beginning) */}
            {!hasMore && (
              <div className="channel-welcome-banner">
                <div className="welcome-hash-circle">
                  <Hash size={40} style={{ color: 'white' }} />
                </div>
                <h2 className="welcome-title">Welcome to #{currentChannel.name}!</h2>
                <p className="welcome-subtitle">This is the start of the #{currentChannel.name} channel.</p>
              </div>
            )}

            {/* Message List */}
            {messages.map((msg) => {
              const isHighlighted = highlightedMessageId === msg.id
              const authorMember = msg.author ? memberByUserId.get(msg.author.id) : undefined
              const authorColor = authorMember ? memberNameColor(authorMember, guildRoles) : null
              const authorName = authorMember?.nick || msg.author?.username || 'Unknown'
              const isPickerOpen = activePicker?.messageId === msg.id
              const isReply = Boolean(msg.type === 19 || msg.reply_to)

              return (
                <div
                  id={`msg-${msg.id}`}
                  key={msg.id}
                  className={`message-card ${isHighlighted ? 'message-highlighted' : ''} ${isReply ? 'is-reply' : ''}`}
                >
                  {/* Floating Action Toolbar on hover */}
                  {(canAddReactions || canSendMessages) && (
                    <div className={`message-actions-toolbar ${isPickerOpen ? 'is-open' : ''}`}>
                      {canSendMessages && (
                        <button
                          type="button"
                          className="message-action-btn"
                          title="Reply"
                          aria-label="Reply"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleStartReply(msg)
                          }}
                        >
                          <Reply size={16} />
                        </button>
                      )}
                      {canAddReactions && (
                        <button
                          type="button"
                          className="message-action-btn"
                          title="Add Reaction"
                          aria-label="Add Reaction"
                          onClick={(e) => {
                            e.stopPropagation()
                            openPickerForMessage(msg.id, e)
                          }}
                        >
                          <SmilePlus size={16} />
                        </button>
                      )}
                    </div>
                  )}

                  {isPickerOpen && (
                    <ReactionPicker
                      onSelectEmoji={(emoji) => handleToggleReaction(msg.id, emoji)}
                      onClose={() => setActivePicker(null)}
                      position={activePicker?.position}
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
                    <div className="user-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
                      {msg.author?.username?.substring(0, 2).toUpperCase() ?? 'U'}
                    </div>
                    <div className="message-content-wrap">
                      <div className="message-meta">
                        <span
                          className="message-author"
                          style={authorColor ? { color: authorColor } : undefined}
                        >
                          {authorName}
                        </span>
                        <span className="message-time">{formatTime(msg.timestamp)}</span>
                      </div>
                      <div className="message-text">{msg.content}</div>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="message-attachments">
                          {msg.attachments.map((a) => (
                            <AttachmentView key={a.id} attachment={a} channelId={msg.channel_id} />
                          ))}
                        </div>
                      )}
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

            <div ref={messagesEndRef} />
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
          <div className="typing-indicator" aria-live="polite">
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
      </div>
    </div>
  )
}
