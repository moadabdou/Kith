import { useState, useRef, useEffect, useMemo, type FormEvent, type RefObject } from 'react'
import { AlertCircle, FileText, Loader2, Plus, Send, Smile, X } from 'lucide-react'
import type { GuildEmoji, GuildSticker, Message } from '../../types'
import type { PendingUpload } from '../../lib/uploads'
import { formatBytes } from '../../lib/uploads'
import {
  cycleIndex,
  extractMentionQuery,
  rankSuggestions,
  splitMentionChunks,
  suggestionInsertText,
  type MentionSuggestion,
  type SuggestMember,
  type SuggestRole,
} from '../../lib/mentionSuggest'
import { ReplyBar } from './ReplyBar'
import { ReactionPicker, type ServerEmojiGroup, type ServerStickerGroup } from './ReactionPicker'
import { GifPicker } from './GifPicker'

export type { SuggestMember, SuggestRole }

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
      } else if (el.tagName === 'SPAN' && el.dataset.mentionKind) {
        // Accepted @-mention (Issue #123): plain tinted text in the composer,
        // wire syntax in the content.
        const kind = el.dataset.mentionKind
        const id = el.dataset.mentionId || ''
        if (kind === 'user' && id) result += `<@${id}>`
        else if (kind === 'role' && id) result += `<@&${id}>`
        else if (kind === 'everyone') result += '@everyone'
        else if (kind === 'here') result += '@here'
        else result += el.textContent || ''
      } else if (el.tagName === 'BR') {
        result += '\n'
      } else {
        result += serializeEditable(el)
      }
    }
  }
  return result
}

/** Builds a composer mention node: tinted plain text, atomic, syntax-backed. */
export function buildMentionNode(s: MentionSuggestion): HTMLElement {
  const span = document.createElement('span')
  span.dataset.mentionKind = s.kind
  if (s.kind === 'user' || s.kind === 'role') {
    span.dataset.mentionId = s.id
  }
  span.textContent = suggestionInsertText(s)
  span.className = 'chat-input-mention'
  span.contentEditable = 'false'
  return span
}

export interface MentionLabelResolver {
  userLabel?: (id: string) => string | undefined
  roleLabel?: (id: string) => string | undefined
}

function appendMentionNode(
  parent: HTMLElement,
  kind: 'user' | 'role',
  id: string,
  label: string | undefined,
  raw: string,
) {
  if (label === undefined) {
    // Unknown id (or no resolver): keep raw syntax as text so the
    // serialize round-trip stays exact.
    parent.appendChild(document.createTextNode(raw))
    return
  }
  const span = document.createElement('span')
  span.dataset.mentionKind = kind
  span.dataset.mentionId = id
  span.textContent = label
  span.className = 'chat-input-mention'
  span.contentEditable = 'false'
  parent.appendChild(span)
}

