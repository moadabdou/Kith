import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Activity,
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  LogOut,
  Mic,
  Palette,
  Sparkles,
  Trash2,
  User,
  Video,
  VideoOff,
  Volume2,
  X,
} from 'lucide-react'
import type { User as UserType } from '../../types'
import { useVoice } from '../../context/useVoice'
import { api } from '../../api'
import {
  getAllMediaDevices,
  onMediaDeviceChange,
  getInputDevicePreference,
  setInputDevicePreference,
  getOutputDevicePreference,
  setOutputDevicePreference,
  getCameraDevicePreference,
  setCameraDevicePreference,
  getInputVolumePreference,
  setInputVolumePreference,
  getOutputVolumePreference,
  setOutputVolumePreference,
  type CategorizedMediaDevices,
} from '../../lib/media-devices'

interface UserSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  user: UserType | null
  presenceStatus: 'online' | 'idle' | 'dnd' | 'invisible'
  onStatusChange: (status: 'online' | 'idle' | 'dnd' | 'invisible') => void
  onLogout: () => void
  onUserUpdated?: (user: UserType) => void
  initialTab?: 'account' | 'profiles' | 'status' | 'voice'
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

const BANNER_PRESETS = [
  { id: 'blurple', label: 'Discord Blurple', color: '#5865F2' },
  { id: 'emerald', label: 'Emerald Green', color: '#23a55a' },
  { id: 'crimson', label: 'Crimson Red', color: '#f23f43' },
  { id: 'amethyst', label: 'Amethyst Purple', color: '#9b59b6' },
  { id: 'amber', label: 'Amber Gold', color: '#f0b232' },
  { id: 'dark', label: 'Midnight Dark', color: '#1e1f22' },
]

function readFileAsResizedDataUrl(
  file: File,
  maxWidth: number,
  maxHeight: number,
  quality = 0.88
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        let width = img.width
        let height = img.height
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height)
          width = Math.max(1, Math.round(width * ratio))
          height = Math.max(1, Math.round(height * ratio))
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(reader.result as string)
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
        resolve(canvas.toDataURL(mime, quality))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

