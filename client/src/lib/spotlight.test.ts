import { describe, it, expect } from 'vitest'
import {
  isBenignPlayAbort,
  isSpotlightTargetValid,
  isStreamLive,
  isTrackLive,
  resolveSpotlightStream,
  spotlightStorageKey,
} from './spotlight'

describe('spotlightStorageKey', () => {
  it('scopes the key per guild and channel', () => {
    expect(spotlightStorageKey('g1', 'c1')).toBe('kith_spotlight:g1:c1')
    expect(spotlightStorageKey('g1', 'c2')).not.toBe(spotlightStorageKey('g1', 'c1'))
  })
})

describe('resolveSpotlightStream', () => {
  it('prefers screen over camera for remote users', () => {
    const screen = { id: 'screen' } as unknown as MediaStream
    const cam = { id: 'cam' } as unknown as MediaStream
    const resolved = resolveSpotlightStream({
      isSelf: false,
      userId: 'u1',
      localVideoStream: null,
      localScreenStream: null,
      remoteVideoStreams: new Map([['u1', cam]]),
      remoteScreenStreams: new Map([['u1', screen]]),
    })
    expect(resolved).toEqual({ stream: screen, kind: 'screen' })
  })

  it('falls back to camera when no screen is shared', () => {
    const cam = { id: 'cam' } as unknown as MediaStream
    const resolved = resolveSpotlightStream({
      isSelf: false,
      userId: 'u1',
      localVideoStream: null,
      localScreenStream: null,
      remoteVideoStreams: new Map([['u1', cam]]),
      remoteScreenStreams: new Map(),
    })
    expect(resolved).toEqual({ stream: cam, kind: 'camera' })
  })

  it('resolves self streams from local state', () => {
    const localCam = { id: 'local-cam' } as unknown as MediaStream
    const localScreen = { id: 'local-screen' } as unknown as MediaStream
    expect(
      resolveSpotlightStream({
        isSelf: true,
        userId: 'me',
        localVideoStream: localCam,
        localScreenStream: null,
        remoteVideoStreams: new Map(),
        remoteScreenStreams: new Map(),
      })
    ).toEqual({ stream: localCam, kind: 'camera' })
    expect(
      resolveSpotlightStream({
        isSelf: true,
        userId: 'me',
        localVideoStream: localCam,
        localScreenStream: localScreen,
        remoteVideoStreams: new Map(),
        remoteScreenStreams: new Map(),
      })
    ).toEqual({ stream: localScreen, kind: 'screen' })
  })

  it('returns null stream (avatar fallback) when the user publishes nothing', () => {
    expect(
      resolveSpotlightStream({
        isSelf: false,
        userId: 'u9',
        localVideoStream: null,
        localScreenStream: null,
        remoteVideoStreams: new Map(),
        remoteScreenStreams: new Map(),
      })
    ).toEqual({ stream: null, kind: 'camera' })
  })
})

describe('isSpotlightTargetValid', () => {
  it('requires the target to be in the channel', () => {
    const members = new Set(['a', 'b'])
    expect(isSpotlightTargetValid('a', members)).toBe(true)
    expect(isSpotlightTargetValid('z', members)).toBe(false)
    expect(isSpotlightTargetValid(null, members)).toBe(false)
  })
})

describe('isTrackLive', () => {
  const track = (over: Partial<MediaStreamTrack> = {}) =>
    ({ readyState: 'live', enabled: true, muted: false, ...over }) as MediaStreamTrack

  it('is live for a normal live track', () => {
    expect(isTrackLive(track())).toBe(true)
  })

  it('ignores muted: a muted-but-live remote track still renders', () => {
    // The old spotlight gate (live && enabled && !muted) latched "Stream
    // ended" on exactly this state while the grid kept playing.
    expect(isTrackLive(track({ muted: true }))).toBe(true)
  })

  it('is dead on ended, disabled, or missing track', () => {
    expect(isTrackLive(track({ readyState: 'ended' }))).toBe(false)
    expect(isTrackLive(track({ enabled: false }))).toBe(false)
    expect(isTrackLive(null)).toBe(false)
    expect(isTrackLive(undefined)).toBe(false)
  })
})

describe('isStreamLive', () => {
  it('reflects the first video track, false for empty/null streams', () => {
    const live = {
      getVideoTracks: () => [{ readyState: 'live', enabled: true }],
    } as unknown as MediaStream
    const dead = {
      getVideoTracks: () => [{ readyState: 'ended', enabled: true }],
    } as unknown as MediaStream
    const empty = { getVideoTracks: () => [] } as unknown as MediaStream
    expect(isStreamLive(live)).toBe(true)
    expect(isStreamLive(dead)).toBe(false)
    expect(isStreamLive(empty)).toBe(false)
    expect(isStreamLive(null)).toBe(false)
  })
})

describe('isBenignPlayAbort', () => {
  it('matches only the interrupted-by-new-load AbortError', () => {
    const abort = Object.assign(new Error('The play() request was interrupted by a new load request.'), {
      name: 'AbortError',
    })
    expect(isBenignPlayAbort(abort)).toBe(true)
    expect(isBenignPlayAbort(Object.assign(new Error('nope'), { name: 'AbortError' }))).toBe(false)
    expect(isBenignPlayAbort(Object.assign(new Error('play() failed: user gesture required'), { name: 'NotAllowedError' }))).toBe(false)
    expect(isBenignPlayAbort(null)).toBe(false)
    expect(isBenignPlayAbort(undefined)).toBe(false)
  })
})
