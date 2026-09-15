import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'

interface SearchBarProps {
  query: string
  onChange: (query: string) => void
  onOpenDrawer: () => void
  channelName?: string
}

export function SearchBar({ query, onChange, onOpenDrawer, channelName }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Global shortcut Ctrl+F / Cmd+F to focus search bar & open drawer
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        onOpenDrawer()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onOpenDrawer])

  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      inputRef.current?.blur()
    }
  }

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  return (
    <div className="search-bar-wrap">
      <input
        ref={inputRef}
        type="text"
        className="search-bar-input"
        placeholder={channelName ? `Search #${channelName}` : 'Search'}
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={onOpenDrawer}
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
    </div>
  )
}
