// WebRTC client for communicating with the Pion SFU media server.
// Handles WebSocket signaling, SDP offer/answer exchange, ICE candidates,
// audio playout, microphone capture, speaking detection, and mute/deafen controls.

export interface SfuClientOptions {
  endpoint: string
  token: string
  channelId: string
  guildId?: string
  rtcConfig?: RTCConfiguration
  onConnectionStateChange?: (state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void
  onSpeakingChange?: (userId: string, isSpeaking: boolean) => void
  onRemoteTrack?: (track: MediaStreamTrack, stream: MediaStream) => void
  onRemoteVideoChange?: (userId: string, stream: MediaStream | null) => void
  onLocalVideoChange?: (stream: MediaStream | null) => void
  onError?: (error: Error) => void
}

export function resolveSfuWsUrl(endpoint: string): string {
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    return endpoint.endsWith('/ws') ? endpoint : `${endpoint.replace(/\/$/, '')}/ws`
  }

  const isHttps = endpoint.startsWith('https://')
  const clean = endpoint.replace(/^(http:\/\/|https:\/\/)/, '').replace(/\/.*$/, '')
  const parts = clean.split(':')
  let host = parts[0]
  const port = parts[1] || '5000'

  if (typeof window !== 'undefined' && window.location) {
    const currentHost = window.location.hostname
    if (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === 'sfu' ||
      host === 'sfu.kith.local' ||
      host === '0.0.0.0'
    ) {
      host = currentHost || '127.0.0.1'
    }
  }

  const protocol =
    isHttps || (typeof window !== 'undefined' && window.location?.protocol === 'https:')
      ? 'wss:'
      : 'ws:'
  return `${protocol}//${host}:${port}/ws`
}

export class SfuClient {
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private localVideoStream: MediaStream | null = null
  private localVideoTrack: MediaStreamTrack | null = null
  private videoSender: RTCRtpSender | null = null
  private isCameraOn = false
  private selectedVideoDeviceId: string | null = null
  private remoteVideoStreams: Map<string, MediaStream> = new Map()

  private audioElements: Map<string, HTMLAudioElement> = new Map()
  private userToTrackMap: Map<string, string> = new Map()
  private vadCleanup: (() => void) | null = null
  private unlockAudioCleanup: (() => void) | null = null

  private options: SfuClientOptions
  private isMuted = false
  private isDeafened = false
  private isClosed = false
  private isListenOnly = false
  private pendingCandidates: RTCIceCandidateInit[] = []
  private queue: Array<() => Promise<void>> = []
  private processingQueue = false

  constructor(options: SfuClientOptions) {
    this.options = {
      rtcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      ...options,
    }
  }

  public async connect(): Promise<void> {
    if (this.isClosed) return

    const wsUrl = resolveSfuWsUrl(this.options.endpoint)
    this.options.onConnectionStateChange?.('connecting')

    return new Promise((resolve, reject) => {
      let resolved = false

      try {
        this.ws = new WebSocket(wsUrl)
      } catch (err) {
        this.options.onConnectionStateChange?.('failed')
        reject(err)
        return
      }

      this.ws.onopen = async () => {
        try {
          await this.initPeerConnection()

          // Send join message
          this.sendWsMessage({
            type: 'join',
            token: this.options.token,
            channel_id: this.options.channelId,
            guild_id: this.options.guildId,
            listen_only: this.isListenOnly,
          })

          if (!this.isListenOnly) {
            await this.publishLocalAudio()
          }

          if (!resolved) {
            resolved = true
            resolve()
          }
        } catch (err) {
          if (!resolved) {
            resolved = true
            reject(err)
          }
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          return this.enqueue(() => this.handleWsMessage(msg))
        } catch (err) {
          console.error('[SfuClient] Error parsing WS message:', err)
        }
      }

      this.ws.onerror = (event) => {
        console.error('[SfuClient] WebSocket error:', event)
        this.options.onError?.(new Error('SFU WebSocket error'))
        if (!resolved) {
          resolved = true
          reject(new Error('Failed to connect to SFU WebSocket'))
        }
      }

      this.ws.onclose = () => {
        if (!this.isClosed) {
          this.options.onConnectionStateChange?.('disconnected')
          this.cleanup()
        }
      }
    })
  }

