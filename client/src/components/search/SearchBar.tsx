import { useEffect, useRef, useState, useMemo, type ChangeEvent, type KeyboardEvent } from 'react'
import { FileText, Hash, Pin, Search, User, X } from 'lucide-react'
import type { Channel, Member } from '../../types'

interface SearchBarProps {
  query: string
  onChange: (query: string) => void
  onOpenDrawer: () => void
  channelName?: string
  members?: Member[]
  channels?: Channel[]
}

export function SearchBar({
  query,
  onChange,
  onOpenDrawer,
  channelName,
  members = [],
  channels = [],
}: SearchBarProps) {
  const [isFocused, setIsFocused] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Global shortcut Ctrl+F / Cmd+F to focus search bar & open drawer
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setIsFocused(true)
        onOpenDrawer()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onOpenDrawer])

  // Dismiss suggestions when clicking outside wrapRef
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setIsFocused(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  // Check if current query is typing a specific filter
  const fromMatch = query.match(/(?:^|\s)from:([^\s]*)$/i)
  const inMatch = query.match(/(?:^|\s)in:([^\s]*)$/i)

  const suggestionMode = fromMatch ? 'users' : inMatch ? 'channels' : 'options'

  // Filter members when in 'users' mode
  const filteredMembers = useMemo(() => {
    if (!fromMatch) return []
    const val = (fromMatch[1] || '').toLowerCase()
    return members
      .filter((m) => {
        const u = m.user.username.toLowerCase()
        const n = m.nick?.toLowerCase() || ''
        return u.includes(val) || n.includes(val)
      })
      .slice(0, 8)
  }, [fromMatch, members])

  // Filter channels when in 'channels' mode
  const filteredChannels = useMemo(() => {
    if (!inMatch) return []
    const val = (inMatch[1] || '').toLowerCase()
    return channels
      .filter((c) => c.name.toLowerCase().includes(val))
      .slice(0, 8)
  }, [inMatch, channels])

  // Standard filter options
  const defaultOptions = useMemo(
    () => [
      { prefix: 'from:', label: 'from:', desc: 'user', icon: <User size={13} /> },
      { prefix: 'in:', label: 'in:', desc: 'channel', icon: <Hash size={13} /> },
      { prefix: 'has:', label: 'has:', desc: 'link, embed, or file', icon: <FileText size={13} /> },
      { prefix: 'pinned:', label: 'pinned:', desc: 'true or false', icon: <Pin size={13} /> },
    ],
    []
  )

  // Total items in current mode for keyboard navigation
  const currentCount =
    suggestionMode === 'users'
      ? filteredMembers.length
      : suggestionMode === 'channels'
      ? filteredChannels.length
      : defaultOptions.length

  // Reset selectedIndex whenever mode or filtered items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [suggestionMode, filteredMembers.length, filteredChannels.length])

  const selectMember = (m: Member) => {
    const replaced = query.replace(/(?:^|\s)from:[^\s]*$/i, (match) => {
      const leadingSpace = match.startsWith(' ') ? ' ' : ''
      return `${leadingSpace}from:${m.user.username} `
    })
    onChange(replaced)
    onOpenDrawer()
    inputRef.current?.focus()
  }

  const selectChannel = (c: Channel) => {
    const replaced = query.replace(/(?:^|\s)in:[^\s]*$/i, (match) => {
      const leadingSpace = match.startsWith(' ') ? ' ' : ''
      return `${leadingSpace}in:${c.name} `
    })
    onChange(replaced)
    onOpenDrawer()
    inputRef.current?.focus()
  }

  const selectOption = (opt: (typeof defaultOptions)[0]) => {
    const newQuery = query.trim() ? `${query.trim()} ${opt.prefix}` : opt.prefix
    onChange(newQuery)
    onOpenDrawer()
    inputRef.current?.focus()
  }

  const acceptCurrent = () => {
    if (suggestionMode === 'users' && filteredMembers[selectedIndex]) {
      selectMember(filteredMembers[selectedIndex])
    } else if (suggestionMode === 'channels' && filteredChannels[selectedIndex]) {
      selectChannel(filteredChannels[selectedIndex])
    } else if (suggestionMode === 'options' && defaultOptions[selectedIndex]) {
      selectOption(defaultOptions[selectedIndex])
    }
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isFocused && currentCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % currentCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (prev - 1 + currentCount) % currentCount)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (suggestionMode === 'users' || suggestionMode === 'channels') {
          e.preventDefault()
          acceptCurrent()
          return
        }
      }
    }

    if (e.key === 'Escape') {
      setIsFocused(false)
      inputRef.current?.blur()
    }
  }

  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  return (
    <div className="search-bar-wrap" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className="search-bar-input"
        placeholder={channelName ? `Search #${channelName}` : 'Search'}
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          onChange(e.target.value)
          setIsFocused(true)
        }}
        onFocus={() => {
          setIsFocused(true)
          onOpenDrawer()
        }}
        onKeyDown={handleInputKeyDown}
      />
      {query ? (
        <button
          type="button"
          className="search-bar-btn"
          onClick={handleClear}
          title="Clear search"
        >
          <X size={14} />
        </button>
      ) : (
        <div className="search-bar-right">
          <kbd className="search-bar-kbd">{isMac ? '⌘F' : 'Ctrl+F'}</kbd>
          <Search size={16} className="search-bar-icon" />
        </div>
      )}

      {/* Autocomplete & Filter Suggestions Popover */}
      {isFocused && (
        <div className="search-suggestions-popover" role="listbox">
          {suggestionMode === 'users' && (
            <>
              <div className="search-suggestions-header">Search By User</div>
              <div className="search-suggestions-list">
                {filteredMembers.length === 0 ? (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                    No members found
                  </div>
                ) : (
                  filteredMembers.map((m, idx) => {
                    const isActive = idx === selectedIndex
                    const displayName = m.nick || m.user.username
                    const initials = (displayName[0] || '?').toUpperCase()
                    return (
                      <button
                        type="button"
                        key={m.user.id}
                        role="option"
                        aria-selected={isActive}
                        className={`search-suggestion-item ${isActive ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          selectMember(m)
                        }}
                      >
                        <span className="search-suggestion-avatar-fallback">{initials}</span>
                        <div className="search-suggestion-info">
                          <span className="search-suggestion-name">{displayName}</span>
                          <span className="search-suggestion-sub">@{m.user.username}</span>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}

          {suggestionMode === 'channels' && (
            <>
              <div className="search-suggestions-header">Search In Channel</div>
              <div className="search-suggestions-list">
                {filteredChannels.length === 0 ? (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                    No channels found
                  </div>
                ) : (
                  filteredChannels.map((c, idx) => {
                    const isActive = idx === selectedIndex
                    return (
                      <button
                        type="button"
                        key={c.id}
                        role="option"
                        aria-selected={isActive}
                        className={`search-suggestion-item ${isActive ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          selectChannel(c)
                        }}
                      >
                        <div className="search-suggestion-icon">
                          <Hash size={14} />
                        </div>
                        <div className="search-suggestion-info">
                          <span className="search-suggestion-name">#{c.name}</span>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}

          {suggestionMode === 'options' && (
            <>
              <div className="search-suggestions-header">Search Options</div>
              <div className="search-suggestions-list">
                {defaultOptions.map((opt, idx) => {
                  const isActive = idx === selectedIndex
                  return (
                    <button
                      type="button"
                      key={opt.prefix}
                      role="option"
                      aria-selected={isActive}
                      className={`search-suggestion-item ${isActive ? 'active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        selectOption(opt)
                      }}
                    >
                      <span className="search-suggestion-pill">{opt.label}</span>
                      <span className="search-suggestion-desc">{opt.desc}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
