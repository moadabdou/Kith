import React, { useState } from 'react'
import type { Member, Role } from '../types'

export type ASTNode =
  | { type: 'text'; content: string }
  | { type: 'bold'; children: ASTNode[] }
  | { type: 'italic'; children: ASTNode[] }
  | { type: 'underline'; children: ASTNode[] }
  | { type: 'strikethrough'; children: ASTNode[] }
  | { type: 'code_inline'; content: string }
  | { type: 'code_block'; language?: string; content: string }
  | { type: 'blockquote'; children: ASTNode[] }
  | { type: 'spoiler'; children: ASTNode[] }
  | { type: 'link'; href: string; text: string }
  | { type: 'user_mention'; userId: string }
  | { type: 'role_mention'; roleId: string }
  | { type: 'special_mention'; mention: string }
  | { type: 'newline' }

export interface MarkdownOptions {
  members?: Member[]
  roles?: Role[]
  resolveUser?: (userId: string) => { username?: string; nick?: string } | undefined
  resolveRole?: (roleId: string) => { name?: string; color?: number | string } | undefined
}

// ── Interactive Spoiler Component ─────────────────────────────
export const Spoiler: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [revealed, setRevealed] = useState(false)

  return (
    <span
      className={`spoiler-content ${revealed ? 'is-revealed' : 'is-hidden'}`}
      role="button"
      tabIndex={0}
      title={revealed ? 'Click to hide spoiler' : 'Click to reveal spoiler'}
      aria-label={revealed ? 'Hide spoiler' : 'Show spoiler'}
      onClick={(e) => {
        e.stopPropagation()
        setRevealed((prev) => !prev)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setRevealed((prev) => !prev)
        }
      }}
    >
      <span className="spoiler-inner">{children}</span>
    </span>
  )
}

// ── Inline Rules ──────────────────────────────────────────────
interface InlineMatch {
  index: number
  length: number
  node: ASTNode
}

