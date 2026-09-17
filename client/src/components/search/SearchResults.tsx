import { useMemo, useRef, useEffect } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, Hash, Loader2, Search, User, X } from 'lucide-react'
import { highlightMatches } from '../../lib/search'
import { memberNameColor } from '../../lib/members'
import type { Channel, Member, Message, Role } from '../../types'
import { SearchFilterDropdown } from './SearchFilterDropdown'

interface SearchResultsProps {
  isOpen: boolean
  onClose: () => void
  query: string
  results: Message[]
  totalResults: number
  loading: boolean
  currentPage: number
  pageSize: number
  onPageChange: (page: number) => void
  channels: Channel[]
  members?: Member[]
  roles?: Role[]
  currentChannel: Channel | null
  selectedChannelId: string // '' for all channels
  onSelectChannelFilter: (channelId: string) => void
  selectedAuthorId: string // '' for all authors
  onSelectAuthorFilter: (authorId: string) => void
  onJumpToMessage: (message: Message) => void
}

function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', total]
  }
  if (current >= total - 3) {
    return [1, 'ellipsis', total - 4, total - 3, total - 2, total - 1, total]
  }
  return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', total]
}

export function SearchResults({
  isOpen,
  onClose,
  query,
  results,
  totalResults,
  loading,
  currentPage,
  pageSize,
  onPageChange,
  channels,
  members = [],
  roles = [],
  currentChannel,
  selectedChannelId,
  onSelectChannelFilter,
  selectedAuthorId,
  onSelectAuthorFilter,
  onJumpToMessage,
}: SearchResultsProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  const channelMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of channels) {
      map.set(c.id, c.name)
    }
    return map
  }, [channels])

  // Scroll to top when page changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [currentPage])

  if (!isOpen) return null

  const formatTimestamp = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return ts
    }
  }

  const selectedAuthor = members.find((m) => m.user.id === selectedAuthorId)
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize))
  const pageNumbers = getPageNumbers(currentPage, totalPages)

  return (
    <div className="search-drawer" aria-label="Search Results">
      {/* Drawer Header */}
      <div className="search-drawer-header">
        <div className="search-drawer-title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={18} style={{ color: 'var(--text-muted)' }} />
            <span className="search-drawer-title">
              {loading
                ? 'Searching...'
                : query
                  ? `${totalResults} ${totalResults === 1 ? 'Result' : 'Results'}`
                  : 'Search Messages'}
            </span>
          </div>
          <button
            type="button"
            className="search-close-btn"
            onClick={onClose}
            title="Close search"
          >
            <X size={18} />
          </button>
        </div>

        {/* Filters Section with Custom Discord Popovers */}
        <div className="search-filters-bar">
          {/* Channel Filter Dropdown */}
          <SearchFilterDropdown
            icon={<Hash size={13} />}
            value={selectedChannelId}
            placeholder="All Channels"
            options={[
              { value: '', label: 'All Channels' },
              ...channels.map((c) => ({
                value: c.id,
                label: `#${c.name}`,
                icon: <Hash size={12} />,
              })),
            ]}
            onChange={onSelectChannelFilter}
            title="Filter by channel"
          />

          {/* Author Filter Dropdown */}
          <SearchFilterDropdown
            icon={<User size={13} />}
            value={selectedAuthorId}
            placeholder="From: Anyone"
            options={[
              { value: '', label: 'From: Anyone' },
              ...members.map((m) => ({
                value: m.user.id,
                label: `@${m.user.username}`,
                icon: <User size={12} />,
              })),
            ]}
            onChange={onSelectAuthorFilter}
            title="Filter by author"
          />
        </div>

        {/* Active Filter Badges */}
        {(selectedChannelId || selectedAuthorId) && (
          <div className="search-active-tags">
            {selectedChannelId && (
              <span className="search-active-tag">
                <Hash size={11} />
                <span>{channelMap.get(selectedChannelId) || 'channel'}</span>
                <button
                  type="button"
                  onClick={() => onSelectChannelFilter('')}
                  title="Remove channel filter"
                >
                  <X size={11} />
                </button>
              </span>
            )}
            {selectedAuthorId && (
              <span className="search-active-tag">
                <User size={11} />
                <span>@{selectedAuthor?.user.username || 'user'}</span>
                <button
                  type="button"
                  onClick={() => onSelectAuthorFilter('')}
                  title="Remove author filter"
                >
                  <X size={11} />
                </button>
              </span>
            )}
            <button
              type="button"
              className="search-clear-all-btn"
              onClick={() => {
                onSelectChannelFilter('')
                onSelectAuthorFilter('')
              }}
            >
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Drawer Content */}
      <div ref={contentRef} className="search-drawer-content">
        {loading ? (
          <div className="search-state-view">
            <Loader2 size={24} className="spin" style={{ color: 'var(--brand)' }} />
            <p style={{ marginTop: 12, color: 'var(--text-muted)' }}>Searching messages...</p>
          </div>
        ) : !query ? (
          <div className="search-state-view">
            <Search size={40} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <p className="search-state-title">Search for messages</p>
            <p className="search-state-subtitle">
              Type any keyword across {selectedChannelId ? `#${channelMap.get(selectedChannelId)}` : 'the server'}.
            </p>
            <div className="search-tips">
              <span className="search-tips-header">Filter Syntax:</span>
              <span className="search-tip"><code>from:username</code> - filter by author</span>
              <span className="search-tip"><code>in:channel</code> - filter by channel</span>
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="search-state-view">
            <Search size={40} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <p className="search-state-title">No Results Found</p>
            <p className="search-state-subtitle">
              We searched all indexed messages for <strong>"{query}"</strong>, but found no matches.
            </p>
          </div>
        ) : (
          <div className="search-results-list">
            {results.map((msg) => {
              const channelName = channelMap.get(msg.channel_id) || 'channel'
              const isCurrent = currentChannel?.id === msg.channel_id
              const segments = highlightMatches(msg.content, query)

              return (
                <div
                  key={msg.id}
                  className="search-result-card"
                  onClick={() => onJumpToMessage(msg)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onJumpToMessage(msg)
                    }
                  }}
                >
                  {/* Channel Header */}
                  <div className="search-result-channel-header">
                    <span className="search-result-channel-name">
                      <Hash size={13} />
                      <span>{channelName}</span>
                      {isCurrent && <span className="search-current-badge">current</span>}
                    </span>

                    <button
                      type="button"
                      className="search-jump-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onJumpToMessage(msg)
                      }}
                      title="Jump to message in chat"
                    >
                      <span>Jump</span>
                      <ArrowRight size={13} />
                    </button>
                  </div>

                  {/* Author Meta */}
                  {(() => {
                    const authorMember = members.find((m) => m.user.id === msg.author?.id)
                    const authorColor = authorMember ? memberNameColor(authorMember, roles) : null
                    const authorName = authorMember?.nick || msg.author?.username || 'Unknown'
                    return (
                      <div className="search-result-author-row">
                        <div className="user-avatar" style={{ width: 28, height: 28, fontSize: 12 }}>
                          {msg.author?.username?.substring(0, 2).toUpperCase() ?? 'U'}
                        </div>
                        <span
                          className="search-result-author"
                          style={authorColor ? { color: authorColor } : undefined}
                        >
                          {authorName}
                        </span>
                        <span className="search-result-time">
                          {formatTimestamp(msg.timestamp)}
                        </span>
                      </div>
                    )
                  })()}

                  {/* Message Content with Highlighted Query Terms */}
                  <div className="search-result-text">
                    {segments.map((seg, i) =>
                      seg.isMatch ? (
                        <mark key={i} className="search-highlight">
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      )
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Discrete Discord-Style Page Pagination Footer */}
      {!loading && totalResults > pageSize && (
        <div className="search-pagination-footer">
          <div className="search-pagination-summary">
            Showing {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, totalResults)} of {totalResults}
          </div>
          <div className="search-pagination-nav">
            <button
              type="button"
              className="search-nav-btn"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage <= 1 || loading}
              title="Previous page"
            >
              <ChevronLeft size={16} />
            </button>

            <div className="search-page-btn-group">
              {pageNumbers.map((p, idx) =>
                p === 'ellipsis' ? (
                  <span key={`ell-${idx}`} className="search-page-ellipsis">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    className={`search-page-btn ${p === currentPage ? 'active' : ''}`}
                    onClick={() => onPageChange(p)}
                    disabled={loading || p === currentPage}
                  >
                    {p}
                  </button>
                )
              )}
            </div>

            <button
              type="button"
              className="search-nav-btn"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage >= totalPages || loading}
              title="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