  private async initPeerConnection(): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      return
    }

    this.pc = new RTCPeerConnection(this.options.rtcConfig)

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendWsMessage({
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return
      const state = this.pc.connectionState
      if (state === 'connected') {
        this.options.onConnectionStateChange?.('connected')
      } else if (state === 'failed' || state === 'disconnected') {
        this.options.onConnectionStateChange?.(state)
      }
    }

    this.pc.ontrack = (event) => {
      this.handleRemoteTrack(event.track, event.streams[0] || null)
    }

    // Try to acquire mic stream unless explicitly in listen-only mode
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })

        this.localStream.getAudioTracks().forEach((track) => {
          track.enabled = !this.isMuted
          if (this.pc && this.localStream) {
            this.pc.addTrack(track, this.localStream)
          }
        })

        this.initVoiceActivityDetector(this.localStream)
      }
    } catch (err) {
      console.warn('[SfuClient] Microphone access unavailable, falling back to listen-only:', err)
      this.isListenOnly = true
    }
  }

  private async publishLocalAudio(): Promise<void> {
    if (!this.pc) return

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    this.sendWsMessage({
      type: 'offer',
      sdp: offer.sdp,
    })
  }

  private async handleWsMessage(msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case 'joined':
        this.options.onConnectionStateChange?.('connected')
        break

      case 'answer':
        if (this.pc && msg.sdp) {
          await this.pc.setRemoteDescription({
            type: 'answer',
            sdp: msg.sdp,
          })
          await this.drainPendingCandidates()
        }
        break

      case 'offer':
        // Downstream renegotiation offer from SFU
        if (this.pc && msg.sdp) {
          if (this.pc.signalingState && this.pc.signalingState !== 'stable') {
            await new Promise<void>((resolve) => {
              const check = () => {
                if (!this.pc || this.pc.signalingState === 'stable') {
                  this.pc?.removeEventListener('signalingstatechange', check)
                  resolve()
                }
              }
              this.pc?.addEventListener('signalingstatechange', check)
              setTimeout(check, 1000)
            })
          }

          await this.pc.setRemoteDescription({
            type: 'offer',
            sdp: msg.sdp,
          })
          await this.drainPendingCandidates()

          const answer = await this.pc.createAnswer()
          await this.pc.setLocalDescription(answer)

          this.sendWsMessage({
            type: 'answer',
            sdp: answer.sdp,
          })

          this.attachTransceiverTracks()
        }
        break

      case 'candidate':
        if (msg.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          } else {
            this.pendingCandidates.push(msg.candidate)
          }
        }
        break

      case 'speaking':
        if (msg.user_id && typeof msg.speaking === 'boolean') {
          this.options.onSpeakingChange?.(msg.user_id, msg.speaking)
        }
        break

      case 'video':
        if (msg.user_id && typeof msg.video === 'boolean') {
          if (!msg.video) {
            this.remoteVideoStreams.delete(msg.user_id)
            this.options.onRemoteVideoChange?.(msg.user_id, null)
          }
        }
        break

      case 'peer_left':
        if (msg.user_id) {
          this.options.onSpeakingChange?.(msg.user_id, false)
          this.cleanupPeerAudio(msg.user_id)
          if (this.remoteVideoStreams.has(msg.user_id)) {
            this.remoteVideoStreams.delete(msg.user_id)
            this.options.onRemoteVideoChange?.(msg.user_id, null)
          }
        }
        break

      case 'error':
        console.error('[SfuClient] SFU error:', msg.message)
        this.options.onError?.(new Error(msg.message || 'SFU error'))
        break

      default:
        break
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await task()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      this.processQueue()
    })
  }

  private async processQueue() {
    if (this.processingQueue) return
    this.processingQueue = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        try {
          await task()
        } catch (err) {
          console.error('[SfuClient] Error processing signaling task:', err)
        }
      }
    }
    this.processingQueue = false
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) return
    while (this.pendingCandidates.length > 0) {
      const c = this.pendingCandidates.shift()
      if (c) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(c))
        } catch (err) {
          console.warn('[SfuClient] Failed to add queued ICE candidate:', err)
        }
      }
    }
  }

  private attachTransceiverTracks(): void {
    if (!this.pc || typeof document === 'undefined') return
    for (const transceiver of this.pc.getTransceivers()) {
      const track = transceiver.receiver?.track
      if (track && track.readyState === 'live') {
        this.handleRemoteTrack(track, null)
      }
    }
  }

  private handleRemoteTrack(track: MediaStreamTrack, initialStream: MediaStream | null): void {
    const stream = initialStream || new MediaStream([track])
    this.options.onRemoteTrack?.(track, stream)

    const streamId = stream?.id || ''
    const trackId = track?.id || ''
    const publisherUid = streamId.startsWith('kith-stream-')
      ? streamId.replace('kith-stream-', '')
      : trackId.startsWith('kith-track-')
      ? trackId.replace('kith-track-', '').replace('-video', '').replace('-audio', '')
      : ''

    if (track.kind === 'video') {
      const videoKey = publisherUid || track.id
      this.remoteVideoStreams.set(videoKey, stream)
      this.options.onRemoteVideoChange?.(videoKey, stream)

      track.onended = () => {
        if (this.remoteVideoStreams.get(videoKey) === stream) {
          this.remoteVideoStreams.delete(videoKey)
          this.options.onRemoteVideoChange?.(videoKey, null)
        }
      }
      return
    }

    const audioKey = publisherUid || track.id
    if (publisherUid) {
      this.userToTrackMap.set(publisherUid, track.id)
    }

    if (typeof document !== 'undefined') {
      let audioEl = this.audioElements.get(audioKey)
      if (!audioEl || !document.body.contains(audioEl)) {
        audioEl = document.createElement('audio')
        audioEl.autoplay = true
        audioEl.setAttribute?.('playsinline', 'true')
        audioEl.muted = this.isDeafened
        audioEl.style.position = 'fixed'
        audioEl.style.opacity = '0'
        audioEl.style.pointerEvents = 'none'
        audioEl.style.width = '1px'
        audioEl.style.height = '1px'
        audioEl.style.bottom = '0'
        document.body.appendChild(audioEl)
        this.audioElements.set(audioKey, audioEl)
      }

      audioEl.srcObject = stream

      track.onended = () => {
        if (this.audioElements.get(audioKey) === audioEl) {
          audioEl.srcObject = null
          audioEl.remove()
          this.audioElements.delete(audioKey)
        }
      }

      const playPromise = audioEl.play()
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[SfuClient] Autoplay prevented, registering user gesture unlock:', err)
          this.ensureGlobalAudioUnlock()
        })
      }
    }
  }

  private cleanupPeerAudio(userId: string): void {
    const directEl = this.audioElements.get(userId)
    if (directEl) {
      directEl.srcObject = null
      directEl.remove()
      this.audioElements.delete(userId)
    }
    const trackId = this.userToTrackMap.get(userId)
    if (trackId) {
      const el = this.audioElements.get(trackId)
      if (el) {
        el.srcObject = null
        el.remove()
        this.audioElements.delete(trackId)
      }
      this.userToTrackMap.delete(userId)
    }
  }

  private ensureGlobalAudioUnlock(): void {
    if (typeof window === 'undefined' || this.unlockAudioCleanup) return

    const unlock = () => {
      for (const el of this.audioElements.values()) {
        if (el.paused) {
          el.play().catch(() => {})
        }
      }
    }

    const events = ['click', 'keydown', 'pointerdown', 'touchstart']
    const handler = () => {
      unlock()
    }

    for (const ev of events) {
      window.addEventListener(ev, handler)
    }

    this.unlockAudioCleanup = () => {
      for (const ev of events) {
        window.removeEventListener(ev, handler)
      }
      this.unlockAudioCleanup = null
    }
  }

  private initVoiceActivityDetector(stream: MediaStream): void {
    if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
      return
    }

    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
      const resumeAudioCtx = () => {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {})
        }
      }
      const resumeEvents = ['click', 'keydown', 'pointerdown', 'touchstart']
      resumeEvents.forEach((ev) => window.addEventListener(ev, resumeAudioCtx))

      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      const buffer = new Uint8Array(analyser.frequencyBinCount)
      let isSpeaking = false
      let silenceCounter = 0

      const intervalId = window.setInterval(() => {
        if (this.isClosed || this.isMuted) {
          if (isSpeaking) {
            isSpeaking = false
            this.sendWsMessage({ type: 'speaking', speaking: false })
          }
          return
        }

        analyser.getByteFrequencyData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i]
        }
        const avg = sum / buffer.length

        // Speaking threshold: volume above threshold
        if (avg > 18) {
          silenceCounter = 0
          if (!isSpeaking) {
            isSpeaking = true
            this.sendWsMessage({ type: 'speaking', speaking: true })
          }
        } else {
          silenceCounter++
          if (isSpeaking && silenceCounter > 8) {
            // ~400ms silence
            isSpeaking = false
            this.sendWsMessage({ type: 'speaking', speaking: false })
          }
        }
      }, 50)

      this.vadCleanup = () => {
        window.clearInterval(intervalId)
        resumeEvents.forEach((ev) => window.removeEventListener(ev, resumeAudioCtx))
        source.disconnect()
        analyser.disconnect()
        audioCtx.close().catch(() => {})
      }
    } catch (err) {
      console.warn('[SfuClient] Voice activity detector initialization skipped:', err)
    }
  }

  public setMute(mute: boolean): void {
    this.isMuted = mute
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !mute
      })
    }
    if (mute) {
      this.sendWsMessage({ type: 'speaking', speaking: false })
    }
  }

  public setDeaf(deaf: boolean): void {
    this.isDeafened = deaf
    for (const audioEl of this.audioElements.values()) {
      audioEl.muted = deaf
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this.isClosed
  }

  public isCameraActive(): boolean {
    return this.isCameraOn
  }

  public getLocalVideoStream(): MediaStream | null {
    return this.localVideoStream
  }

  public getRemoteVideoStreams(): Map<string, MediaStream> {
    return new Map(this.remoteVideoStreams)
  }

  public async setCameraEnabled(enabled: boolean, deviceId?: string): Promise<MediaStream | null> {
    if (this.isClosed) return null

    if (deviceId) {
      this.selectedVideoDeviceId = deviceId
    }

    if (enabled) {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access not supported in this environment')
        }

        const constraints: MediaStreamConstraints = {
          video: {
            deviceId: this.selectedVideoDeviceId ? { exact: this.selectedVideoDeviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        const track = stream.getVideoTracks()[0]
        if (!track) {
          throw new Error('No video track found in acquired media stream')
        }

        if (this.localVideoTrack) {
          this.localVideoTrack.stop()
        }

        this.localVideoTrack = track
        this.localVideoStream = stream
        this.isCameraOn = true

        if (this.pc) {
          if (this.videoSender) {
            await this.videoSender.replaceTrack(track)
          } else {
            this.videoSender = this.pc.addTrack(track, stream)
            await this.renegotiate()
          }
        }

        this.sendWsMessage({ type: 'video', video: true })
        this.options.onLocalVideoChange?.(this.localVideoStream)
        return this.localVideoStream
      } catch (err: any) {
        console.error('[SfuClient] Failed to enable camera:', err)
        this.isCameraOn = false
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    } else {
      if (this.localVideoTrack) {
        this.localVideoTrack.stop()
        this.localVideoTrack = null
      }
      this.localVideoStream = null
      this.isCameraOn = false

      if (this.pc && this.videoSender) {
        try {
          this.pc.removeTrack(this.videoSender)
        } catch (err) {
          console.warn('[SfuClient] Failed to remove video sender:', err)
        }
        this.videoSender = null
        await this.renegotiate()
      }

      this.sendWsMessage({ type: 'video', video: false })
      this.options.onLocalVideoChange?.(null)
      return null
    }
  }

  public async setCameraDevice(deviceId: string): Promise<void> {
    this.selectedVideoDeviceId = deviceId
    if (this.isCameraOn) {
      await this.setCameraEnabled(true, deviceId)
    }
  }

  private async renegotiate(): Promise<void> {
    if (!this.pc || this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return

    if (this.pc.signalingState && this.pc.signalingState !== 'stable') {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.pc || this.pc.signalingState === 'stable') {
            this.pc?.removeEventListener('signalingstatechange', check)
            resolve()
          }
        }
        this.pc?.addEventListener('signalingstatechange', check)
        setTimeout(check, 1000)
      })
    }

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    this.sendWsMessage({
      type: 'offer',
      sdp: offer.sdp,
    })
  }

  public disconnect(isExplicitLeave = true): void {
    if (this.isClosed) return
    this.isClosed = true

    if (isExplicitLeave && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.sendWsMessage({ type: 'leave' })
      } catch {}
    }

    this.cleanup()
    this.options.onConnectionStateChange?.('disconnected')
  }

  private cleanup(): void {
    this.queue = []
    if (this.vadCleanup) {
      this.vadCleanup()
      this.vadCleanup = null
    }

    if (this.unlockAudioCleanup) {
      this.unlockAudioCleanup()
    }
    this.userToTrackMap.clear()

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop())
      this.localStream = null
    }

    if (this.localVideoTrack) {
      this.localVideoTrack.stop()
      this.localVideoTrack = null
    }
    this.localVideoStream = null
    this.videoSender = null
    this.isCameraOn = false
    this.remoteVideoStreams.clear()

    for (const audioEl of this.audioElements.values()) {
      audioEl.srcObject = null
      audioEl.remove()
    }
    this.audioElements.clear()

    if (this.pc) {
      this.pc.close()
      this.pc = null
    }

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }

  private sendWsMessage(msg: Record<string, any>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}
