import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, Hash, Send } from 'lucide-react'
import { api } from '../../api'
import type { Channel, Guild, Message } from '../../types'

import { useGateway } from '../../gateway/useGateway'

interface ChatAreaProps {
  currentGuild: Guild | null
  currentChannel: Channel | null
}

export function ChatArea({ currentGuild, currentChannel }: ChatAreaProps) {
  const { subscribeToMessages, connected, onSessionReset } = useGateway()
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = (smooth = false) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
  }

  // Fetch initial message history on channel change
  useEffect(() => {
    if (!currentGuild || !currentChannel) {
      return
    }

    const guildId = currentGuild.id
    const channelId = currentChannel.id
    let active = true

    api.getMessages(guildId, channelId)
      .then((msgs) => {
        if (!active) return
        setMessages([...msgs].reverse())
        setError(null)
      })
      .catch((err: any) => {
        if (!active) return
        setError(err.message || 'Failed to fetch messages')
      })

    return () => {
      active = false
    }
  }, [currentGuild, currentChannel])

  // Refetch messages on session reset (Op 9 INVALID_SESSION) when resumption was rejected
  useEffect(() => {
    if (!currentGuild || !currentChannel) return
    const guildId = currentGuild.id
    const channelId = currentChannel.id

    return onSessionReset(() => {
      console.log('[ChatArea] session reset received — refetching message history')
      api.getMessages(guildId, channelId)
        .then((msgs) => {
          setMessages([...msgs].reverse())
          setError(null)
        })
        .catch((err: any) => {
          setError(err.message || 'Failed to fetch messages')
        })
    })
  }, [currentGuild, currentChannel, onSessionReset])

  // Real-time Gateway WebSocket subscription (replaces Phase 0 2-second polling)
  useEffect(() => {
    if (!currentChannel) return
    const channelId = currentChannel.id

    const unsubscribe = subscribeToMessages((newMsg: Message) => {
      if (newMsg.channel_id === channelId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) {
            return prev
          }
          return [...prev, newMsg]
        })
        scrollToBottom(true)
      }
    })

    return unsubscribe
  }, [currentChannel, subscribeToMessages])

  // Scroll to bottom when messages count increases
  useEffect(() => {
    scrollToBottom(true)
  }, [messages.length])

  const handleSend = async (e: FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !currentGuild || !currentChannel || sending) return

    const content = inputText.trim()
    const guildId = currentGuild.id
    const channelId = currentChannel.id

    setSending(true)
    setError(null)

    try {
      // Send stays REST (POST /messages)
      const sent = await api.sendMessage(guildId, channelId, content)
      setInputText('')
      // Reconcile / deduplicate with real-time WS dispatch
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev
        return [...prev, sent]
      })
      scrollToBottom(true)
    } catch (err: any) {
      setError(err.message || 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const formatTime = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  if (!currentGuild || !currentChannel) {
    return (
      <div className="chat-area" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Select a server and channel to start chatting</p>
      </div>
    )
  }

  return (
    <div className="chat-area">
      {/* Channel Header */}
      <div className="chat-header">
        <Hash size={24} style={{ color: 'var(--text-muted)' }} />
        <span>{currentChannel.name}</span>
        <span className="chat-header-desc">Welcome to the #{currentChannel.name} channel!</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: connected ? '#23a55a' : '#f0b232',
              display: 'inline-block'
            }}
            title={connected ? 'Real-time Gateway Connected' : 'Gateway Connecting...'}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {connected ? 'Live' : 'Connecting...'}
          </span>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="messages-scroll">
        {/* Welcome message banner for the channel */}
        <div style={{ marginTop: 24, marginBottom: 16 }}>
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: '50%',
              backgroundColor: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <Hash size={40} style={{ color: 'white' }} />
          </div>
          <h2 style={{ color: 'var(--text-header)', fontSize: 32, fontWeight: 700 }}>
            Welcome to #{currentChannel.name}!
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>
            This is the start of the #{currentChannel.name} channel.
          </p>
        </div>

        {/* Message list */}
        {messages.map((msg) => (
          <div key={msg.id} className="message-card">
            <div className="user-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
              {msg.author?.username?.substring(0, 2).toUpperCase() ?? 'U'}
            </div>
            <div className="message-content-wrap">
              <div className="message-meta">
                <span className="message-author">{msg.author?.username ?? 'Unknown'}</span>
                <span className="message-time">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="message-text">{msg.content}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Error banner (e.g. rate-limit or network failure) */}
      {error && (
        <div className="error-banner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Message Input Box */}
      <div className="chat-input-container">
        <form onSubmit={handleSend} className="chat-input-bar">
          <input
            type="text"
            className="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`Message #${currentChannel.name}`}
            disabled={sending}
            autoFocus
          />
          <button
            type="submit"
            className="send-btn"
            disabled={sending || !inputText.trim()}
            title="Send Message"
          >
            <Send size={18} />
          </button>
        </form>
      </div>
    </div>
  )
}
