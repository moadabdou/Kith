import { useState, useRef, useEffect, type FormEvent, type RefObject } from 'react'
import { AlertCircle, FileText, Loader2, Plus, Send, Smile, X } from 'lucide-react'
import type { GuildEmoji, GuildSticker, Message } from '../../types'
import type { PendingUpload } from '../../lib/uploads'
import { formatBytes } from '../../lib/uploads'
import { ReplyBar } from './ReplyBar'
import { ReactionPicker, type ServerEmojiGroup, type ServerStickerGroup } from './ReactionPicker'

function serializeEditable(element: HTMLElement): string {
  let result = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'IMG' && el.dataset.type === 'custom-emoji') {
        const isAnim = el.dataset.animated === 'true'
        const name = el.dataset.name || ''
        const id = el.dataset.id || ''
        result += isAnim ? `<a:${name}:${id}>` : `<:${name}:${id}>`
      } else if (el.tagName === 'BR') {
        result += '\n'
      } else {
        result += serializeEditable(el)
      }
    }
  }
  return result
}

function renderStringToEditable(element: HTMLElement, text: string) {
  element.innerHTML = ''
  if (!text) return

  const regex = /<(a)?:([a-zA-Z0-9_]{2,32}):([0-9]+)>/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      element.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
    }
    const animated = Boolean(match[1])
    const name = match[2]
    const id = match[3]
    const img = document.createElement('img')
    img.src = `/emojis/${id}.${animated ? 'gif' : 'png'}`
    img.alt = `:${name}:`
    img.title = `:${name}:`
    img.dataset.type = 'custom-emoji'
    img.dataset.name = name
    img.dataset.id = id
    img.dataset.animated = animated ? 'true' : 'false'
    img.className = 'chat-input-inline-emoji'
    img.contentEditable = 'false'
    img.draggable = false
    element.appendChild(img)

    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    element.appendChild(document.createTextNode(text.slice(lastIndex)))
  }
}

function insertNodeAtCursor(root: HTMLElement, node: Node) {
  root.focus()
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    range.insertNode(node)

    const space = document.createTextNode(' ')
    if (node.nextSibling) {
      root.insertBefore(space, node.nextSibling)
    } else {
      root.appendChild(space)
    }

    const newRange = document.createRange()
    newRange.setStartAfter(space)
    newRange.collapse(true)
    sel.removeAllRanges()
    sel.addRange(newRange)
  } else {
    root.appendChild(node)
    const space = document.createTextNode(' ')
    root.appendChild(space)
    const newRange = document.createRange()
    newRange.setStartAfter(space)
    newRange.collapse(true)
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(newRange)
    }
  }
}

interface MessageInputProps {
  channelName: string
  canSend: boolean
  inputText: string
  onChange: (value: string) => void
  onSend: (e: FormEvent) => void
  sending?: boolean
  canAttach: boolean
  pending: PendingUpload[]
  hasReadyUploads: boolean
  uploadsBlocked: boolean
  onPickFiles: (files: File[]) => void
  onRemovePending: (key: string) => void
  replyingTo?: Message | null
  onCancelReply?: () => void
  inputRef?: RefObject<any>
  customEmojiGroups?: ServerEmojiGroup[]
  customStickerGroups?: ServerStickerGroup[]
  onSelectSticker?: (sticker: GuildSticker) => void
}

