import { useEffect, useState } from 'react'
import {
  Activity,
  Check,
  Copy,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  User,
  Volume2,
  X,
} from 'lucide-react'
import type { User as UserType } from '../../types'
import { useVoice } from '../../context/useVoice'

interface UserSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  user: UserType | null
  presenceStatus: 'online' | 'idle' | 'dnd' | 'invisible'
  onStatusChange: (status: 'online' | 'idle' | 'dnd' | 'invisible') => void
  onLogout: () => void
}

const PRESENCE_CONFIG = [
  {
    id: 'online' as const,
    label: 'Online',
    desc: 'You are active and available.',
    color: 'var(--presence-online, #23a55a)',
  },
  {
    id: 'idle' as const,
    label: 'Idle',
    desc: 'Away temporarily from your keyboard.',
    color: 'var(--presence-idle, #f0b232)',
  },
  {
    id: 'dnd' as const,
    label: 'Do Not Disturb',
    desc: 'Mute sounds and notifications.',
    color: 'var(--presence-dnd, #f23f43)',
  },
  {
    id: 'invisible' as const,
    label: 'Invisible',
    desc: 'Appear offline to others while maintaining full access.',
    color: 'var(--presence-offline, #80848e)',
  },
]

export function UserSettingsModal({
  isOpen,
  onClose,
  user,
  presenceStatus,
  onStatusChange,
  onLogout,
}: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'account' | 'status' | 'voice'>('account')
  const [copiedId, setCopiedId] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)

  const { selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice()

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showLogoutConfirm) {
          setShowLogoutConfirm(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, showLogoutConfirm, onClose])

  if (!isOpen || !user) return null

  const handleCopyId = () => {
    navigator.clipboard?.writeText(user.id)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 2000)
  }

  const createdDate = user.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Unknown'

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 860,
          maxWidth: '95vw',
          height: '80vh',
          maxHeight: 700,
          display: 'flex',
          flexDirection: 'row',
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: 'var(--bg-chat)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.7)',
          position: 'relative',
        }}
      >
        {/* Left Navigation Sidebar */}
        <div
          style={{
            width: 220,
            backgroundColor: 'var(--bg-channels)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '24px 12px',
            borderRight: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                padding: '0 10px 12px',
                letterSpacing: '0.05em',
              }}
            >
              User Settings
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                type="button"
                onClick={() => setActiveTab('account')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  border: 'none',
                  background: activeTab === 'account' ? 'var(--bg-hover)' : 'transparent',
                  color: activeTab === 'account' ? 'var(--text-header)' : 'var(--text-muted)',
                  fontWeight: activeTab === 'account' ? 600 : 500,
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <User size={16} /> My Account
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('status')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  border: 'none',
                  background: activeTab === 'status' ? 'var(--bg-hover)' : 'transparent',
                  color: activeTab === 'status' ? 'var(--text-header)' : 'var(--text-muted)',
                  fontWeight: activeTab === 'status' ? 600 : 500,
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Activity size={16} /> Presence & Status
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('voice')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  border: 'none',
                  background: activeTab === 'voice' ? 'var(--bg-hover)' : 'transparent',
                  color: activeTab === 'voice' ? 'var(--text-header)' : 'var(--text-muted)',
                  fontWeight: activeTab === 'voice' ? 600 : 500,
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Volume2 size={16} /> Voice & Audio
              </button>
            </div>
          </div>

          {/* Log Out button at bottom of sidebar */}
          <button
            type="button"
            onClick={() => setShowLogoutConfirm(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: '#ff7b72',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background-color 0.15s ease',
            }}
          >
            <LogOut size={16} /> Log Out
          </button>
        </div>

        {/* Right Content Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header Bar */}
          <div
            style={{
              padding: '20px 32px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)' }}>
              {activeTab === 'account'
                ? 'My Account'
                : activeTab === 'status'
                ? 'Presence & Status'
                : 'Voice & Audio'}
            </span>

            <button
              type="button"
              onClick={onClose}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                borderRadius: 4,
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Close Settings (Esc)"
            >
              <X size={14} /> ESC
            </button>
          </div>

          {/* Tab Body */}
          <div style={{ padding: '24px 32px', overflowY: 'auto', flex: 1 }}>
            {/* TAB: My Account */}
            {activeTab === 'account' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 540 }}>
                {/* Profile Card */}
                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    overflow: 'hidden',
                  }}
                >
                  {/* Banner Header Accent */}
                  <div
                    style={{
                      height: 80,
                      backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(0,0,0,0.4) 100%)',
                    }}
                  />

                  {/* Avatar & User Details */}
                  <div style={{ padding: '0 20px 20px', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: -40, marginBottom: 16 }}>
                      <div style={{ position: 'relative' }}>
                        <div
                          style={{
                            width: 80,
                            height: 80,
                            borderRadius: '50%',
                            backgroundColor: '#ffffff',
                            color: '#000000',
                            fontSize: 32,
                            fontWeight: 800,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '4px solid var(--bg-chat)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                          }}
                        >
                          {user.username.substring(0, 2).toUpperCase()}
                        </div>
                        <span
                          style={{
                            position: 'absolute',
                            bottom: 2,
                            right: 2,
                            width: 18,
                            height: 18,
                            borderRadius: '50%',
                            border: '3px solid var(--bg-chat)',
                            backgroundColor:
                              PRESENCE_CONFIG.find((p) => p.id === presenceStatus)?.color ||
                              'var(--presence-online)',
                          }}
                        />
                      </div>

                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-header)' }}>
                          {user.username}
                          <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: 16 }}>
                            #{user.discriminator}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          {PRESENCE_CONFIG.find((p) => p.id === presenceStatus)?.label}
                        </div>
                      </div>
                    </div>

                    {/* Account Metadata Fields */}
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        backgroundColor: 'rgba(0,0,0,0.15)',
                        padding: 16,
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.04)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                            Username
                          </div>
                          <div style={{ fontSize: 14, color: 'var(--text-normal)', marginTop: 2 }}>
                            {user.username}#{user.discriminator}
                          </div>
                        </div>
                      </div>

                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                            Email Address
                          </div>
                          <div style={{ fontSize: 14, color: 'var(--text-normal)', marginTop: 2 }}>
                            {user.email || 'None provided'}
                          </div>
                        </div>
                      </div>

                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                            User ID
                          </div>
                          <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: 2 }}>
                            {user.id}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '6px 12px',
                            backgroundColor: copiedId ? 'rgba(35, 165, 90, 0.15)' : 'rgba(255,255,255,0.06)',
                            color: copiedId ? '#23a55a' : 'var(--text-header)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 4,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {copiedId ? <Check size={13} /> : <Copy size={13} />}
                          {copiedId ? 'Copied' : 'Copy ID'}
                        </button>
                      </div>

                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                          Account Created
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                          {createdDate}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: Presence & Status */}
            {activeTab === 'status' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 540 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
                  Choose how your online status appears to other server members across Kith.
                </div>

                {PRESENCE_CONFIG.map((item) => {
                  const isSelected = presenceStatus === item.id
                  return (
                    <div
                      key={item.id}
                      onClick={() => onStatusChange(item.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '14px 18px',
                        borderRadius: 6,
                        backgroundColor: isSelected ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                        border: `1px solid ${isSelected ? '#ffffff' : 'var(--border-subtle)'}`,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            backgroundColor: item.color,
                            flexShrink: 0,
                          }}
                        />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                            {item.label}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                            {item.desc}
                          </div>
                        </div>
                      </div>

                      {isSelected && (
                        <div
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            backgroundColor: '#ffffff',
                            color: '#000000',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Check size={13} strokeWidth={3} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* TAB: Voice & Audio */}
            {activeTab === 'voice' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 540 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Manage your quick voice settings and hardware state.
                </div>

                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 18,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                  }}
                >
                  {/* Microphone Control */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 6,
                          backgroundColor: selfMute ? 'rgba(218, 55, 60, 0.15)' : 'rgba(255,255,255,0.06)',
                          color: selfMute ? '#ff7b72' : 'var(--text-header)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                          Microphone State
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {selfMute ? 'Muted — other participants cannot hear you' : 'Active and transmitting'}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={toggleMute}
                      style={{
                        padding: '6px 14px',
                        backgroundColor: selfMute ? 'rgba(218, 55, 60, 0.15)' : '#ffffff',
                        color: selfMute ? '#ff7b72' : '#000000',
                        border: selfMute ? '1px solid rgba(218, 55, 60, 0.3)' : 'none',
                        borderRadius: 4,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {selfMute ? 'Unmute' : 'Mute'}
                    </button>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-subtle)' }} />

                  {/* Deafen Control */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 6,
                          backgroundColor: selfDeaf ? 'rgba(218, 55, 60, 0.15)' : 'rgba(255,255,255,0.06)',
                          color: selfDeaf ? '#ff7b72' : 'var(--text-header)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Headphones size={18} />
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-header)' }}>
                          Audio Output (Deafen)
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {selfDeaf ? 'Deafened — voice channel audio is suppressed' : 'Output audio active'}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={toggleDeaf}
                      style={{
                        padding: '6px 14px',
                        backgroundColor: selfDeaf ? 'rgba(218, 55, 60, 0.15)' : '#ffffff',
                        color: selfDeaf ? '#ff7b72' : '#000000',
                        border: selfDeaf ? '1px solid rgba(218, 55, 60, 0.3)' : 'none',
                        borderRadius: 4,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {selfDeaf ? 'Undeafen' : 'Deafen'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Confirmation Modal for Logout */}
        {showLogoutConfirm && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.75)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 200,
            }}
            onClick={() => setShowLogoutConfirm(false)}
          >
            <div
              style={{
                width: 420,
                backgroundColor: 'var(--bg-chat)',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                padding: 24,
                boxShadow: '0 16px 40px rgba(0,0,0,0.8)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)', marginBottom: 8 }}>
                Log Out
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 20 }}>
                Are you sure you want to log out of <strong>@{user.username}#{user.discriminator}</strong>?
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(false)}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: 'transparent',
                    color: 'var(--text-normal)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLogoutConfirm(false)
                    onClose()
                    onLogout()
                  }}
                  style={{
                    padding: '8px 18px',
                    backgroundColor: 'var(--danger, #da373c)',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Log Out
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