export function UserSettingsModal({
  isOpen,
  onClose,
  user,
  presenceStatus,
  onStatusChange,
  onLogout,
  onUserUpdated,
  initialTab = 'account',
}: UserSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'account' | 'profiles' | 'status' | 'voice'>(initialTab)
  const [copiedId, setCopiedId] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)

  // Profile customization state
  const [profileAvatar, setProfileAvatar] = useState<string | null>(user?.avatar ?? null)
  const [profileBanner, setProfileBanner] = useState<string | null>(user?.banner ?? null)
  const [profileBio, setProfileBio] = useState<string>(user?.bio ?? '')
  const [profileUsername, setProfileUsername] = useState<string>(user?.username ?? '')

  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null)

  // Voice & Video Hardware state
  const [devices, setDevices] = useState<CategorizedMediaDevices>({
    audioInputs: [],
    audioOutputs: [],
    videoInputs: [],
  })
  const [selectedInputId, setSelectedInputId] = useState<string>(() => getInputDevicePreference() || '')
  const [selectedOutputId, setSelectedOutputId] = useState<string>(() => getOutputDevicePreference() || '')
  const [selectedCameraId, setSelectedCameraId] = useState<string>(() => getCameraDevicePreference() || '')
  const [inputVolume, setInputVolume] = useState<number>(() => getInputVolumePreference())
  const [outputVolume, setOutputVolume] = useState<number>(() => getOutputVolumePreference())

  // Mic sensitivity test state
  const [isTestingMic, setIsTestingMic] = useState(false)
  const [micLevel, setMicLevel] = useState(0) // 0 to 100
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const micAnimFrameRef = useRef<number | null>(null)

  // Camera video test state
  const [isTestingCamera, setIsTestingCamera] = useState(false)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null)

  const { selfMute, selfDeaf, toggleMute, toggleDeaf, setSelectedCameraId: setContextCameraId } = useVoice()

  // Enumerate hardware devices on mount and listen to hotplug changes
  useEffect(() => {
    let mounted = true
    getAllMediaDevices().then((devs) => {
      if (mounted) {
        setDevices(devs)
        if (!selectedInputId && devs.audioInputs.length > 0) {
          setSelectedInputId(devs.audioInputs[0].deviceId)
        }
        if (!selectedOutputId && devs.audioOutputs.length > 0) {
          setSelectedOutputId(devs.audioOutputs[0].deviceId)
        }
        if (!selectedCameraId && devs.videoInputs.length > 0) {
          setSelectedCameraId(devs.videoInputs[0].deviceId)
        }
      }
    })

    const unsub = onMediaDeviceChange((devs) => {
      if (mounted) setDevices(devs)
    })

    return () => {
      mounted = false
      unsub()
    }
  }, [selectedInputId, selectedOutputId, selectedCameraId])

  // Stop mic test helper
  const stopMicTest = useCallback(() => {
    if (micAnimFrameRef.current) {
      cancelAnimationFrame(micAnimFrameRef.current)
      micAnimFrameRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop())
      micStreamRef.current = null
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close()
      } catch {}
      audioContextRef.current = null
    }
    setMicLevel(0)
    setIsTestingMic(false)
  }, [])

  // Start mic test helper
  const startMicTest = useCallback(async () => {
    stopMicTest()
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return

    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedInputId ? { deviceId: { exact: selectedInputId } } : true,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      micStreamRef.current = stream

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      audioContextRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.75
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const tick = () => {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]
        }
        const avg = sum / dataArray.length
        // Natural speech level boost normalization (0 to 100%)
        const normalized = Math.min(Math.max((avg / 110) * 100, 0), 100)
        setMicLevel(normalized)
        micAnimFrameRef.current = requestAnimationFrame(tick)
      }

      setIsTestingMic(true)
      micAnimFrameRef.current = requestAnimationFrame(tick)
    } catch (err) {
      console.warn('[MicTest] Could not start mic test:', err)
      stopMicTest()
    }
  }, [selectedInputId, stopMicTest])

  const toggleMicTest = () => {
    if (isTestingMic) {
      stopMicTest()
    } else {
      startMicTest()
    }
  }

  // Stop camera video test helper
  const stopCameraTest = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null
    }
    setIsTestingCamera(false)
  }, [])

  // Start camera video test helper
  const startCameraTest = useCallback(async () => {
    stopCameraTest()
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return

    try {
      const constraints: MediaStreamConstraints = {
        video: selectedCameraId
          ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      cameraStreamRef.current = stream

      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream
        videoPreviewRef.current.play().catch(() => {})
      }
      setIsTestingCamera(true)
    } catch (err) {
      console.warn('[CameraTest] Could not start camera test:', err)
      stopCameraTest()
    }
  }, [selectedCameraId, stopCameraTest])

  const toggleCameraTest = () => {
    if (isTestingCamera) {
      stopCameraTest()
    } else {
      startCameraTest()
    }
  }

  // Cleanup testing media streams on unmount, close, or tab switch
  useEffect(() => {
    return () => {
      stopMicTest()
      stopCameraTest()
    }
  }, [stopMicTest, stopCameraTest])

  useEffect(() => {
    if (activeTab !== 'voice') {
      stopMicTest()
      stopCameraTest()
    }
  }, [activeTab, stopMicTest, stopCameraTest])

  // Sync profile editing buffer whenever user updates
  useEffect(() => {
    if (user) {
      setProfileAvatar(user.avatar ?? null)
      setProfileBanner(user.banner ?? null)
      setProfileBio(user.bio ?? '')
      setProfileUsername(user.username ?? '')
    }
  }, [user?.id, user?.avatar, user?.banner, user?.bio, user?.username])

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

  const hasProfileChanges =
    Boolean(user) &&
    ((profileAvatar ?? null) !== (user.avatar ?? null) ||
      (profileBanner ?? null) !== (user.banner ?? null) ||
      profileBio !== (user.bio ?? '') ||
      profileUsername.trim() !== user.username)

  const handleResetProfile = () => {
    if (!user) return
    setProfileAvatar(user.avatar ?? null)
    setProfileBanner(user.banner ?? null)
    setProfileBio(user.bio ?? '')
    setProfileUsername(user.username)
    setProfileError(null)
    setProfileSuccess(null)
  }

  const handleSaveProfile = async () => {
    if (!user) return
    const trimmedUsername = profileUsername.trim()
    if (trimmedUsername.length < 2 || trimmedUsername.length > 32) {
      setProfileError('Username must be between 2 and 32 characters')
      return
    }
    if (profileBio.length > 190) {
      setProfileError('About Me cannot exceed 190 characters')
      return
    }

    setIsSavingProfile(true)
    setProfileError(null)
    setProfileSuccess(null)
    try {
      const updated = await api.updateMe({
        username: trimmedUsername !== user.username ? trimmedUsername : undefined,
        avatar: profileAvatar ?? null,
        banner: profileBanner ?? null,
        bio: profileBio ? profileBio : null,
      })
      onUserUpdated?.(updated)
      setProfileSuccess('Profile changes saved!')
      setTimeout(() => setProfileSuccess(null), 3000)
    } catch (err: any) {
      setProfileError(err?.message || 'Failed to update user profile')
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setProfileError('Please choose an image file (PNG, JPG, WebP, GIF)')
      return
    }
    try {
      const dataUrl = await readFileAsResizedDataUrl(file, 256, 256, 0.9)
      setProfileAvatar(dataUrl)
      setProfileError(null)
    } catch {
      setProfileError('Failed to read avatar image')
    }
    e.target.value = ''
  }

  const handleBannerFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setProfileError('Please choose an image file (PNG, JPG, WebP, GIF)')
      return
    }
    try {
      const dataUrl = await readFileAsResizedDataUrl(file, 960, 540, 0.88)
      setProfileBanner(dataUrl)
      setProfileError(null)
    } catch {
      setProfileError('Failed to read banner image')
    }
    e.target.value = ''
  }

  const handleInputDeviceChange = (deviceId: string) => {
    setSelectedInputId(deviceId)
    setInputDevicePreference(deviceId)
    if (isTestingMic) {
      setTimeout(startMicTest, 100)
    }
  }

  const handleOutputDeviceChange = (deviceId: string) => {
    setSelectedOutputId(deviceId)
    setOutputDevicePreference(deviceId)
  }

  const handleCameraDeviceChange = (deviceId: string) => {
    setSelectedCameraId(deviceId)
    setCameraDevicePreference(deviceId)
    setContextCameraId?.(deviceId)
    if (isTestingCamera) {
      setTimeout(startCameraTest, 100)
    }
  }

  const handleInputVolumeChange = (val: number) => {
    setInputVolume(val)
    setInputVolumePreference(val)
  }

  const handleOutputVolumeChange = (val: number) => {
    setOutputVolume(val)
    setOutputVolumePreference(val)
  }

  const createdDate = user.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Unknown'

  const bannerBackground = (banner: string | null) => {
    if (!banner) {
      return 'linear-gradient(135deg, rgba(88, 101, 242, 0.6) 0%, rgba(20, 22, 28, 0.9) 100%)'
    }
    if (banner.startsWith('#') || banner.startsWith('rgb')) {
      return banner
    }
    return `url("${banner}") center/cover no-repeat`
  }

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 890,
          maxWidth: '96vw',
          height: '82vh',
          maxHeight: 740,
          display: 'flex',
          flexDirection: 'row',
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: 'var(--bg-chat)',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.75)',
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
                onClick={() => setActiveTab('profiles')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  border: 'none',
                  background: activeTab === 'profiles' ? 'var(--bg-hover)' : 'transparent',
                  color: activeTab === 'profiles' ? 'var(--text-header)' : 'var(--text-muted)',
                  fontWeight: activeTab === 'profiles' ? 600 : 500,
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Palette size={16} /> Profiles
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          {/* Header Bar */}
          <div
            style={{
              padding: '20px 32px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)' }}>
              {activeTab === 'account'
                ? 'My Account'
                : activeTab === 'profiles'
                ? 'User Profile'
                : activeTab === 'status'
                ? 'Presence & Status'
                : 'Voice & Video Settings'}
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
          <div style={{ padding: '24px 32px 80px', overflowY: 'auto', flex: 1 }}>
            {/* TAB: My Account */}
            {activeTab === 'account' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 580 }}>
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
                      height: 90,
                      background: bannerBackground(user.banner ?? null),
                      position: 'relative',
                    }}
                  />

                  {/* Avatar & User Details */}
                  <div style={{ padding: '0 20px 20px', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: -40, marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
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
                              overflow: 'hidden',
                            }}
                          >
                            {user.avatar ? (
                              <img src={user.avatar} alt={user.username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                              user.username.substring(0, 2).toUpperCase()
                            )}
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

                      <button
                        type="button"
                        onClick={() => setActiveTab('profiles')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '7px 14px',
                          borderRadius: 4,
                          border: 'none',
                          backgroundColor: '#5865F2',
                          color: '#ffffff',
                          fontWeight: 600,
                          fontSize: 13,
                          cursor: 'pointer',
                          boxShadow: '0 2px 6px rgba(88, 101, 242, 0.4)',
                        }}
                      >
                        <Sparkles size={14} /> Edit User Profile
                      </button>
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

                      {user.bio && (
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                            About Me
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--text-normal)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                            {user.bio}
                          </div>
                        </div>
                      )}

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

            {/* TAB: Profiles (Item 1 of Issue #127) */}
            {activeTab === 'profiles' && (
              <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
                {/* Left Column: Form Controls */}
                <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {profileError && (
                    <div
                      style={{
                        padding: '10px 14px',
                        borderRadius: 6,
                        backgroundColor: 'rgba(242, 63, 67, 0.15)',
                        border: '1px solid #f23f43',
                        color: '#ff7b72',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <AlertCircle size={16} />
                      {profileError}
                    </div>
                  )}

                  {profileSuccess && (
                    <div
                      style={{
                        padding: '10px 14px',
                        borderRadius: 6,
                        backgroundColor: 'rgba(35, 165, 90, 0.15)',
                        border: '1px solid #23a55a',
                        color: '#23a55a',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <CheckCircle2 size={16} />
                      {profileSuccess}
                    </div>
                  )}

                  {/* Username Field */}
                  <div>
                    <label
                      htmlFor="profile-username"
                      style={{
                        display: 'block',
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        marginBottom: 8,
                      }}
                    >
                      Display Username
                    </label>
                    <input
                      id="profile-username"
                      type="text"
                      value={profileUsername}
                      onChange={(e) => setProfileUsername(e.target.value)}
                      maxLength={32}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 4,
                        color: 'var(--text-header)',
                        fontSize: 14,
                        outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>

                  {/* Avatar Section */}
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        marginBottom: 8,
                      }}
                    >
                      Avatar
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: '50%',
                          backgroundColor: '#ffffff',
                          color: '#000000',
                          fontSize: 22,
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          flexShrink: 0,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                        }}
                      >
                        {profileAvatar ? (
                          <img
                            src={profileAvatar}
                            alt="Avatar preview"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          profileUsername.substring(0, 2).toUpperCase()
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '8px 14px',
                            backgroundColor: '#5865F2',
                            color: '#ffffff',
                            borderRadius: 4,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          <Camera size={14} /> Change Avatar
                          <input
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={handleAvatarFile}
                          />
                        </label>

                        {profileAvatar && (
                          <button
                            type="button"
                            onClick={() => setProfileAvatar(null)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '8px 12px',
                              backgroundColor: 'rgba(242, 63, 67, 0.12)',
                              color: '#ff7b72',
                              border: '1px solid rgba(242, 63, 67, 0.3)',
                              borderRadius: 4,
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            <Trash2 size={14} /> Remove Avatar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Banner Section */}
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        marginBottom: 8,
                      }}
                    >
                      Profile Banner
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '8px 14px',
                            backgroundColor: 'rgba(255, 255, 255, 0.1)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-header)',
                            borderRadius: 4,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          <Camera size={14} /> Upload Banner
                          <input
                            type="file"
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={handleBannerFile}
                          />
                        </label>

                        {profileBanner && (
                          <button
                            type="button"
                            onClick={() => setProfileBanner(null)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '8px 12px',
                              backgroundColor: 'rgba(242, 63, 67, 0.12)',
                              color: '#ff7b72',
                              border: '1px solid rgba(242, 63, 67, 0.3)',
                              borderRadius: 4,
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            <Trash2 size={14} /> Remove Banner
                          </button>
                        )}
                      </div>

                      {/* Preset Accent Swatches */}
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Or pick an accent color:
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          {BANNER_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => setProfileBanner(preset.color)}
                              title={preset.label}
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: '50%',
                                backgroundColor: preset.color,
                                border: profileBanner === preset.color ? '3px solid #ffffff' : '1px solid rgba(255,255,255,0.2)',
                                cursor: 'pointer',
                                outline: 'none',
                                transition: 'transform 0.15s ease',
                                transform: profileBanner === preset.color ? 'scale(1.15)' : 'none',
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* About Me / Bio Section */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <label
                        htmlFor="profile-bio"
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: 'var(--text-muted)',
                        }}
                      >
                        About Me
                      </label>
                      <span
                        style={{
                          fontSize: 11,
                          color: profileBio.length > 180 ? '#f23f43' : 'var(--text-muted)',
                          fontWeight: profileBio.length > 180 ? 700 : 500,
                        }}
                      >
                        {profileBio.length}/190
                      </span>
                    </div>

                    <textarea
                      id="profile-bio"
                      value={profileBio}
                      onChange={(e) => setProfileBio(e.target.value)}
                      maxLength={190}
                      rows={4}
                      placeholder="Tell everyone a little something about yourself..."
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 4,
                        color: 'var(--text-header)',
                        fontSize: 14,
                        outline: 'none',
                        resize: 'none',
                        boxSizing: 'border-box',
                        fontFamily: 'inherit',
                      }}
                    />
                  </div>
                </div>

                {/* Right Column: Live Profile Preview Card */}
                <div style={{ width: 300, flexShrink: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                      marginBottom: 10,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Preview
                  </div>

                  {/* Discord Style Profile Card */}
                  <div
                    style={{
                      width: '100%',
                      backgroundColor: '#111214',
                      borderRadius: 8,
                      overflow: 'hidden',
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    {/* Card Banner */}
                    <div
                      style={{
                        height: 105,
                        background: bannerBackground(profileBanner),
                        position: 'relative',
                      }}
                    />

                    {/* Card Body */}
                    <div style={{ padding: '0 16px 16px', position: 'relative' }}>
                      {/* Floating Avatar */}
                      <div
                        style={{
                          position: 'relative',
                          marginTop: -42,
                          width: 80,
                          height: 80,
                          marginBottom: 10,
                        }}
                      >
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
                            border: '5px solid #111214',
                            overflow: 'hidden',
                            boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                          }}
                        >
                          {profileAvatar ? (
                            <img
                              src={profileAvatar}
                              alt="Avatar"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            profileUsername.substring(0, 2).toUpperCase() || 'U'
                          )}
                        </div>

                        {/* Status Badge */}
                        <span
                          style={{
                            position: 'absolute',
                            bottom: 2,
                            right: 2,
                            width: 18,
                            height: 18,
                            borderRadius: '50%',
                            border: '4px solid #111214',
                            backgroundColor:
                              PRESENCE_CONFIG.find((p) => p.id === presenceStatus)?.color ||
                              'var(--presence-online)',
                          }}
                        />
                      </div>

                      {/* Header details */}
                      <div
                        style={{
                          backgroundColor: '#2b2d31',
                          borderRadius: 8,
                          padding: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f2f3f5' }}>
                            {profileUsername || 'User'}
                          </div>
                          <div style={{ fontSize: 13, color: '#949ba4' }}>
                            {profileUsername.toLowerCase()}#{user.discriminator}
                          </div>
                        </div>

                        <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />

                        {/* About Me in Preview */}
                        <div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              color: '#b5bac1',
                              marginBottom: 4,
                            }}
                          >
                            About Me
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              color: '#dbdee1',
                              lineHeight: 1.4,
                              whiteSpace: 'pre-wrap',
                              minHeight: 28,
                            }}
                          >
                            {profileBio || (
                              <span style={{ color: '#80848e', fontStyle: 'italic' }}>
                                No bio written yet.
                              </span>
                            )}
                          </div>
                        </div>

                        <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />

                        {/* Member Since in Preview */}
                        <div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              color: '#b5bac1',
                              marginBottom: 2,
                            }}
                          >
                            Member Since
                          </div>
                          <div style={{ fontSize: 12, color: '#dbdee1' }}>
                            {createdDate}
                          </div>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            backgroundColor: item.color,
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--text-header)', fontSize: 14 }}>
                            {item.label}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                            {item.desc}
                          </div>
                        </div>
                      </div>

                      {isSelected && <Check size={18} color="#ffffff" />}
                    </div>
                  )
                })}
              </div>
            )}

            {/* TAB: Voice & Audio (Item 2 of Issue #127) */}
            {activeTab === 'voice' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 640 }}>
                {/* 1. Device Selectors & Volume Sliders */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* Input Device (Microphone) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label
                      htmlFor="input-device-select"
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Input Device
                    </label>
                    <select
                      id="input-device-select"
                      className="voice-settings-select"
                      value={selectedInputId}
                      onChange={(e) => handleInputDeviceChange(e.target.value)}
                    >
                      {devices.audioInputs.length === 0 ? (
                        <option value="">Default Microphone</option>
                      ) : (
                        devices.audioInputs.map((d, idx) => (
                          <option key={d.deviceId || idx} value={d.deviceId}>
                            {d.label || `Microphone ${idx + 1}`}
                          </option>
                        ))
                      )}
                    </select>

                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                          Input Volume
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-header)' }}>
                          {inputVolume}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={inputVolume}
                        onChange={(e) => handleInputVolumeChange(parseInt(e.target.value, 10))}
                        className="voice-slider"
                        aria-label="Input Volume"
                      />
                    </div>
                  </div>

                  {/* Output Device (Speaker/Headphones) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label
                      htmlFor="output-device-select"
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Output Device
                    </label>
                    <select
                      id="output-device-select"
                      className="voice-settings-select"
                      value={selectedOutputId}
                      onChange={(e) => handleOutputDeviceChange(e.target.value)}
                    >
                      {devices.audioOutputs.length === 0 ? (
                        <option value="">Default Output Device</option>
                      ) : (
                        devices.audioOutputs.map((d, idx) => (
                          <option key={d.deviceId || idx} value={d.deviceId}>
                            {d.label || `Speaker ${idx + 1}`}
                          </option>
                        ))
                      )}
                    </select>

                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                          Output Volume
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-header)' }}>
                          {outputVolume}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={outputVolume}
                        onChange={(e) => handleOutputVolumeChange(parseInt(e.target.value, 10))}
                        className="voice-slider"
                        aria-label="Output Volume"
                      />
                    </div>
                  </div>
                </div>

                <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />

                {/* 2. Mic Test Sensitivity Meter */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                    Mic Test
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Having mic issues? Click &quot;Let&apos;s Check&quot; and speak into your microphone to test sensitivity.
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={toggleMicTest}
                      style={{
                        padding: '10px 18px',
                        borderRadius: 4,
                        border: 'none',
                        backgroundColor: isTestingMic ? '#f23f43' : '#5865F2',
                        color: '#ffffff',
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        flexShrink: 0,
                        boxShadow: isTestingMic ? '0 2px 8px rgba(242, 63, 67, 0.4)' : '0 2px 8px rgba(88, 101, 242, 0.4)',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <Mic size={16} />
                      {isTestingMic ? 'Stop Testing' : "Let's Check"}
                    </button>

                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div className="mic-meter-track">
                        <div
                          className="mic-meter-fill"
                          style={{
                            width: `${micLevel}%`,
                            opacity: isTestingMic ? 1 : 0.2,
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 10,
                          color: 'var(--text-muted)',
                          padding: '0 2px',
                        }}
                      >
                        <span>-60 dB</span>
                        <span>-40 dB</span>
                        <span>-20 dB</span>
                        <span>-6 dB</span>
                        <span>0 dB</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />

                {/* 3. Camera Video Settings & Live Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                    Camera Settings
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Select your webcam and test your camera video feed before joining voice channels.
                  </div>

                  <div style={{ maxWidth: 340 }}>
                    <label
                      htmlFor="camera-device-select"
                      style={{
                        display: 'block',
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-muted)',
                        marginBottom: 6,
                      }}
                    >
                      Camera Device
                    </label>
                    <select
                      id="camera-device-select"
                      className="voice-settings-select"
                      value={selectedCameraId}
                      onChange={(e) => handleCameraDeviceChange(e.target.value)}
                    >
                      {devices.videoInputs.length === 0 ? (
                        <option value="">Default Camera</option>
                      ) : (
                        devices.videoInputs.map((d, idx) => (
                          <option key={d.deviceId || idx} value={d.deviceId}>
                            {d.label || `Camera ${idx + 1}`}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {/* 16:9 Video Preview Card */}
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className="camera-preview-container">
                      <video
                        ref={videoPreviewRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: isTestingCamera ? 'block' : 'none',
                        }}
                      />

                      {!isTestingCamera && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 10,
                            color: 'var(--text-muted)',
                          }}
                        >
                          <Video size={36} color="rgba(255,255,255,0.3)" />
                          <span style={{ fontSize: 13 }}>Camera preview is turned off.</span>
                        </div>
                      )}

                      {isTestingCamera && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            backgroundColor: 'rgba(0, 0, 0, 0.75)',
                            backdropFilter: 'blur(4px)',
                            padding: '4px 10px',
                            borderRadius: 12,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            color: '#23a55a',
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              backgroundColor: '#23a55a',
                              display: 'inline-block',
                            }}
                          />
                          LIVE PREVIEW
                        </div>
                      )}
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={toggleCameraTest}
                        style={{
                          padding: '8px 16px',
                          borderRadius: 4,
                          border: 'none',
                          backgroundColor: isTestingCamera ? '#f23f43' : '#5865F2',
                          color: '#ffffff',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          boxShadow: isTestingCamera ? '0 2px 8px rgba(242, 63, 67, 0.4)' : '0 2px 8px rgba(88, 101, 242, 0.4)',
                        }}
                      >
                        {isTestingCamera ? <VideoOff size={15} /> : <Video size={15} />}
                        {isTestingCamera ? 'Stop Video' : 'Test Video'}
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />

                {/* 4. Quick Audio Shortcuts */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12, letterSpacing: '0.05em' }}>
                    Quick Voice Toggles
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div
                      onClick={toggleMute}
                      style={{
                        padding: 16,
                        borderRadius: 6,
                        backgroundColor: selfMute ? 'rgba(242, 63, 67, 0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${selfMute ? '#f23f43' : 'var(--border-subtle)'}`,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-header)', fontSize: 14 }}>
                          Microphone
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: selfMute ? '#f23f43' : 'var(--presence-online)',
                          }}
                        >
                          {selfMute ? 'MUTED' : 'ACTIVE'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {selfMute ? 'Click to unmute your voice input.' : 'Your voice will broadcast to channels.'}
                      </div>
                    </div>

                    <div
                      onClick={toggleDeaf}
                      style={{
                        padding: 16,
                        borderRadius: 6,
                        backgroundColor: selfDeaf ? 'rgba(242, 63, 67, 0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${selfDeaf ? '#f23f43' : 'var(--border-subtle)'}`,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-header)', fontSize: 14 }}>
                          Headphones
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: selfDeaf ? '#f23f43' : 'var(--presence-online)',
                          }}
                        >
                          {selfDeaf ? 'DEAFENED' : 'ACTIVE'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {selfDeaf ? 'Click to restore audio output.' : 'You can hear incoming participants.'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Floating Unsaved Changes Notice */}
          {hasProfileChanges && (
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                left: 24,
                right: 24,
                backgroundColor: 'rgba(17, 18, 20, 0.95)',
                backdropFilter: 'blur(12px)',
                borderRadius: 8,
                padding: '12px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                zIndex: 20,
              }}
            >
              <div style={{ fontSize: 14, color: '#f2f3f5', fontWeight: 600 }}>
                Careful — you have unsaved changes!
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  disabled={isSavingProfile}
                  onClick={handleResetProfile}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#f2f3f5',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '6px 12px',
                  }}
                >
                  Reset
                </button>

                <button
                  type="button"
                  disabled={isSavingProfile}
                  onClick={handleSaveProfile}
                  style={{
                    backgroundColor: '#23a55a',
                    border: 'none',
                    borderRadius: 4,
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: isSavingProfile ? 'not-allowed' : 'pointer',
                    padding: '8px 18px',
                    boxShadow: '0 2px 6px rgba(35, 165, 90, 0.4)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {isSavingProfile ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Confirmation Modal for Log Out */}
        {showLogoutConfirm && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.75)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1100,
              backdropFilter: 'blur(4px)',
            }}
            onClick={() => setShowLogoutConfirm(false)}
          >
            <div
              style={{
                backgroundColor: 'var(--bg-channels)',
                borderRadius: 8,
                padding: '24px',
                width: 400,
                maxWidth: '90%',
                border: '1px solid var(--border-subtle)',
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.7)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-header)', marginBottom: 8 }}>
                Log Out
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 20 }}>
                Are you sure you want to log out of Kith? You will need to log back in to access your servers and messages.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(false)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: 'transparent',
                    color: 'var(--text-header)',
                    fontSize: 14,
                    fontWeight: 600,
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
                    padding: '8px 16px',
                    borderRadius: 4,
                    border: 'none',
                    backgroundColor: '#f23f43',
                    color: '#ffffff',
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
