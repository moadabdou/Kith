import { Hash, Sparkles, Volume2 } from 'lucide-react'
import type { Channel } from '../../types'

interface WelcomeHeroProps {
  channel: Channel
  empty?: boolean
}

export function WelcomeHero({ channel, empty = false }: WelcomeHeroProps) {
  const isVoice = channel.type === 2

  return (
    <div className="channel-welcome-banner" role="region" aria-label="Channel start">
      <div className="welcome-hash-circle" aria-hidden="true">
        {isVoice ? (
          <Volume2 size={38} className="welcome-icon" />
        ) : (
          <Hash size={38} className="welcome-icon" />
        )}
      </div>
      <h2 className="welcome-title">Welcome to #{channel.name}!</h2>
      <p className="welcome-subtitle">
        This is the start of the #{channel.name} channel.
      </p>
      {empty && (
        <div className="welcome-empty-hint">
          <Sparkles size={14} className="welcome-hint-sparkle" />
          <span>This channel is brand new. Send a message to start the conversation!</span>
        </div>
      )}
    </div>
  )
}
