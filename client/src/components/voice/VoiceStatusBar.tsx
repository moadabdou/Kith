import { PhoneOff, Radio, Loader2 } from 'lucide-react'
import { useVoice } from '../../context/useVoice'
import type { Channel, Guild } from '../../types'

interface VoiceStatusBarProps {
  currentGuild: Guild | null
  channels: Channel[]
}

export function VoiceStatusBar({ currentGuild, channels }: VoiceStatusBarProps) {
  const { activeVoice, connectionStatus, leaveVoice } = useVoice()

  if (!activeVoice) return null

  const isConnected = connectionStatus === 'connected'
  const isConnecting = connectionStatus === 'connecting'

  const activeChannel = channels.find((c) => c.id === activeVoice.channelId)
  const channelName = activeChannel ? activeChannel.name : 'Voice Channel'
  const guildName = currentGuild?.id === activeVoice.guildId ? currentGuild.name : 'Server'

  return (
    <div className="voice-status-bar">
      <div className="voice-status-info">
        <div className="voice-status-indicator">
          {isConnected ? (
            <Radio size={16} className="voice-signal-icon connected" />
          ) : (
            <Loader2 size={16} className="voice-signal-icon connecting animate-spin" />
          )}
          <span className={`voice-status-label ${connectionStatus}`}>
            {isConnected ? 'Voice Connected' : isConnecting ? 'RTC Connecting…' : 'Disconnected'}
          </span>
        </div>
        <div className="voice-channel-subtext" title={`${channelName} (${guildName})`}>
          <span className="voice-channel-name">{channelName}</span>
          <span className="voice-guild-name"> / {guildName}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={leaveVoice}
        className="voice-disconnect-btn"
        title="Disconnect"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  )
}