export function MessageInput({
  channelName,
  canSend,
  inputText,
  onChange,
  onSend,
  sending = false,
  canAttach,
  pending,
  hasReadyUploads,
  uploadsBlocked,
  onPickFiles,
  onRemovePending,
  replyingTo,
  onCancelReply,
  inputRef,
  customEmojiGroups = [],
  customStickerGroups = [],
  onSelectSticker,
}: MessageInputProps) {
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  const setRef = (el: HTMLDivElement | null) => {
    (innerRef as any).current = el
    if (inputRef) {
      (inputRef as any).current = el
    }
  }

  const placeholder = canSend
    ? replyingTo
      ? `Replying to @${replyingTo.author?.username || 'Unknown'}...`
      : `Message #${channelName}`
    : 'You do not have permission to send messages in this channel'
  const canSubmit = canSend && !sending && !uploadsBlocked && (inputText.trim() !== '' || hasReadyUploads)

  useEffect(() => {
    if (!innerRef.current) return
    const currentSerialized = serializeEditable(innerRef.current)
    if (currentSerialized !== inputText) {
      renderStringToEditable(innerRef.current, inputText)
    }
  }, [inputText])

  const handleInput = () => {
    if (!innerRef.current) return
    const serialized = serializeEditable(innerRef.current)
    onChange(serialized)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSubmit) {
        onSend(e as any)
      }
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return

    const temp = document.createElement('div')
    renderStringToEditable(temp, text)

    const fragment = document.createDocumentFragment()
    while (temp.firstChild) {
      fragment.appendChild(temp.firstChild)
    }

    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && innerRef.current?.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(fragment)
    } else if (innerRef.current) {
      innerRef.current.appendChild(fragment)
    }

    handleInput()
  }

  const handleSelectEmoji = (emoji: string) => {
    if (!innerRef.current) return
    const textNode = document.createTextNode(emoji)
    insertNodeAtCursor(innerRef.current, textNode)
    const newText = serializeEditable(innerRef.current)
    onChange(newText)
    setIsEmojiPickerOpen(false)
  }

  const handleSelectCustomEmoji = (emoji: GuildEmoji) => {
    if (!innerRef.current) return
    const img = document.createElement('img')
    img.src = `/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`
    img.alt = `:${emoji.name}:`
    img.title = `:${emoji.name}:`
    img.dataset.type = 'custom-emoji'
    img.dataset.name = emoji.name
    img.dataset.id = emoji.id
    img.dataset.animated = emoji.animated ? 'true' : 'false'
    img.className = 'chat-input-inline-emoji'
    img.contentEditable = 'false'
    img.draggable = false

    insertNodeAtCursor(innerRef.current, img)
    const newText = serializeEditable(innerRef.current)
    onChange(newText)
    setIsEmojiPickerOpen(false)
  }

  return (
    <div className={`chat-input-container ${!canSend ? 'disabled' : ''} ${replyingTo ? 'has-reply-bar' : ''}`}>
      {canSend && replyingTo && onCancelReply && (
        <ReplyBar replyingTo={replyingTo} onCancel={onCancelReply} />
      )}
      {canSend && pending.length > 0 && (
        <div className="pending-uploads" aria-live="polite">
          {pending.map((p) => (
            <div key={p.key} className={`pending-upload pending-${p.state}`}>
              <FileText size={16} className="pending-upload-icon" />
              <div className="pending-upload-meta">
                <span className="pending-upload-name" title={p.filename}>
                  {p.filename}
                </span>
                <span className="pending-upload-sub">
                  {p.state === 'error' ? (
                    <span className="pending-upload-error">
                      <AlertCircle size={12} /> {p.error ?? 'Upload failed'}
                    </span>
                  ) : p.state === 'uploaded' ? (
                    formatBytes(p.size)
                  ) : (
                    `${Math.round(p.progress * 100)}% · ${formatBytes(p.size)}`
                  )}
                </span>
                {(p.state === 'presigning' || p.state === 'uploading') && (
                  <span
                    className="pending-upload-bar"
                    role="progressbar"
                    aria-valuenow={Math.round(p.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      className="pending-upload-bar-fill"
                      style={{ width: `${Math.round(p.progress * 100)}%` }}
                    />
                  </span>
                )}
              </div>
              {p.state === 'uploading' || p.state === 'presigning' ? (
                <Loader2 size={14} className="spin pending-upload-spinner" />
              ) : (
                <button
                  type="button"
                  className="pending-upload-remove"
                  onClick={() => onRemovePending(p.key)}
                  title={p.state === 'error' ? 'Dismiss' : 'Remove attachment'}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={canSend ? onSend : (e) => e.preventDefault()}
        className={`chat-input-bar ${!canSend ? 'disabled' : ''}`}
        onClick={() => innerRef.current?.focus()}
      >
        {canSend && canAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : []
                e.target.value = ''
                if (files.length > 0) onPickFiles(files)
              }}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={(e) => {
                e.stopPropagation()
                fileRef.current?.click()
              }}
              title="Upload a file"
            >
              <Plus size={18} />
            </button>
          </>
        )}
        <div className="chat-input-wrapper" style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          {!inputText && (
            <div
              className="chat-input-placeholder"
              style={{
                position: 'absolute',
                left: 0,
                color: '#72767d',
                pointerEvents: 'none',
                fontSize: 15,
                userSelect: 'none',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%',
              }}
            >
              {placeholder}
            </div>
          )}
          <div
            ref={setRef}
            contentEditable={canSend && !sending}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="chat-input"
            role="textbox"
            aria-multiline="false"
            tabIndex={canSend ? 0 : -1}
            title={!canSend ? 'You do not have permission to send messages in this channel' : undefined}
          />
        </div>
        {canSend && (
          <div className="chat-input-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`emoji-picker-btn ${isEmojiPickerOpen ? 'active' : ''}`}
              onClick={() => setIsEmojiPickerOpen((prev) => !prev)}
              title="Add Emoji or Sticker"
              aria-label="Add Emoji or Sticker"
            >
              <Smile size={18} />
            </button>
            <button
              type="submit"
              className="send-btn"
              disabled={!canSubmit}
              title={uploadsBlocked ? 'Waiting for uploads to finish' : 'Send Message'}
            >
              <Send size={18} />
            </button>
          </div>
        )}
      </form>
      {canSend && isEmojiPickerOpen && (
        <ReactionPicker
          onSelectEmoji={handleSelectEmoji}
          onSelectCustomEmoji={handleSelectCustomEmoji}
          onSelectSticker={onSelectSticker}
          onClose={() => setIsEmojiPickerOpen(false)}
          customEmojiGroups={customEmojiGroups}
          customStickerGroups={customStickerGroups}
          position={{ bottom: 65, right: 16 }}
        />
      )}
    </div>
  )
}
