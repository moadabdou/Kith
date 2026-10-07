import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './AuthContext'
import { useAuth } from './useAuth'
import { api, STORAGE_KEY_TOKEN, STORAGE_KEY_USER } from '../api'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

class MockHTMLIFrameElement {}
class MockNode {}
;(globalThis as any).HTMLIFrameElement = MockHTMLIFrameElement
;(globalThis as any).Node = MockNode

function createMockElement(tag = 'div') {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [] as any[],
    style: {},
    setAttribute: () => {},
    removeAttribute: () => {},
    appendChild: function (c: any) {
      this.children.push(c)
      return c
    },
    removeChild: function (c: any) {
      return c
    },
    insertBefore: function (c: any) {
      return c
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    ownerDocument: null as any,
  }
}

const mockDoc = {
  nodeType: 9,
  defaultView: globalThis,
  createElement: (tag: string) => {
    const el = createMockElement(tag)
    el.ownerDocument = mockDoc
    return el
  },
  createElementNS: (_ns: string, tag: string) => {
    const el = createMockElement(tag)
    el.ownerDocument = mockDoc
    return el
  },
  createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
  createComment: (t: string) => ({ nodeType: 8, textContent: t }),
  addEventListener: () => {},
  removeEventListener: () => {},
}

const windowListeners: Record<string, Set<(e: any) => void>> = {}

;(globalThis as any).document = mockDoc
;(globalThis as any).window = {
  addEventListener: (event: string, cb: any) => {
    if (!windowListeners[event]) windowListeners[event] = new Set()
    windowListeners[event].add(cb)
  },
  removeEventListener: (event: string, cb: any) => {
    windowListeners[event]?.delete(cb)
  },
  dispatchEvent: (event: any) => {
    windowListeners[event.type]?.forEach((cb) => cb(event))
    return true
  },
}

describe('AuthProvider session lifecycle', () => {
  const originalFetch = globalThis.fetch
  const mockStorage: Record<string, string> = {}
  let authValue: ReturnType<typeof useAuth> | null = null
  let root: any = null

  function Consumer() {
    const val = useAuth()
    useEffect(() => {
      authValue = val
    })
    return null
  }

  beforeEach(() => {
    authValue = null
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

    const rootEl = createMockElement('div')
    rootEl.ownerDocument = mockDoc
    root = createRoot(rootEl as any)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
    }
    globalThis.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  it('restores cached user and token on initial render', async () => {
    mockStorage[STORAGE_KEY_TOKEN] = 'test-jwt-token'
    mockStorage[STORAGE_KEY_USER] = JSON.stringify({ id: '1', username: 'bob' })
    api.setToken('test-jwt-token')

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.toString().includes('/users/@me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: '1', username: 'bob' }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    await act(async () => {
      root.render(
        <AuthProvider>
          <Consumer />
        </AuthProvider>,
      )
    })

    expect(authValue?.user?.username).toBe('bob')
    expect(authValue?.token).toBe('test-jwt-token')
  })

  it('updates token when api fires onAuthChange', async () => {
    mockStorage[STORAGE_KEY_TOKEN] = 'initial-token'
    mockStorage[STORAGE_KEY_USER] = JSON.stringify({ id: '1', username: 'bob' })
    api.setToken('initial-token')

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '1', username: 'bob' }),
      } as Response
    })

    await act(async () => {
      root.render(
        <AuthProvider>
          <Consumer />
        </AuthProvider>,
      )
    })

    expect(authValue?.token).toBe('initial-token')

    await act(async () => {
      api.setSession({ token: 'rotated-token', refreshToken: 'ref-1', expiresIn: 300 })
    })

    expect(authValue?.token).toBe('rotated-token')
  })

  it('clears state when logout is called', async () => {
    mockStorage[STORAGE_KEY_TOKEN] = 'active-token'
    mockStorage[STORAGE_KEY_USER] = JSON.stringify({ id: '1', username: 'bob' })
    api.setToken('active-token')

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.toString().includes('/auth/logout')) {
        return { ok: true, status: 204 } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '1', username: 'bob' }),
      } as Response
    })

    await act(async () => {
      root.render(
        <AuthProvider>
          <Consumer />
        </AuthProvider>,
      )
    })

    expect(authValue?.user?.username).toBe('bob')

    await act(async () => {
      await authValue?.logout()
    })

    expect(authValue?.user).toBeNull()
    expect(authValue?.token).toBeNull()
    expect(api.getToken()).toBeNull()
  })
})
