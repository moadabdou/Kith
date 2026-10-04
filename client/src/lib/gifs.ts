/**
 * Helper to detect and extract GIF URLs from message content.
 * Matches standard .gif files, recognized KLIPY endpoints, and local fallback paths.
 */
export function extractGifUrls(content: string): string[] {
  if (!content) return []
  // Match absolute URLs or root-relative paths
  const tokenRegex = /(https?:\/\/[^\s<>'"]+|\/(?:api\/gifs|gifs)\/[^\s<>'"]+)/gi
  const matches = content.match(tokenRegex) || []
  const gifUrls: string[] = []

  for (const rawUrl of matches) {
    // Strip trailing punctuation often typed at the end of URLs
    const cleanUrl = rawUrl.replace(/[.,;!?)>]+$/, '')
    const lower = cleanUrl.toLowerCase()

    const isGifExtension = lower.includes('.gif')
    const isKlipy = lower.includes('klipy.com')
    const isLocalGif = lower.startsWith('/api/gifs/') || lower.startsWith('/gifs/')

    if (isGifExtension || isKlipy || isLocalGif) {
      if (!gifUrls.includes(cleanUrl)) {
        gifUrls.push(cleanUrl)
      }
    }
  }

  return gifUrls
}
