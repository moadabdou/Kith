import { useEffect, useRef, useState, useMemo } from 'react'
import { Search, X } from 'lucide-react'

export interface ReactionPickerProps {
  onSelectEmoji: (emoji: string) => void
  onClose: () => void
  position?: { top?: number; bottom?: number; left?: number; right?: number }
}

interface EmojiEntry {
  emoji: string
  name: string
  keywords: string[]
}

const POPULAR_EMOJIS: EmojiEntry[] = [
  { emoji: '👍', name: 'thumbs up', keywords: ['+1', 'approve', 'like', 'yes', 'thumbs'] },
  { emoji: '❤️', name: 'heart', keywords: ['love', 'like', 'red heart'] },
  { emoji: '😂', name: 'joy', keywords: ['laugh', 'cry', 'tears', 'funny', 'lol', 'lmao'] },
  { emoji: '🎉', name: 'tada', keywords: ['party', 'celebrate', 'congrats', 'cheers'] },
  { emoji: '🔥', name: 'fire', keywords: ['lit', 'hot', 'burn', 'flame'] },
  { emoji: '🚀', name: 'rocket', keywords: ['ship', 'launch', 'to the moon', 'fast'] },
  { emoji: '👀', name: 'eyes', keywords: ['look', 'see', 'watch', 'peek'] },
  { emoji: '💯', name: '100', keywords: ['hundred', 'score', 'perfect', 'keep it 100'] },
  { emoji: '✨', name: 'sparkles', keywords: ['stars', 'shine', 'magic', 'clean'] },
  { emoji: '👏', name: 'clap', keywords: ['applause', 'praise', 'bravo'] },
  { emoji: '🙏', name: 'pray', keywords: ['please', 'thanks', 'hope', 'namaste'] },
  { emoji: '💀', name: 'skull', keywords: ['dead', 'dying', 'skeleton'] },
  { emoji: '💩', name: 'poop', keywords: ['poo', 'crap', 'shit'] },
  { emoji: '💪', name: 'muscle', keywords: ['flex', 'strong', 'bicep', 'arm'] },
  { emoji: '🤔', name: 'thinking', keywords: ['hmm', 'ponder', 'wonder', 'consider'] },
  { emoji: '😎', name: 'sunglasses', keywords: ['cool', 'chill'] },
  { emoji: '🥳', name: 'partying', keywords: ['celebrate', 'birthday', 'hat'] },
  { emoji: '😍', name: 'heart eyes', keywords: ['love', 'crush', 'infatuated'] },
  { emoji: '😭', name: 'sob', keywords: ['cry', 'sad', 'tears', 'bawl'] },
  { emoji: '😱', name: 'scream', keywords: ['munch', 'shock', 'omg', 'fear'] },
  { emoji: '🤯', name: 'exploding head', keywords: ['mind blown', 'shocked'] },
  { emoji: '⚡', name: 'zap', keywords: ['lightning', 'electric', 'fast'] },
  { emoji: '🎯', name: 'dart', keywords: ['target', 'bullseye', 'exact'] },
  { emoji: '💡', name: 'bulb', keywords: ['idea', 'light', 'smart'] },
  { emoji: '🤝', name: 'handshake', keywords: ['deal', 'agree', 'partner'] },
  { emoji: '🙌', name: 'raised hands', keywords: ['hooray', 'celebrate', 'yay'] },
  { emoji: '🫡', name: 'salute', keywords: ['respect', 'yes sir', 'captain'] },
  { emoji: '😴', name: 'sleeping', keywords: ['sleep', 'tired', 'zzz'] },
  { emoji: '🤩', name: 'star struck', keywords: ['stars', 'eyes', 'amazing'] },
  { emoji: '😋', name: 'yum', keywords: ['tongue', 'delicious', 'tasty'] },
  { emoji: '🥺', name: 'pleading', keywords: ['puppy eyes', 'begging'] },
  { emoji: '😈', name: 'devil', keywords: ['horns', 'evil', 'mischief'] },
]

export function ReactionPicker({ onSelectEmoji, onClose, position }: ReactionPickerProps) {
  const [search, setSearch] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus search input on mount
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

  const filteredEmojis = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return POPULAR_EMOJIS

    return POPULAR_EMOJIS.filter((item) => {
      if (item.name.toLowerCase().includes(q)) return true
      if (item.emoji.includes(q)) return true
      return item.keywords.some((k) => k.toLowerCase().includes(q))
    })
  }, [search])

  const style: React.CSSProperties = {
    position: 'absolute',
    ...position,
  }

  return (
    <div
      ref={pickerRef}
      className="reaction-picker-popover"
      style={style}
      role="dialog"
      aria-label="Add Reaction"
    >
      <div className="reaction-picker-header">
        <div className="reaction-picker-search-wrap">
          <Search size={14} className="reaction-picker-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="reaction-picker-input"
            placeholder="Search emoji..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="reaction-picker-clear-btn"
              onClick={() => setSearch('')}
              title="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="reaction-picker-section-title">
        {search ? 'Search Results' : 'Frequently Used'}
      </div>

      <div className="reaction-picker-grid">
        {filteredEmojis.map((item) => (
          <button
            key={item.emoji}
            type="button"
            className="reaction-picker-item"
            title={item.name}
            onClick={() => {
              onSelectEmoji(item.emoji)
              onClose()
            }}
          >
            <span className="reaction-picker-emoji">{item.emoji}</span>
          </button>
        ))}
        {filteredEmojis.length === 0 && (
          <div className="reaction-picker-empty">No emojis found</div>
        )}
      </div>
    </div>
  )
}
