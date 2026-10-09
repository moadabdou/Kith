import { useEffect, useRef, useState, useCallback } from 'react'
import { Search, X, Loader2 } from 'lucide-react'
import { api } from '../../api'
import type { GIFCategory, GIFItem } from '../../types'

export interface GifPickerProps {
  onSelectGif: (url: string) => void
  onClose: () => void
  position?: { top?: number; bottom?: number; left?: number; right?: number }
}

export function GifPicker({ onSelectGif, onClose, position }: GifPickerProps) {
  const [search, setSearch] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [categories, setCategories] = useState<GIFCategory[]>([])
  const [gifs, setGifs] = useState<GIFItem[]>([])
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const pickerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Auto-focus search input
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape or click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // Fetch categories on mount
  useEffect(() => {
    api.getGifCategories()
      .then((cats) => setCategories(cats || []))
      .catch((err) => console.error('Failed to load GIF categories:', err))
  }, [])

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(search.trim())
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Fetch initial/search results
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPage(1)

    const fetchPromise = debouncedQuery
      ? api.searchGifs(debouncedQuery, 1)
      : api.getTrendingGifs(1)

    fetchPromise
      .then((res) => {
        if (cancelled) return
        setGifs(res.results || [])
        setHasNext(res.has_next)
      })
      .catch((err) => {
        console.error('Failed to load GIFs:', err)
        if (!cancelled) setGifs([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [debouncedQuery])

  // Load more GIFs (infinite scroll pagination)
  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasNext) return
    setLoadingMore(true)
    const nextPage = page + 1

    const fetchPromise = debouncedQuery
      ? api.searchGifs(debouncedQuery, nextPage)
      : api.getTrendingGifs(nextPage)

    fetchPromise
      .then((res) => {
        setGifs((prev) => [...prev, ...(res.results || [])])
        setHasNext(res.has_next)
        setPage(nextPage)
      })
      .catch((err) => {
        console.error('Failed to load more GIFs:', err)
      })
      .finally(() => {
        setLoadingMore(false)
      })
  }, [debouncedQuery, hasNext, loading, loadingMore, page])

  // IntersectionObserver for infinite scrolling
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasNext || loading) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore()
        }
      },
      { root: scrollContainerRef.current, rootMargin: '120px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNext, loading, loadMore])

  return (
    <div
      ref={pickerRef}
      className="gif-picker-popover"
      style={
        position
          ? {
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              right: position.right,
            }
          : undefined
      }
      aria-label="GIF Picker"
      role="dialog"
    >
      {/* Header with Search Bar */}
      <div className="gif-picker-header">
        <div className="gif-search-bar">
          <Search size={16} className="gif-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="gif-search-input"
            placeholder="Search KLIPY..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search KLIPY GIFs"
          />
          {search && (
            <button
              type="button"
              className="gif-search-clear"
              onClick={() => {
                setSearch('')
                inputRef.current?.focus()
              }}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Suggestion / Category Chips */}
      <div className="gif-categories-bar" role="tablist" aria-label="GIF Categories">
        <button
          type="button"
          className={`gif-category-chip ${!debouncedQuery ? 'active' : ''}`}
          onClick={() => {
            setSearch('')
            setDebouncedQuery('')
          }}
          role="tab"
          aria-selected={!debouncedQuery}
        >
          Trending
        </button>
        {categories.map((cat) => {
          const isActive = debouncedQuery.toLowerCase() === cat.search_term.toLowerCase()
          return (
            <button
              key={cat.search_term}
              type="button"
              className={`gif-category-chip ${isActive ? 'active' : ''}`}
              onClick={() => {
                setSearch(cat.search_term)
                setDebouncedQuery(cat.search_term)
              }}
              role="tab"
              aria-selected={isActive}
            >
              {cat.name}
            </button>
          )
        })}
      </div>

      {/* GIF Grid / Content */}
      <div className="gif-picker-body" ref={scrollContainerRef}>
        {loading && gifs.length === 0 ? (
          <div className="gif-skeletons">
            {[140, 180, 120, 160, 190, 130, 170, 150].map((h, i) => (
              <div key={i} className="gif-skeleton-card" style={{ height: `${h}px` }} />
            ))}
          </div>
        ) : gifs.length === 0 ? (
          <div className="gif-empty-state">
            <p className="gif-empty-text">
              {debouncedQuery ? `No GIFs found for "${debouncedQuery}"` : 'No GIFs available'}
            </p>
          </div>
        ) : (
          <div className="gif-masonry-grid">
            {gifs.map((gif, idx) => (
              <GifPickerCard
                key={`${gif.id}-${idx}`}
                gif={gif}
                onSelect={(url) => {
                  onSelectGif(url)
                  onClose()
                }}
              />
            ))}
          </div>
        )}

        {/* Infinite Scroll Sentinel */}
        <div ref={sentinelRef} style={{ height: 1, width: '100%' }} />

        {/* Loading More Spinner */}
        {loadingMore && (
          <div className="gif-loading-more">
            <Loader2 size={20} className="spin" />
          </div>
        )}
      </div>
    </div>
  )
}

interface GifPickerCardProps {
  gif: GIFItem
  onSelect: (url: string) => void
}

function GifPickerCard({ gif, onSelect }: GifPickerCardProps) {
  const [loaded, setLoaded] = useState(false)

  // Calculate bounded aspect ratio to eliminate masonry layout jump
  const ratio =
    gif.width && gif.height
      ? Math.max(0.65, Math.min(2.2, gif.width / gif.height))
      : 16 / 9

  return (
    <div
      className={`gif-card ${loaded ? 'loaded' : 'loading'}`}
      style={{ aspectRatio: `${ratio}` }}
      onClick={() => onSelect(gif.url)}
      tabIndex={0}
      role="button"
      aria-label={gif.title || 'Animated GIF'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(gif.url)
        }
      }}
    >
      {!loaded && (
        <div className="gif-card-placeholder">
          <div className="gif-card-shimmer" />
        </div>
      )}
      <img
        src={gif.preview_url || gif.url}
        alt={gif.title || 'GIF'}
        className={`gif-img ${loaded ? 'loaded' : ''}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
      {gif.title && <div className="gif-overlay">{gif.title}</div>}
    </div>
  )
}
