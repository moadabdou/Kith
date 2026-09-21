import { describe, it, expect } from 'vitest'
import {
  isSpotlightTargetValid,
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
