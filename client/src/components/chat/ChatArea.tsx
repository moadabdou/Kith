import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowDown, Hash, Loader2, Send } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../context/useAuth'
import { useGateway } from '../../gateway/useGateway'
import { parseSearchQuery } from '../../lib/search'
import { remainingMs, typingDisplayName, typingIndicatorText } from '../../lib/typing'
import type { Channel, Guild, Member, Message, SearchFilters } from '../../types'
import { SearchBar } from '../search/SearchBar'
import { SearchResults } from '../search/SearchResults'

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
  const { subscribeToMessages, subscribeToTyping, sendTyping, connected, onSessionReset } = useGateway()
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typers, setTypers] = useState<Map<string, ActiveTyper>>(new Map())

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
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null)

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

  // Load guild members when server changes (for search filters)
  useEffect(() => {
    if (!currentGuild) {
      setGuildMembers([])
      return
    }
    api.getMembers(currentGuild.id)
      .then((m) => setGuildMembers(m))
      .catch((err) => console.error('Failed to load guild members for search:', err))
  }, [currentGuild])

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

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !currentGuild || !currentChannel || sending) return

    const content = inputText.trim()
    const guildId = currentGuild.id
    const channelId = currentChannel.id

    setSending(true)
    setError(null)

    try {
      const sent = await api.sendMessage(guildId, channelId, content)
      setInputText('')
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

  const handleInputChange = (value: string) => {
    setInputText(value)
    if (value.length > 0 && currentChannel) {
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
    <div className="chat-area">
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

              return (
                <div
                  id={`msg-${msg.id}`}
                  key={msg.id}
                  className={`message-card ${isHighlighted ? 'message-highlighted' : ''}`}
                >
                  <div className="user-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
                    {msg.author?.username?.substring(0, 2).toUpperCase() ?? 'U'}
                  </div>
                  <div className="message-content-wrap">
                    <div className="message-meta">
                      <span className="message-author">{msg.author?.username ?? 'Unknown'}</span>
                      <span className="message-time">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div className="message-text">{msg.content}</div>
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
          <div className="chat-input-container">
            <form onSubmit={handleSend} className="chat-input-bar">
              <input
                type="text"
                className="chat-input"
                value={inputText}
                onChange={(e) => handleInputChange(e.target.value)}
                placeholder={`Message #${currentChannel.name}`}
                disabled={sending}
                autoFocus
              />
              <button
                type="submit"
                className="send-btn"
                disabled={sending || !inputText.trim()}
                title="Send Message"
              >
                <Send size={18} />
              </button>
            </form>
          </div>
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
