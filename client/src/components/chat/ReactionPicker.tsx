import { useEffect, useRef, useState, useMemo } from 'react'
import { Search, X, Smile, Sticker as StickerIcon } from 'lucide-react'
import type { GuildEmoji, GuildSticker } from '../../types'

export interface ServerEmojiGroup {
  guildId: string
  guildName: string
  guildIcon?: string
  emojis: GuildEmoji[]
}

export interface ServerStickerGroup {
  guildId: string
  guildName: string
  guildIcon?: string
  stickers: GuildSticker[]
}

export interface ReactionPickerProps {
  onSelectEmoji: (emoji: string) => void
  onSelectCustomEmoji?: (emoji: GuildEmoji) => void
  onSelectSticker?: (sticker: GuildSticker) => void
  onClose: () => void
  position?: { top?: number; bottom?: number; left?: number; right?: number }
  customEmojiGroups?: ServerEmojiGroup[]
  customStickerGroups?: ServerStickerGroup[]
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

export function ReactionPicker({
  onSelectEmoji,
  onSelectCustomEmoji,
  onSelectSticker,
  onClose,
  position,
  customEmojiGroups = [],
  customStickerGroups = [],
}: ReactionPickerProps) {
  const [activeTab, setActiveTab] = useState<'emojis' | 'stickers'>('emojis')
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

  const filteredStandardEmojis = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return POPULAR_EMOJIS

    return POPULAR_EMOJIS.filter((item) => {
      if (item.name.toLowerCase().includes(q)) return true
      if (item.emoji.includes(q)) return true
      return item.keywords.some((k) => k.toLowerCase().includes(q))
    })
  }, [search])

  const filteredCustomEmojiGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customEmojiGroups

    return customEmojiGroups
      .map((group) => ({
        ...group,
        emojis: group.emojis.filter((e) => e.name.toLowerCase().includes(q)),
      }))
      .filter((group) => group.emojis.length > 0)
  }, [customEmojiGroups, search])

  const filteredStickerGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customStickerGroups

    return customStickerGroups
      .map((group) => ({
        ...group,
        stickers: group.stickers.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.description && s.description.toLowerCase().includes(q))
        ),
      }))
      .filter((group) => group.stickers.length > 0)
  }, [customStickerGroups, search])

  const handlePickCustomEmoji = (emoji: GuildEmoji) => {
    if (onSelectCustomEmoji) {
      onSelectCustomEmoji(emoji)
    } else {
      // Reaction canonical format for custom emojis: name:id
      onSelectEmoji(`${emoji.name}:${emoji.id}`)
    }
    onClose()
  }

  const handlePickSticker = (sticker: GuildSticker) => {
    if (onSelectSticker) {
      onSelectSticker(sticker)
      onClose()
    }
  }

  const style: React.CSSProperties = {
    position: 'absolute',
    ...position,
  }

  const hasStickers = customStickerGroups.length > 0 && Boolean(onSelectSticker)

  return (
    <div
      ref={pickerRef}
      className="reaction-picker-popover"
      style={style}
      role="dialog"
      aria-label="Add Reaction or Emoji"
    >
      <div className="reaction-picker-header">
        {hasStickers && (
          <div className="reaction-picker-tabs">
            <button
              type="button"
              className={`reaction-picker-tab ${activeTab === 'emojis' ? 'active' : ''}`}
              onClick={() => setActiveTab('emojis')}
            >
              <Smile size={14} /> Emojis
            </button>
            <button
              type="button"
              className={`reaction-picker-tab ${activeTab === 'stickers' ? 'active' : ''}`}
              onClick={() => setActiveTab('stickers')}
            >
              <StickerIcon size={14} /> Stickers
            </button>
          </div>
        )}

        <div className="reaction-picker-search-wrap">
          <Search size={14} className="reaction-picker-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="reaction-picker-input"
            placeholder={activeTab === 'emojis' ? 'Search emoji...' : 'Search sticker...'}
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

      <div className="reaction-picker-scroll-area">
        {activeTab === 'emojis' ? (
          <>
            {/* Custom Emojis grouped by Guild */}
            {filteredCustomEmojiGroups.map((group) => (
              <div key={group.guildId} className="reaction-picker-group">
                <div className="reaction-picker-section-title guild-header">
                  <span className="guild-icon-badge">
                    {group.guildName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="guild-title-name">{group.guildName}</span>
                </div>
                <div className="reaction-picker-grid">
                  {group.emojis.map((emoji) => (
                    <button
                      key={emoji.id}
                      type="button"
                      className="reaction-picker-item custom-emoji-item"
                      title={`:${emoji.name}: (${group.guildName})`}
                      onClick={() => handlePickCustomEmoji(emoji)}
                    >
                      <img
                        src={`/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`}
                        alt={`:${emoji.name}:`}
                        className="picker-custom-emoji-img"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* Standard Unicode Emojis */}
            <div className="reaction-picker-group">
              <div className="reaction-picker-section-title">
                {search ? 'Standard Emojis' : 'Frequently Used'}
              </div>

              <div className="reaction-picker-grid">
                {filteredStandardEmojis.map((item) => (
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
              </div>
            </div>

            {filteredCustomEmojiGroups.length === 0 && filteredStandardEmojis.length === 0 && (
              <div className="reaction-picker-empty">No emojis found</div>
            )}
          </>
        ) : (
          /* Stickers Tab */
          <>
            {filteredStickerGroups.map((group) => (
              <div key={group.guildId} className="reaction-picker-group">
                <div className="reaction-picker-section-title guild-header">
                  <span className="guild-icon-badge">
                    {group.guildName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="guild-title-name">{group.guildName}</span>
                </div>
                <div className="reaction-picker-stickers-grid">
                  {group.stickers.map((sticker) => (
                    <button
                      key={sticker.id}
                      type="button"
                      className="reaction-picker-sticker-item"
                      title={sticker.description ? `${sticker.name}: ${sticker.description}` : sticker.name}
                      onClick={() => handlePickSticker(sticker)}
                    >
                      <img
                        src={`/stickers/${sticker.id}.png`}
                        alt={sticker.name}
                        className="picker-custom-sticker-img"
                        loading="lazy"
                      />
                      <span className="sticker-name-label">{sticker.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {filteredStickerGroups.length === 0 && (
              <div className="reaction-picker-empty">No stickers found</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
