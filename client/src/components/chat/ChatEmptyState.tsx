import { useState } from 'react'
import {
  Compass,
  Hash,
  Plus,
  Sparkles,
  Volume2,
  MessageSquare,
  Shield,
  ArrowRight,
  Radio,
} from 'lucide-react'
import type { Channel, Guild } from '../../types'

interface ChatEmptyStateProps {
  currentGuild: Guild | null
  channels?: Channel[]
  guilds?: Guild[]
  onSelectChannel?: (id: string) => void
  onSelectGuild?: (id: string) => void
  onOpenCreateGuildModal?: () => void
}

export function ChatEmptyState({
  currentGuild,
  channels = [],
  guilds = [],
  onSelectChannel,
  onSelectGuild,
  onOpenCreateGuildModal,
}: ChatEmptyStateProps) {
  const [hoveredCard, setHoveredCard] = useState<string | null>(null)

  // Sub-case 1: A server IS selected, but no channel is active yet
  if (currentGuild) {
    const textChannels = channels.filter((c) => Number(c.type) === 0)
    const voiceChannels = channels.filter((c) => Number(c.type) === 2)

    return (
      <div
        className="chat-area chat-empty-state-wrap"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 24px',
          background: 'radial-gradient(ellipse at 50% 30%, rgba(255, 255, 255, 0.04) 0%, #000000 70%)',
          overflowY: 'auto',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 640, width: '100%', margin: 'auto' }}>
          {/* Server Icon Orb */}
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 24,
              background: currentGuild.icon
                ? `url(${currentGuild.icon}) center/cover`
                : 'linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.03))',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.6), 0 0 24px rgba(255, 255, 255, 0.08)',
              fontSize: 28,
              fontWeight: 800,
              color: '#ffffff',
            }}
          >
            {!currentGuild.icon && currentGuild.name.charAt(0).toUpperCase()}
          </div>

          <h2
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: '#ffffff',
              letterSpacing: '-0.02em',
              marginBottom: 10,
            }}
          >
            Welcome to {currentGuild.name}!
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--text-muted, #949ba4)',
              lineHeight: 1.6,
              maxWidth: 480,
              margin: '0 auto 28px',
            }}
          >
            Select a channel from the sidebar or click one below to jump straight into the conversation.
          </p>

          {/* Quick channel jump buttons */}
          {channels.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted, #858b94)',
                  marginBottom: 14,
                }}
              >
                Channels in this server
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10,
                  maxWidth: 580,
                  margin: '0 auto',
                }}
              >
                {textChannels.slice(0, 4).map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => onSelectChannel?.(ch.id)}
                    onMouseEnter={() => setHoveredCard(ch.id)}
                    onMouseLeave={() => setHoveredCard(null)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 14px',
                      borderRadius: 10,
                      background:
                        hoveredCard === ch.id
                          ? 'rgba(255, 255, 255, 0.1)'
                          : 'rgba(255, 255, 255, 0.04)',
                      border:
                        hoveredCard === ch.id
                          ? '1px solid rgba(255, 255, 255, 0.25)'
                          : '1px solid rgba(255, 255, 255, 0.08)',
                      color: hoveredCard === ch.id ? '#ffffff' : 'var(--text-normal, #dbdee1)',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                      transform: hoveredCard === ch.id ? 'translateY(-2px)' : 'none',
                    }}
                  >
                    <Hash size={18} style={{ color: 'var(--text-muted, #949ba4)', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {ch.name}
                    </span>
                    <ArrowRight size={14} style={{ opacity: hoveredCard === ch.id ? 1 : 0.4 }} />
                  </button>
                ))}

                {voiceChannels.slice(0, 2).map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => onSelectChannel?.(ch.id)}
                    onMouseEnter={() => setHoveredCard(ch.id)}
                    onMouseLeave={() => setHoveredCard(null)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 14px',
                      borderRadius: 10,
                      background:
                        hoveredCard === ch.id
                          ? 'rgba(255, 255, 255, 0.1)'
                          : 'rgba(255, 255, 255, 0.04)',
                      border:
                        hoveredCard === ch.id
                          ? '1px solid rgba(255, 255, 255, 0.25)'
                          : '1px solid rgba(255, 255, 255, 0.08)',
                      color: hoveredCard === ch.id ? '#ffffff' : 'var(--text-normal, #dbdee1)',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                      transform: hoveredCard === ch.id ? 'translateY(-2px)' : 'none',
                    }}
                  >
                    <Volume2 size={18} style={{ color: '#23a55a', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {ch.name}
                    </span>
                    <ArrowRight size={14} style={{ opacity: hoveredCard === ch.id ? 1 : 0.4 }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Sub-case 2: No server is currently selected
  const hasGuilds = guilds.length > 0

  return (
    <div
      className="chat-area chat-empty-state-wrap"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px',
        background: 'radial-gradient(ellipse at 50% 25%, rgba(255, 255, 255, 0.05) 0%, #000000 70%)',
        overflowY: 'auto',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 680, width: '100%', margin: 'auto' }}>
        {/* Glowing Orb Hero */}
        <div
          style={{
            position: 'relative',
            width: 88,
            height: 88,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02))',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 24px',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.8), 0 0 32px rgba(255, 255, 255, 0.12)',
            color: '#ffffff',
          }}
        >
          <Compass size={42} strokeWidth={1.75} />
          <div
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: '#ffffff',
              color: '#000000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
            }}
          >
            <Sparkles size={13} strokeWidth={2.5} />
          </div>
        </div>

        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: '#ffffff',
            letterSpacing: '-0.02em',
            marginBottom: 10,
          }}
        >
          {hasGuilds ? 'Select a Server' : 'Welcome to Kith'}
        </h1>
        <p
          style={{
            fontSize: 15,
            color: 'var(--text-muted, #949ba4)',
            lineHeight: 1.6,
            maxWidth: 480,
            margin: '0 auto 32px',
          }}
        >
          {hasGuilds
            ? 'Choose one of your servers from the left sidebar or quick-jump into one below to start chatting.'
            : 'You haven’t joined any servers yet. Create your own community to chat, talk, and hang out with friends.'}
        </p>

        {/* Action Button: Create Server if none or as primary CTA */}
        {onOpenCreateGuildModal && (
          <div style={{ marginBottom: 36 }}>
            <button
              type="button"
              onClick={onOpenCreateGuildModal}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 24px',
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                background: '#ffffff',
                color: '#090a0d',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(255, 255, 255, 0.25)',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#eaeaea'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#ffffff'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <Plus size={18} strokeWidth={2.5} />
              <span>Create a Server</span>
            </button>
          </div>
        )}

        {/* Server Quick-Switcher if user already has servers */}
        {hasGuilds && (
          <div style={{ marginBottom: 36 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-muted, #858b94)',
                marginBottom: 14,
              }}
            >
              Your Servers
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
                maxWidth: 600,
                margin: '0 auto',
              }}
            >
              {guilds.slice(0, 6).map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onSelectGuild?.(g.id)}
                  onMouseEnter={() => setHoveredCard(g.id)}
                  onMouseLeave={() => setHoveredCard(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    borderRadius: 12,
                    background:
                      hoveredCard === g.id
                        ? 'rgba(255, 255, 255, 0.08)'
                        : 'rgba(255, 255, 255, 0.03)',
                    border:
                      hoveredCard === g.id
                        ? '1px solid rgba(255, 255, 255, 0.25)'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                    color: hoveredCard === g.id ? '#ffffff' : 'var(--text-normal, #dbdee1)',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease',
                    transform: hoveredCard === g.id ? 'translateY(-2px)' : 'none',
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: g.icon
                        ? `url(${g.icon}) center/cover`
                        : 'rgba(255, 255, 255, 0.1)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 14,
                      fontWeight: 700,
                      color: '#ffffff',
                      flexShrink: 0,
                    }}
                  >
                    {!g.icon && g.name.charAt(0).toUpperCase()}
                  </div>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {g.name}
                  </span>
                  <ArrowRight size={14} style={{ opacity: hoveredCard === g.id ? 1 : 0.4 }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Feature Cards Grid (rich visual footer) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            marginTop: 16,
            textAlign: 'left',
          }}
        >
          <div
            style={{
              padding: '16px',
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: '#ffffff', fontWeight: 600, fontSize: 13 }}>
              <MessageSquare size={16} style={{ color: '#5865f2' }} />
              <span>Channels & Text</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #858b94)', lineHeight: 1.5, margin: 0 }}>
              Markdown, threads, file uploads, and reactions.
            </p>
          </div>

          <div
            style={{
              padding: '16px',
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: '#ffffff', fontWeight: 600, fontSize: 13 }}>
              <Radio size={16} style={{ color: '#23a55a' }} />
              <span>Voice & Video</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #858b94)', lineHeight: 1.5, margin: 0 }}>
              Low-latency spatial audio and screen sharing.
            </p>
          </div>

          <div
            style={{
              padding: '16px',
              borderRadius: 12,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: '#ffffff', fontWeight: 600, fontSize: 13 }}>
              <Shield size={16} style={{ color: '#f0b232' }} />
              <span>Roles & Perms</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #858b94)', lineHeight: 1.5, margin: 0 }}>
              Custom permissions and moderator tools.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
