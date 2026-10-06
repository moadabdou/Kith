// Media device discovery and management utilities for microphones, speakers, and webcams.

export interface CategorizedMediaDevices {
  audioInputs: MediaDeviceInfo[]
  audioOutputs: MediaDeviceInfo[]
  videoInputs: MediaDeviceInfo[]
}

const STORAGE_KEY_INPUT = 'kith_voice_input_device'
const STORAGE_KEY_OUTPUT = 'kith_voice_output_device'
const STORAGE_KEY_CAMERA = 'kith_voice_camera_device'
const STORAGE_KEY_IN_VOL = 'kith_voice_input_volume'
const STORAGE_KEY_OUT_VOL = 'kith_voice_output_volume'

export async function getAllMediaDevices(): Promise<CategorizedMediaDevices> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { audioInputs: [], audioOutputs: [], videoInputs: [] }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      audioInputs: devices.filter((d) => d.kind === 'audioinput'),
      audioOutputs: devices.filter((d) => d.kind === 'audiooutput'),
      videoInputs: devices.filter((d) => d.kind === 'videoinput'),
    }
  } catch (err) {
    console.warn('[MediaDevices] Failed to enumerate media devices:', err)
    return { audioInputs: [], audioOutputs: [], videoInputs: [] }
  }
}

export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  const { audioInputs } = await getAllMediaDevices()
  return audioInputs
}

export async function getAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  const { audioOutputs } = await getAllMediaDevices()
  return audioOutputs
}

export async function getVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  const { videoInputs } = await getAllMediaDevices()
  return videoInputs
}

export function onMediaDeviceChange(callback: (devices: CategorizedMediaDevices) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
    return () => {}
  }

  const handler = async () => {
    const devices = await getAllMediaDevices()
    callback(devices)
  }

  navigator.mediaDevices.addEventListener('devicechange', handler)
  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', handler)
  }
}

// ── Persistent Device Preferences ────────────────────────────────────────

export function getInputDevicePreference(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY_INPUT)
}

export function setInputDevicePreference(deviceId: string | null): void {
  if (typeof localStorage === 'undefined') return
  if (deviceId) {
    localStorage.setItem(STORAGE_KEY_INPUT, deviceId)
  } else {
    localStorage.removeItem(STORAGE_KEY_INPUT)
  }
}

export function getOutputDevicePreference(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY_OUTPUT)
}

export function setOutputDevicePreference(deviceId: string | null): void {
  if (typeof localStorage === 'undefined') return
  if (deviceId) {
    localStorage.setItem(STORAGE_KEY_OUTPUT, deviceId)
  } else {
    localStorage.removeItem(STORAGE_KEY_OUTPUT)
  }
}

export function getCameraDevicePreference(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY_CAMERA)
}

export function setCameraDevicePreference(deviceId: string | null): void {
  if (typeof localStorage === 'undefined') return
  if (deviceId) {
    localStorage.setItem(STORAGE_KEY_CAMERA, deviceId)
  } else {
    localStorage.removeItem(STORAGE_KEY_CAMERA)
  }
}

export function getInputVolumePreference(): number {
  if (typeof localStorage === 'undefined') return 100
  const val = localStorage.getItem(STORAGE_KEY_IN_VOL)
  if (!val) return 100
  const parsed = parseInt(val, 10)
  return Number.isNaN(parsed) ? 100 : Math.min(Math.max(parsed, 0), 100)
}

export function setInputVolumePreference(volume: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY_IN_VOL, volume.toString())
}

export function getOutputVolumePreference(): number {
  if (typeof localStorage === 'undefined') return 100
  const val = localStorage.getItem(STORAGE_KEY_OUT_VOL)
  if (!val) return 100
  const parsed = parseInt(val, 10)
  return Number.isNaN(parsed) ? 100 : Math.min(Math.max(parsed, 0), 100)
}

export function setOutputVolumePreference(volume: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY_OUT_VOL, volume.toString())
}
