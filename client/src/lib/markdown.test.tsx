import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView } from './markdown'
import type { Member, Role } from '../types'

describe('Discord AST Markdown Parser', () => {
  it('parses basic inline formatting: bold, italic, underline, strikethrough', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content="**bold** and *italic* and __underline__ and ~~strike~~" />
    )

    expect(html).toContain('<strong class="markdown-bold">bold</strong>')
    expect(html).toContain('<em class="markdown-italic">italic</em>')
    expect(html).toContain('<u class="markdown-underline">underline</u>')
    expect(html).toContain('<del class="markdown-strikethrough">strike</del>')
  })

  it('parses inline code and preserves literal contents without parsing inner tags', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content="Here is `**not bold** and *not italic*` code" />
    )

    expect(html).toContain('<code class="inline-code">**not bold** and *not italic*</code>')
    expect(html).not.toContain('<strong')
    expect(html).not.toContain('<em')
  })

  it('parses fenced code blocks with language and preserves whitespace and newlines', () => {
    const code = '```typescript\nfunction hello() {\n  return "world"\n}\n```'
    const html = renderToStaticMarkup(<MarkdownView content={code} />)

    expect(html).toContain('<pre class="code-block">')
    expect(html).toContain('<code class="language-typescript">')
    expect(html).toContain('function hello() {\n  return &quot;world&quot;\n}')
  })

  it('parses single-line and multi-line blockquotes', () => {
    const singleQuote = '> This is a single quote\nNormal text'
    const html1 = renderToStaticMarkup(<MarkdownView content={singleQuote} />)
    expect(html1).toContain('<blockquote class="discord-blockquote">This is a single quote</blockquote>')
    expect(html1).toContain('Normal text')

    const multiQuote = '>>> Line one\nLine two of quote'
    const html2 = renderToStaticMarkup(<MarkdownView content={multiQuote} />)
    expect(html2).toContain('<blockquote class="discord-blockquote">')
    expect(html2).toContain('Line one\nLine two of quote')
  })

  it('renders interactive spoilers masked by default', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content="Movie ending: ||the butler did it||" />
    )

    expect(html).toContain('spoiler-content is-hidden')
    expect(html).toContain('the butler did it')
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-label="Show spoiler"')
  })

  it('supports nested markdown inside spoilers', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content="Top secret: ||**bold secret** and ~~strike~~||" />
    )

    expect(html).toContain('spoiler-content is-hidden')
    expect(html).toContain('<strong class="markdown-bold">bold secret</strong>')
    expect(html).toContain('<del class="markdown-strikethrough">strike</del>')
  })

  it('safely auto-links http/https URLs with rel="noreferrer noopener" and target="_blank"', () => {
    const html = renderToStaticMarkup(
      <MarkdownView content="Check out https://github.com/moadabdou/Kith now!" />
    )

    expect(html).toContain(
      '<a href="https://github.com/moadabdou/Kith" target="_blank" rel="noreferrer noopener" class="markdown-link">https://github.com/moadabdou/Kith</a>'
    )
  })

  it('resolves user and role mentions', () => {
    const mockMembers: Member[] = [
      {
        user: { id: 'u100', username: 'alice', discriminator: '0001' },
        nick: 'AliceInWonderland',
        roles: [],
        joined_at: '',
      },
    ]

    const mockRoles: Role[] = [
      {
        id: 'r200',
        guild_id: 'g1',
        name: 'Moderator',
        color: 0x5865f2,
        position: 1,
        permissions: '0',
        hoist: false,
        mentionable: true,
        created_at: '',
      },
    ]

    const html = renderToStaticMarkup(
      <MarkdownView
        content="Pinging <@u100> and role <@&r200> plus @everyone"
        members={mockMembers}
        roles={mockRoles}
      />
    )

    expect(html).toContain('@AliceInWonderland')
    expect(html).toContain('mention user-mention')
    expect(html).toContain('@Moderator')
    expect(html).toContain('mention role-mention')
    expect(html).toContain('color:#5865f2')
    expect(html).toContain('@everyone')
    expect(html).toContain('mention special-mention')
  })

  it('prevents XSS attacks by escaping raw HTML tags into text nodes', () => {
    const malicious = '<script>alert("pwned")</script><img src=x onerror=alert(1)>'
    const html = renderToStaticMarkup(<MarkdownView content={malicious} />)

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;')
  })

  it('parses custom emojis <:name:id> and animated emojis <a:name:id>', () => {
    const content = 'Look at this <:pepe:1234567890> and animated <a:party_parrot:9876543210>!'
    const html = renderToStaticMarkup(<MarkdownView content={content} />)

    expect(html).toContain('src="/emojis/1234567890.png"')
    expect(html).toContain('alt=":pepe:"')
    expect(html).toContain('title=":pepe:"')
    expect(html).toContain('class="chat-custom-emoji"')

    expect(html).toContain('src="/emojis/9876543210.gif"')
    expect(html).toContain('alt=":party_parrot:"')
    expect(html).toContain('title=":party_parrot:"')
  })

  it('supports custom emojis inside bold formatting', () => {
    const content = '**<:pepe:1234567890>**'
    const html = renderToStaticMarkup(<MarkdownView content={content} />)

    expect(html).toContain('<strong class="markdown-bold">')
    expect(html).toContain('src="/emojis/1234567890.png"')
  })
})
