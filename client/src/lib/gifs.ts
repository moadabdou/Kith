/**
 * Helper to detect and extract GIF URLs from message content.
 * Matches standard .gif files and recognized KLIPY endpoints.
 */
export function extractGifUrls(content: string): string[] {
  if (!content) return []
  // Match URLs
  const urlRegex = /https?:\/\/[^\s<>'"]+/gi
  const matches = content.match(urlRegex) || []
  const gifUrls: string[] = []

  for (const rawUrl of matches) {
    // Strip trailing punctuation often typed at the end of URLs
    const cleanUrl = rawUrl.replace(/[.,;!?)>]+$/, '')
    const lower = cleanUrl.toLowerCase()

    const isGifExtension = lower.includes('.gif')
    const isKlipy = lower.includes('klipy.com')

    if (isGifExtension || isKlipy) {
      if (!gifUrls.includes(cleanUrl)) {
        gifUrls.push(cleanUrl)
      }
    }
  }

  return gifUrls
}
