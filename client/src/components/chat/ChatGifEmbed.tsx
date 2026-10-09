import { useState } from 'react'

export interface ChatGifEmbedProps {
  url: string
  onMediaLoad?: () => void
}

export function ChatGifEmbed({ url, onMediaLoad }: ChatGifEmbedProps) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  return (
    <div className="chat-gif-embed">
      {!loaded && !error && (
        <div className="chat-gif-placeholder" aria-label="Loading GIF">
          <div className="chat-gif-placeholder-shimmer" />
          <span className="chat-gif-badge">GIF</span>
        </div>
      )}
      {error ? (
        <div className="chat-gif-error">
          <span className="chat-gif-badge">GIF</span>
          <span className="chat-gif-error-text">Failed to load GIF</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="chat-gif-error-link">
            Open URL
          </a>
        </div>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt="GIF"
            loading="lazy"
            className={`chat-gif-img ${loaded ? 'loaded' : 'loading'}`}
            onLoad={() => {
              setLoaded(true)
              onMediaLoad?.()
            }}
            onError={() => {
              setError(true)
            }}
          />
        </a>
      )}
    </div>
  )
}
