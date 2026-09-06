import type { AuthResponse, Channel, Guild, Message, User } from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

class ApiClient {
  private token: string | null = null

  constructor() {
    this.token = localStorage.getItem('kith_token')
  }

  setToken(token: string | null) {
    this.token = token
    if (token) {
      localStorage.setItem('kith_token', token)
    } else {
      localStorage.removeItem('kith_token')
    }
  }

  getToken(): string | null {
    return this.token
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
      })
    } catch {
      throw new Error('API server unreachable. Please check connection.')
    }

    if (!response.ok) {
      let errBody: any
      try {
        errBody = await response.json()
      } catch {
        errBody = { message: `HTTP ${response.status}: ${response.statusText}` }
      }

      if (response.status === 429) {
        const retryAfter = errBody.retry_after ?? 5
        throw new Error(`Rate limited. Try again in ${retryAfter}s.`)
      }

      const msg = errBody.message || errBody.error || `Request failed with status ${response.status}`
      throw new Error(msg)
    }

    if (response.status === 204) {
      return {} as T
    }

    return response.json() as Promise<T>
  }

  // ── Auth ───────────────────────────────────────────
  async login(loginStr: string, passwordStr: string): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login: loginStr, password: passwordStr }),
    })
    this.setToken(res.token)
    return res
  }

  async register(username: string, email: string, password: string): Promise<User> {
    return this.request<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    })
  }

  async getMe(): Promise<User> {
    return this.request<User>('/users/@me')
  }

  // ── Guilds ─────────────────────────────────────────
  async getMyGuilds(): Promise<Guild[]> {
    return this.request<Guild[]>('/users/@me/guilds')
  }

  async createGuild(name: string): Promise<Guild> {
    return this.request<Guild>('/guilds', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }

  // ── Channels ───────────────────────────────────────
  async getChannels(guildId: string): Promise<Channel[]> {
    return this.request<Channel[]>(`/guilds/${guildId}/channels`)
  }

  async createChannel(guildId: string, name: string, type = 0): Promise<Channel> {
    return this.request<Channel>(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    })
  }

  // ── Messages ───────────────────────────────────────
  async getMessages(guildId: string, channelId: string, before?: string): Promise<Message[]> {
    const query = before ? `?before=${before}&limit=50` : '?limit=50'
    return this.request<Message[]>(`/guilds/${guildId}/channels/${channelId}/messages${query}`)
  }

  async sendMessage(guildId: string, channelId: string, content: string): Promise<Message> {
    return this.request<Message>(`/guilds/${guildId}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  }
}

export const api = new ApiClient()