function findFirstInlineMatch(text: string): InlineMatch | null {
  const matches: InlineMatch[] = []

  // 1. Spoilers: ||content||
  const spoilerMatch = /\|\|([\s\S]+?)\|\|/.exec(text)
  if (spoilerMatch && spoilerMatch.index !== undefined) {
    matches.push({
      index: spoilerMatch.index,
      length: spoilerMatch[0].length,
      node: { type: 'spoiler', children: parseInline(spoilerMatch[1]) },
    })
  }

  // 2. Inline code: `code`
  const inlineCodeMatch = /`([^`\n]+)`/.exec(text)
  if (inlineCodeMatch && inlineCodeMatch.index !== undefined) {
    matches.push({
      index: inlineCodeMatch.index,
      length: inlineCodeMatch[0].length,
      node: { type: 'code_inline', content: inlineCodeMatch[1] },
    })
  }

  // 3. Bold italic: ***text***
  const boldItalicMatch = /\*\*\*([^*]+?)\*\*\*/.exec(text)
  if (boldItalicMatch && boldItalicMatch.index !== undefined) {
    matches.push({
      index: boldItalicMatch.index,
      length: boldItalicMatch[0].length,
      node: {
        type: 'bold',
        children: [{ type: 'italic', children: parseInline(boldItalicMatch[1]) }],
      },
    })
  }

  // 4. Bold: **text**
  const boldMatch = /\*\*([^*]+?)\*\*/.exec(text)
  if (boldMatch && boldMatch.index !== undefined) {
    matches.push({
      index: boldMatch.index,
      length: boldMatch[0].length,
      node: { type: 'bold', children: parseInline(boldMatch[1]) },
    })
  }

  // 5. Underline: __text__
  const underlineMatch = /__([^_]+?)__/.exec(text)
  if (underlineMatch && underlineMatch.index !== undefined) {
    matches.push({
      index: underlineMatch.index,
      length: underlineMatch[0].length,
      node: { type: 'underline', children: parseInline(underlineMatch[1]) },
    })
  }

  // 6. Italic: *text* or _text_
  const italicMatch = /(?:\*([^*]+?)\*|_([^_]+?)_)/.exec(text)
  if (italicMatch && italicMatch.index !== undefined) {
    const content = italicMatch[1] ?? italicMatch[2]
    matches.push({
      index: italicMatch.index,
      length: italicMatch[0].length,
      node: { type: 'italic', children: parseInline(content) },
    })
  }

  // 7. Strikethrough: ~~text~~
  const strikeMatch = /~~([^~]+?)~~/.exec(text)
  if (strikeMatch && strikeMatch.index !== undefined) {
    matches.push({
      index: strikeMatch.index,
      length: strikeMatch[0].length,
      node: { type: 'strikethrough', children: parseInline(strikeMatch[1]) },
    })
  }

  // 8. User mentions: <@!id> or <@id>
  const userMentionMatch = /<@!?([a-zA-Z0-9_-]+)>/.exec(text)
  if (userMentionMatch && userMentionMatch.index !== undefined) {
    matches.push({
      index: userMentionMatch.index,
      length: userMentionMatch[0].length,
      node: { type: 'user_mention', userId: userMentionMatch[1] },
    })
  }

  // 9. Role mentions: <@&id>
  const roleMentionMatch = /<@&([a-zA-Z0-9_-]+)>/.exec(text)
  if (roleMentionMatch && roleMentionMatch.index !== undefined) {
    matches.push({
      index: roleMentionMatch.index,
      length: roleMentionMatch[0].length,
      node: { type: 'role_mention', roleId: roleMentionMatch[1] },
    })
  }

  // 10. Broadcast mentions: @everyone, @here
  const specialMentionMatch = /(?:^|\s)(@(everyone|here))(?:\b|[.,!?;:])/g.exec(text)
  if (specialMentionMatch && specialMentionMatch.index !== undefined) {
    // If there is leading whitespace, adjust start index
    const leadingSpace = specialMentionMatch[0].startsWith(' ') || specialMentionMatch[0].startsWith('\t')
    const matchIndex = leadingSpace ? specialMentionMatch.index + 1 : specialMentionMatch.index
    const matchLen = specialMentionMatch[1].length
    matches.push({
      index: matchIndex,
      length: matchLen,
      node: { type: 'special_mention', mention: specialMentionMatch[1] },
    })
  }

  // 11. URLs: https://... or http://...
  const urlMatch = /https?:\/\/[^\s<>()]+(?:\([^\s<>()]+\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’])/i.exec(text)
  if (urlMatch && urlMatch.index !== undefined) {
    const rawUrl = urlMatch[0]
    // Ensure safe protocol
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      matches.push({
        index: urlMatch.index,
        length: rawUrl.length,
        node: { type: 'link', href: rawUrl, text: rawUrl },
      })
    }
  }

  if (matches.length === 0) return null

  // Return the match that occurs earliest in the string
  matches.sort((a, b) => a.index - b.index)
  return matches[0]
}

/**
 * Parses inline text tokens recursively.
 */
export function parseInline(text: string): ASTNode[] {
  if (!text) return []

  const nodes: ASTNode[] = []
  let cursor = 0

  while (cursor < text.length) {
    const slice = text.slice(cursor)
    const match = findFirstInlineMatch(slice)

    if (!match) {
      // No more tokens; append remainder as text
      const remaining = slice
      if (remaining) {
        nodes.push({ type: 'text', content: remaining })
      }
      break
    }

    if (match.index > 0) {
      nodes.push({ type: 'text', content: slice.slice(0, match.index) })
    }

    nodes.push(match.node)
    cursor += match.index + match.length
  }

  return nodes
}

/**
 * Parses multiline content with blockquotes and fenced code blocks.
 */
export function parseMarkdown(content: string): ASTNode[] {
  if (!content) return []

  const nodes: ASTNode[] = []

  // Check for multiline code blocks: ```lang\ncode\n```
  const codeBlockRegex = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index)
    if (before) {
      nodes.push(...parseBlockquotesAndText(before))
    }

    const lang = match[1]?.trim()
    const code = match[2]
    nodes.push({
      type: 'code_block',
      language: lang || undefined,
      content: code,
    })

    lastIndex = match.index + match[0].length
  }

  const remaining = content.slice(lastIndex)
  if (remaining) {
    nodes.push(...parseBlockquotesAndText(remaining))
  }

  return nodes
}

/**
 * Parses blockquotes (> quote, >>> multiline quote) and normal text lines.
 */
function parseBlockquotesAndText(text: string): ASTNode[] {
  const nodes: ASTNode[] = []
  const lines = text.split('\n')
  let quoteBuffer: string[] = []
  let isMultilineQuote = false

  const flushQuoteBuffer = () => {
    if (quoteBuffer.length > 0) {
      const quoteText = quoteBuffer.join('\n')
      nodes.push({
        type: 'blockquote',
        children: parseInline(quoteText),
      })
      quoteBuffer = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (isMultilineQuote) {
      quoteBuffer.push(line)
      continue
    }

    if (line.startsWith('>>> ')) {
      flushQuoteBuffer()
      isMultilineQuote = true
      quoteBuffer.push(line.slice(4))
      continue
    }

    if (line.startsWith('> ')) {
      quoteBuffer.push(line.slice(2))
      continue
    }

    if (line.startsWith('>') && line.length === 1) {
      quoteBuffer.push('')
      continue
    }

    // Line is not a quote
    flushQuoteBuffer()

    const inlineNodes = parseInline(line)
    nodes.push(...inlineNodes)

    // Add newline if not the last line
    if (i < lines.length - 1) {
      nodes.push({ type: 'newline' })
    }
  }

  flushQuoteBuffer()
  return nodes
}

// ── AST Renderer ──────────────────────────────────────────────
export function renderASTNode(
  node: ASTNode,
  key: string,
  options: MarkdownOptions = {}
): React.ReactNode {
  switch (node.type) {
    case 'text':
      return node.content

    case 'bold':
      return (
        <strong key={key} className="markdown-bold">
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </strong>
      )

    case 'italic':
      return (
        <em key={key} className="markdown-italic">
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </em>
      )

    case 'underline':
      return (
        <u key={key} className="markdown-underline">
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </u>
      )

    case 'strikethrough':
      return (
        <del key={key} className="markdown-strikethrough">
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </del>
      )

    case 'code_inline':
      return (
        <code key={key} className="inline-code">
          {node.content}
        </code>
      )

    case 'code_block':
      return (
        <pre key={key} className="code-block">
          <code className={node.language ? `language-${node.language}` : undefined}>
            {node.content}
          </code>
        </pre>
      )

    case 'blockquote':
      return (
        <blockquote key={key} className="discord-blockquote">
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </blockquote>
      )

    case 'spoiler':
      return (
        <Spoiler key={key}>
          {node.children.map((child, idx) => renderASTNode(child, `${key}-${idx}`, options))}
        </Spoiler>
      )

    case 'link':
      return (
        <a
          key={key}
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
          className="markdown-link"
        >
          {node.text}
        </a>
      )

    case 'user_mention': {
      let displayName: string | undefined
      if (options.resolveUser) {
        const resolved = options.resolveUser(node.userId)
        displayName = resolved?.nick || resolved?.username
      } else if (options.members) {
        const member = options.members.find((m) => m.user?.id === node.userId)
        displayName = member?.nick || member?.user?.username
      }

      const label = displayName ? `@${displayName}` : `@${node.userId}`
      return (
        <span
          key={key}
          className="mention user-mention"
          title={`User ID: ${node.userId}`}
        >
          {label}
        </span>
      )
    }

    case 'role_mention': {
      let roleName: string | undefined
      let roleColor: string | undefined

      if (options.resolveRole) {
        const resolved = options.resolveRole(node.roleId)
        roleName = resolved?.name
        if (resolved?.color) {
          roleColor = typeof resolved.color === 'number'
            ? `#${resolved.color.toString(16).padStart(6, '0')}`
            : String(resolved.color)
        }
      } else if (options.roles) {
        const role = options.roles.find((r) => r.id === node.roleId)
        roleName = role?.name
        if (role?.color) {
          roleColor = `#${role.color.toString(16).padStart(6, '0')}`
        }
      }

      const label = roleName ? `@${roleName}` : `@role-${node.roleId}`
      return (
        <span
          key={key}
          className="mention role-mention"
          style={roleColor ? { color: roleColor } : undefined}
          title={`Role ID: ${node.roleId}`}
        >
          {label}
        </span>
      )
    }

    case 'special_mention':
      return (
        <span key={key} className="mention special-mention">
          {node.mention}
        </span>
      )

    case 'newline':
      return <br key={key} />

    default:
      return null
  }
}

/**
 * Top-level MarkdownView component rendering formatted text.
 */
export const MarkdownView: React.FC<{
  content: string
  members?: Member[]
  roles?: Role[]
  resolveUser?: (userId: string) => { username?: string; nick?: string } | undefined
  resolveRole?: (roleId: string) => { name?: string; color?: number | string } | undefined
}> = ({ content, members, roles, resolveUser, resolveRole }) => {
  const ast = parseMarkdown(content)
  const options: MarkdownOptions = { members, roles, resolveUser, resolveRole }

  return (
    <span className="markdown-content">
      {ast.map((node, index) => renderASTNode(node, `md-${index}`, options))}
    </span>
  )
}
