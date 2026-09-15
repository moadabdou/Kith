/**
 * Splits text into segments marking which parts match the search query (case-insensitive).
 */
export interface HighlightSegment {
  text: string
  isMatch: boolean
}

export function highlightMatches(text: string, query: string): HighlightSegment[] {
  if (!text) return []
  const trimmed = query.trim()
  if (!trimmed) {
    return [{ text, isMatch: false }]
  }

  const rawWords = trimmed.split(/\s+/).filter(Boolean)
  if (rawWords.length === 0) {
    return [{ text, isMatch: false }]
  }

  const escapedWords = rawWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escapedWords.join('|')})`, 'gi')
  const parts = text.split(regex)

  const segments: HighlightSegment[] = []
  for (const part of parts) {
    if (!part) continue
    const isMatch = rawWords.some((w) => part.toLowerCase() === w.toLowerCase())
    segments.push({ text: part, isMatch })
  }

  return segments
}

export interface ParsedSearchQuery {
  text: string
  from?: string
  in?: string
}

/**
 * Extracts inline filter tokens (from:user, in:channel) from search query.
 */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  let text = input
  let from: string | undefined
  let inChannel: string | undefined

  // Match from:username or from:"user name" or from:@username
  const fromRegex = /\bfrom:(?:"([^"]+)"|@?(\S+))/i
  const fromMatch = text.match(fromRegex)
  if (fromMatch) {
    from = (fromMatch[1] || fromMatch[2]).toLowerCase()
    text = text.replace(fromMatch[0], ' ')
  }

  // Match in:channel or in:"channel name" or in:#channel
  const inRegex = /\bin:(?:"([^"]+)"|#?(\S+))/i
  const inMatch = text.match(inRegex)
  if (inMatch) {
    inChannel = (inMatch[1] || inMatch[2]).toLowerCase()
    text = text.replace(inMatch[0], ' ')
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    from,
    in: inChannel,
  }
}
