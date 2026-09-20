// Helper utilities for querying and managing video input devices (webcams).

export async function getVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return []
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput')
  } catch (err) {
    console.warn('[VideoDevices] Failed to enumerate video devices:', err)
    return []
  }
}

export function onDeviceChange(callback: (devices: MediaDeviceInfo[]) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
    return () => {}
  }

  const handler = async () => {
    const devices = await getVideoInputDevices()
    callback(devices)
  }

  navigator.mediaDevices.addEventListener('devicechange', handler)
  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', handler)
  }
}
