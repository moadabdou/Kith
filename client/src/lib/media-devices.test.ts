import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getAllMediaDevices,
  getAudioInputDevices,
  getAudioOutputDevices,
  getVideoInputDevices,
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
} from './media-devices'

describe('media-devices utility', () => {
  const mockStorage: Record<string, string> = {}

  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k])

    // Mock localStorage
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value
      },
      removeItem: (key: string) => {
        delete mockStorage[key]
      },
      clear: () => {
        Object.keys(mockStorage).forEach((k) => delete mockStorage[k])
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('device enumeration', () => {
    it('returns empty lists when navigator.mediaDevices is not available', async () => {
      vi.stubGlobal('navigator', {})
      const res = await getAllMediaDevices()
      expect(res).toEqual({ audioInputs: [], audioOutputs: [], videoInputs: [] })
    })

    it('categorizes media devices accurately', async () => {
      const mockDevices: Partial<MediaDeviceInfo>[] = [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Microphone' },
        { deviceId: 'mic-2', kind: 'audioinput', label: 'Built-in Mic' },
        { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Headphones' },
        { deviceId: 'cam-1', kind: 'videoinput', label: 'HD Webcam' },
      ]

      vi.stubGlobal('navigator', {
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
        },
      })

      const all = await getAllMediaDevices()
      expect(all.audioInputs).toHaveLength(2)
      expect(all.audioOutputs).toHaveLength(1)
      expect(all.videoInputs).toHaveLength(1)

      const mics = await getAudioInputDevices()
      expect(mics).toHaveLength(2)
      expect(mics[0].deviceId).toBe('mic-1')

      const speakers = await getAudioOutputDevices()
      expect(speakers).toHaveLength(1)
      expect(speakers[0].deviceId).toBe('speaker-1')

      const cams = await getVideoInputDevices()
      expect(cams).toHaveLength(1)
      expect(cams[0].deviceId).toBe('cam-1')
    })
  })

  describe('localStorage preferences', () => {
    it('reads and saves input device preference', () => {
      expect(getInputDevicePreference()).toBeNull()
      setInputDevicePreference('custom-mic-id')
      expect(getInputDevicePreference()).toBe('custom-mic-id')
      setInputDevicePreference(null)
      expect(getInputDevicePreference()).toBeNull()
    })

    it('reads and saves output device preference', () => {
      expect(getOutputDevicePreference()).toBeNull()
      setOutputDevicePreference('speaker-id')
      expect(getOutputDevicePreference()).toBe('speaker-id')
      setOutputDevicePreference(null)
      expect(getOutputDevicePreference()).toBeNull()
    })

    it('reads and saves camera device preference', () => {
      expect(getCameraDevicePreference()).toBeNull()
      setCameraDevicePreference('webcam-id')
      expect(getCameraDevicePreference()).toBe('webcam-id')
      setCameraDevicePreference(null)
      expect(getCameraDevicePreference()).toBeNull()
    })

    it('reads and saves input and output volumes within 0-100 bounds', () => {
      expect(getInputVolumePreference()).toBe(100)
      setInputVolumePreference(75)
      expect(getInputVolumePreference()).toBe(75)

      expect(getOutputVolumePreference()).toBe(100)
      setOutputVolumePreference(50)
      expect(getOutputVolumePreference()).toBe(50)
    })
  })
})