function renderStringToEditable(
  element: HTMLElement,
  text: string,
  resolveMention?: MentionLabelResolver,
) {
  element.innerHTML = ''
  if (!text) return

  const regex = /<(a)?:([a-zA-Z0-9_]{2,32}):([0-9]+)>/g

  // Mentions first: split text into mention/non-mention chunks, then run
  // the legacy emoji pass over the non-mention chunks.
  const chunks = splitMentionChunks(text)
  const effective = chunks.length > 0 ? chunks : [{ text }]

  const renderEmojiPass = (parent: HTMLElement, chunk: string) => {
    regex.lastIndex = 0
    let idx = 0
    let em: RegExpExecArray | null
    while ((em = regex.exec(chunk)) !== null) {
      if (em.index > idx) {
        parent.appendChild(document.createTextNode(chunk.slice(idx, em.index)))
      }
      const animated = Boolean(em[1])
      const name = em[2]
      const id = em[3]
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
      parent.appendChild(img)
      idx = regex.lastIndex
    }
    if (idx < chunk.length) {
      parent.appendChild(document.createTextNode(chunk.slice(idx)))
    }
  }

  for (const chunk of effective) {
    if (chunk.mention) {
      const { kind, id, raw } = chunk.mention
      const label =
        kind === 'user' ? resolveMention?.userLabel?.(id) : resolveMention?.roleLabel?.(id)
      appendMentionNode(element, kind, id, label, raw)
    } else {
      renderEmojiPass(element, chunk.text)
    }
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
  onSendGif?: (url: string) => void
  // Mention autocomplete (Issue #123). When omitted/empty the popover never opens.
  mentionMembers?: SuggestMember[]
  mentionRoles?: SuggestRole[]
  canMentionEveryone?: boolean
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
  onSendGif,
  mentionMembers = [],
  mentionRoles = [],
  canMentionEveryone = false,
}: MessageInputProps) {
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false)
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false)
  // Mention autocomplete state (Issue #123): the active @-query (null when
  // the caret is not inside a trigger), the highlighted index, and the
  // popover anchor relative to the input wrapper.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionPos, setMentionPos] = useState<{ left: number; top: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

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
      renderStringToEditable(innerRef.current, inputText, mentionResolver)
    }
  }, [inputText])

  // Display-name lookup for re-rendering accepted mentions from stored
  // syntax (edits, drafts, external changes). Unknown ids fall back to raw
  // syntax text so the serialize round-trip stays exact.
  const mentionResolver: MentionLabelResolver = {
    userLabel: (id) => {
      const m = mentionMembers.find((mm) => String(mm.id) === String(id))
      if (!m) return undefined
      return `@${m.nick || m.username}`
    },
    roleLabel: (id) => {
      const r = mentionRoles.find((rr) => String(rr.id) === String(id))
      if (!r) return undefined
      return `@${r.name}`
    },
  }

  const mentionSuggestions = useMemo(
    () => (mentionQuery === null ? [] : rankSuggestions(mentionQuery, mentionMembers, mentionRoles, canMentionEveryone)),
    [mentionQuery, mentionMembers, mentionRoles, canMentionEveryone],
  )

  // Caret-relative helpers for the autocomplete trigger.
  const textBeforeCaret = (): string | null => {
    const root = innerRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
    if (!root.contains(sel.anchorNode)) return null
    const caret = sel.getRangeAt(0)
    const probe = caret.cloneRange()
    probe.selectNodeContents(root)
    try {
      probe.setEnd(caret.endContainer, caret.endOffset)
    } catch {
      return null
    }
    return probe.toString()
  }

  const updateMentionQuery = () => {
    if (!canSend) {
      setMentionQuery(null)
      return
    }
    const before = textBeforeCaret()
    const query = before === null ? null : extractMentionQuery(before)
    setMentionQuery(query)
    if (query === null) {
      setMentionPos(null)
      return
    }
    // Anchor the popover at the caret.
    const sel = window.getSelection()
    const wrapper = wrapperRef.current
    if (sel && sel.rangeCount > 0 && wrapper) {
      const caretRect = sel.getRangeAt(0).getBoundingClientRect()
      const wrapRect = wrapper.getBoundingClientRect()
      if (caretRect.width >= 0) {
        setMentionPos({
          left: Math.max(0, Math.min(caretRect.left - wrapRect.left, wrapRect.width - 40)),
          top: caretRect.top - wrapRect.top,
        })
      }
    }
  }

  const closeMentionPopover = () => {
    setMentionQuery(null)
    setMentionIndex(0)
    setMentionPos(null)
  }

  // Reset the highlighted index whenever the query (or list) changes.
  useEffect(() => {
    setMentionIndex(0)
  }, [mentionQuery])

  // Sending clears the input: drop any stale trigger with it.
  useEffect(() => {
    if (!inputText) {
      setMentionQuery(null)
      setMentionPos(null)
    }
  }, [inputText])

  const acceptMention = (s: MentionSuggestion) => {
    const root = innerRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const caret = sel.getRangeAt(0)
    const container = caret.endContainer
    if (container.nodeType !== Node.TEXT_NODE || !root.contains(container)) return

    // Collect contiguous text backwards across text-node siblings (typing
    // may split nodes), then locate the "@query" tail.
    let tail = ''
    const nodes: Text[] = []
    let node: Node | null = container
    while (node && node !== root && tail.length < 44) {
      if (node.nodeType !== Node.TEXT_NODE) break
      const chunk =
        node === container
          ? (node.textContent ?? '').slice(0, caret.endOffset)
          : (node.textContent ?? '')
      tail = chunk + tail
      nodes.unshift(node as Text)
      node = previousTextishSibling(node, root)
    }
    const tailMatch = /(?:^|\s)@([A-Za-z0-9_]{0,32})$/.exec(tail)
    if (!tailMatch || nodes.length === 0) return

    // Delete exactly "@query" (not a preceding space): walk back from the
    // caret across the collected nodes.
    let remaining = tailMatch[0].startsWith('@') ? tailMatch[0].length : tailMatch[0].length - 1
    let startNode: Node = container
    let startOffset = caret.endOffset
    for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
      const n = nodes[i]
      const avail = i === nodes.length - 1 ? caret.endOffset : (n.textContent ?? '').length
      if (avail >= remaining) {
        startNode = n
        startOffset = avail - remaining
        remaining = 0
      } else {
        remaining -= avail
      }
    }
    if (remaining > 0) return

    const range = document.createRange()
    try {
      range.setStart(startNode, Math.max(0, startOffset))
      range.setEnd(container, caret.endOffset)
    } catch {
      return
    }
    range.deleteContents()

    const pill = buildMentionNode(s)
    range.insertNode(pill)
    const space = document.createTextNode(' ')
    if (pill.nextSibling) {
      root.insertBefore(space, pill.nextSibling)
    } else {
      root.appendChild(space)
    }
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)

    closeMentionPopover()
    handleInput()
    root.focus()
  }

  // Previous sibling that can carry typed text (skip atomic pills/emoji).
  function previousTextishSibling(n: Node, root: HTMLElement): Node | null {
    let sib = n.previousSibling
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE) return sib
      if (sib.nodeType === Node.ELEMENT_NODE) {
        const el = sib as HTMLElement
        if (el.dataset.mentionKind || el.dataset.type === 'custom-emoji' || el.contentEditable === 'false') {
          return null
        }
        // Recurse into the last text descendant of a plain element.
        let deep: Node | null = el.lastChild
        while (deep && deep.nodeType !== Node.TEXT_NODE) {
          deep = deep.lastChild
        }
        if (deep) return deep
        return null
      }
      sib = sib.previousSibling
    }
    // Cross element boundaries (e.g. nested formatting) one level up.
    const parent = n.parentNode
    if (parent && parent !== root) return previousTextishSibling(parent, root)
    return null
  }

  const handleInput = () => {
    if (!innerRef.current) return
    const serialized = serializeEditable(innerRef.current)
    onChange(serialized)
    updateMentionQuery()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Mention popover takes over navigation keys while open with results.
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) =>
          cycleIndex(prev, e.key === 'ArrowDown' ? 1 : -1, mentionSuggestions.length),
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const target =
          mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]
        if (target) acceptMention(target)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMentionPopover()
        return
      }
    } else if (e.key === 'Escape' && mentionQuery !== null) {
      e.preventDefault()
      closeMentionPopover()
      return
    }
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
    renderStringToEditable(temp, text, mentionResolver)

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
        <div ref={wrapperRef} className="chat-input-wrapper" style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          {mentionQuery !== null && mentionSuggestions.length > 0 && (
            <div
              className="mention-suggest-pop"
              role="listbox"
              aria-label="Mention suggestions"
              style={
                mentionPos
                  ? { left: mentionPos.left, bottom: `calc(100% - ${mentionPos.top}px)` }
                  : undefined
              }
            >
              {mentionSuggestions.map((s, i) => {
                const key = `${s.kind}:${s.id}`
                const activeCls = i === Math.min(mentionIndex, mentionSuggestions.length - 1) ? 'active' : ''
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={i === mentionIndex}
                    className={`mention-suggest-item ${activeCls}`}
                    // mousedown fires before blur so the caret is still valid.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      acceptMention(s)
                    }}
                  >
                    <span className={`mention-suggest-kind kind-${s.kind}`}>{s.kind}</span>
                    <span className="mention-suggest-label">{s.label}</span>
                    {'sub' in s && s.sub && <span className="mention-suggest-sub">{s.sub}</span>}
                  </button>
                )
              })}
            </div>
          )}
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
            onSelect={updateMentionQuery}
            onClick={updateMentionQuery}
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
              className={`gif-picker-btn ${isGifPickerOpen ? 'active' : ''}`}
              onClick={() => {
                setIsGifPickerOpen((prev) => !prev)
                setIsEmojiPickerOpen(false)
              }}
              title="Open GIF Picker"
              aria-label="Open GIF Picker"
            >
              <span className="gif-badge">GIF</span>
            </button>
            <button
              type="button"
              className={`emoji-picker-btn ${isEmojiPickerOpen ? 'active' : ''}`}
              onClick={() => {
                setIsEmojiPickerOpen((prev) => !prev)
                setIsGifPickerOpen(false)
              }}
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
      {canSend && isGifPickerOpen && (
        <GifPicker
          onSelectGif={(url) => {
            setIsGifPickerOpen(false)
            if (onSendGif) {
              onSendGif(url)
            } else {
              onChange(inputText ? `${inputText} ${url}` : url)
            }
          }}
          onClose={() => setIsGifPickerOpen(false)}
          position={{ bottom: 65, right: 16 }}
        />
      )}
    </div>
  )
}
