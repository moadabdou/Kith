import { type FormEvent } from 'react'
import { Send } from 'lucide-react'

interface MessageInputProps {
  channelName: string
  canSend: boolean
  inputText: string
  onChange: (value: string) => void
  onSend: (e: FormEvent) => void
  sending?: boolean
}

export function MessageInput({
  channelName,
  canSend,
  inputText,
  onChange,
  onSend,
  sending = false,
}: MessageInputProps) {
  const placeholder = canSend
    ? `Message #${channelName}`
    : 'You do not have permission to send messages in this channel'

  return (
    <div className={`chat-input-container ${!canSend ? 'disabled' : ''}`}>
      <form
        onSubmit={canSend ? onSend : (e) => e.preventDefault()}
        className={`chat-input-bar ${!canSend ? 'disabled' : ''}`}
      >
        <input
          type="text"
          className="chat-input"
          value={canSend ? inputText : ''}
          onChange={(e) => canSend && onChange(e.target.value)}
          placeholder={placeholder}
          disabled={!canSend || sending}
          autoFocus={canSend}
          title={!canSend ? 'You do not have permission to send messages in this channel' : undefined}
        />
        {canSend && (
          <button
            type="submit"
            className="send-btn"
            disabled={sending || !inputText.trim()}
            title="Send Message"
          >
            <Send size={18} />
          </button>
        )}
      </form>
    </div>
  )
}
