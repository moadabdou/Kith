import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  api,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_REFRESH,
  STORAGE_KEY_EXPIRES_AT,
} from './api'

describe('ApiClient session handling and token rotation', () => {
  const originalFetch = globalThis.fetch
  const mockStorage: Record<string, string> = {}

  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k])
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
    api.clearSession()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  it('stores and retrieves session data correctly', () => {
    api.setSession({
      token: 'jwt-token-1',
      refreshToken: 'refresh-token-1',
      expiresIn: 300,
    })

    expect(api.getToken()).toBe('jwt-token-1')
    expect(api.getRefreshToken()).toBe('refresh-token-1')
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe('jwt-token-1')
    expect(localStorage.getItem(STORAGE_KEY_REFRESH)).toBe('refresh-token-1')
    expect(localStorage.getItem(STORAGE_KEY_EXPIRES_AT)).toBeTruthy()
    expect(api.getExpiresAt()).toBeGreaterThan(Date.now())
    expect(api.isExpiringSoon(400_000)).toBe(true)
    expect(api.isExpiringSoon(10_000)).toBe(false)

    api.clearSession()
    expect(api.getToken()).toBeNull()
    expect(api.getRefreshToken()).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_REFRESH)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_EXPIRES_AT)).toBeNull()
  })

  it('intercepts 401 and replays request after refreshing tokens', async () => {
    api.setSession({
      token: 'expired-token',
      refreshToken: 'valid-refresh-token',
      expiresIn: 300,
    })

    let getMeCalls = 0
    let refreshCalls = 0

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/auth/refresh')) {
        refreshCalls++
        const body = JSON.parse(init?.body as string)
        expect(body.refresh_token).toBe('valid-refresh-token')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: 'new-refreshed-jwt',
            refresh_token: 'new-rotated-refresh-token',
            expires_in: 900,
          }),
        } as Response
      }

      if (urlStr.includes('/users/@me')) {
        getMeCalls++
        const authHeader = (init?.headers as Record<string, string>)?.['Authorization']
        if (authHeader === 'Bearer expired-token') {
          return {
            ok: false,
            status: 401,
            json: async () => ({ message: 'Unauthorized' }),
          } as Response
        }
        if (authHeader === 'Bearer new-refreshed-jwt') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: '123', username: 'alice' }),
          } as Response
        }
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not found' }),
      } as Response
    })

    const user = await api.getMe()
    expect(user.id).toBe('123')
    expect(user.username).toBe('alice')
    expect(getMeCalls).toBe(2) // 1st failed with 401, 2nd succeeded with new token
    expect(refreshCalls).toBe(1)
    expect(api.getToken()).toBe('new-refreshed-jwt')
    expect(api.getRefreshToken()).toBe('new-rotated-refresh-token')
  })

  it('queues concurrent 401 requests and executes only one /auth/refresh call', async () => {
    api.setSession({
      token: 'expired-token',
      refreshToken: 'valid-refresh-token',
      expiresIn: 300,
    })

    let refreshCalls = 0

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('/auth/refresh')) {
        refreshCalls++
        // Simulate a slight network delay
        await new Promise((r) => setTimeout(r, 20))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: 'new-refreshed-jwt',
            refresh_token: 'new-rotated-refresh-token',
            expires_in: 900,
          }),
        } as Response
      }

      const authHeader = (init?.headers as Record<string, string>)?.['Authorization']
      if (authHeader === 'Bearer expired-token') {
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: 'Unauthorized' }),
        } as Response
      }

      if (authHeader === 'Bearer new-refreshed-jwt') {
        if (urlStr.includes('/users/@me/guilds')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: 'guild-1', name: 'Guild 1' }],
          } as Response
        }
        if (urlStr.includes('/users/@me')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: '123', username: 'alice' }),
          } as Response
        }
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not found' }),
      } as Response
    })

    // Execute two concurrent requests while token is expired
    const [user, guilds] = await Promise.all([api.getMe(), api.getMyGuilds()])

    expect(user.username).toBe('alice')
    expect(guilds).toHaveLength(1)
    expect(refreshCalls).toBe(1) // Exactly one refresh call despite two concurrent 401s!
    expect(api.getToken()).toBe('new-refreshed-jwt')
  })

  it('triggers onUnauthorized and clears session when refresh token fails', async () => {
    api.setSession({
      token: 'expired-token',
      refreshToken: 'revoked-refresh-token',
      expiresIn: 300,
    })

    const onUnauthorizedMock = vi.fn()
    const unsub = api.onUnauthorized(onUnauthorizedMock)

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = url.toString()
      if (urlStr.includes('/auth/refresh')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: 'Invalid refresh token' }),
        } as Response
      }
      return {
        ok: false,
        status: 401,
        json: async () => ({ message: 'Unauthorized' }),
      } as Response
    })

    await expect(api.getMe()).rejects.toThrow()
    expect(onUnauthorizedMock).toHaveBeenCalled()
    expect(api.getToken()).toBeNull()
    expect(api.getRefreshToken()).toBeNull()

    unsub()
  })

  it('sends POST /auth/logout with refresh token on logout', async () => {
    api.setSession({
      token: 'jwt-123',
      refreshToken: 'refresh-456',
      expiresIn: 300,
    })

    let logoutPayload: any = null

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.toString().includes('/auth/logout')) {
        logoutPayload = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 204,
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    await api.logout()
    expect(logoutPayload).toEqual({ refresh_token: 'refresh-456' })
    expect(api.getToken()).toBeNull()
    expect(api.getRefreshToken()).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull()
  })

  it('handles verifyEmail and stores new session upon successful verification', async () => {
    let verifyPayload: any = null
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.toString().includes('/auth/verify-email')) {
        verifyPayload = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: 'verified-jwt-token',
            refresh_token: 'verified-refresh-token',
            expires_in: 900,
            user: {
              id: 'u-1',
              username: 'verifieduser',
              email: 'test@example.com',
              email_verified: true,
            },
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const res = await api.verifyEmail({ code: '123456', email: 'test@example.com' })
    expect(verifyPayload).toEqual({ code: '123456', email: 'test@example.com' })
    expect(res.user?.email_verified).toBe(true)
    expect(api.getToken()).toBe('verified-jwt-token')
    expect(api.getRefreshToken()).toBe('verified-refresh-token')
  })

  it('handles resendVerification request', async () => {
    let resendPayload: any = null
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.toString().includes('/auth/verify/resend')) {
        resendPayload = JSON.parse(init?.body as string)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: 'Verification email dispatched',
            cooldown: 60,
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const res = await api.resendVerification('test@example.com')
    expect(resendPayload).toEqual({ email: 'test@example.com' })
    expect(res.cooldown).toBe(60)
  })
})
