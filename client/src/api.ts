import type { AuthResponse, Channel, ChannelOverwrite, Guild, Member, Message, Role, SearchFilters, SearchResponse, User } from './types'

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

  private async request<T>(path: string, options: RequestInit = {}, retryCount = 0): Promise<T> {
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
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw err
      }
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
        const retryAfterSec = errBody.retry_after ?? parseFloat(response.headers.get('Retry-After') || '1') ?? 1
        // Discord client rate limit pacing: automatically wait and retry up to 2 times
        if (retryCount < 2 && !options.signal?.aborted) {
          const waitMs = Math.min(Math.max(retryAfterSec * 1000, 500), 3000)
          console.warn(`[API] Rate limited (429) on ${path}. Backing off for ${waitMs}ms... (attempt ${retryCount + 1}/2)`)
          await new Promise((resolve) => setTimeout(resolve, waitMs))
          if (options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }
          return this.request<T>(path, options, retryCount + 1)
        }
        throw new Error(`Rate limited. Try again in ${retryAfterSec}s.`)
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

  async getRoles(guildId: string): Promise<Role[]> {
    return this.request<Role[]>(`/guilds/${guildId}/roles`)
  }

  async createRole(
    guildId: string,
    data?: {
      name?: string
      color?: number
      hoist?: boolean
      position?: number
      permissions?: string
      mentionable?: boolean
    }
  ): Promise<Role> {
    return this.request<Role>(`/guilds/${guildId}/roles`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    })
  }

  async updateRole(
    guildId: string,
    roleId: string,
    data: {
      name?: string
      color?: number
      hoist?: boolean
      position?: number
      permissions?: string
      mentionable?: boolean
    }
  ): Promise<Role> {
    return this.request<Role>(`/guilds/${guildId}/roles/${roleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/roles/${roleId}`, {
      method: 'DELETE',
    })
  }

  async getMyPermissions(guildId: string): Promise<{ permissions: string }> {
    return this.request<{ permissions: string }>(`/guilds/${guildId}/permissions/me`)
  }

  async getMembers(guildId: string): Promise<Member[]> {
    return this.request<Member[]>(`/guilds/${guildId}/members`)
  }

  async assignMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'PUT',
    })
  }

  async unassignMemberRole(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'DELETE',
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

  async updateChannel(
    channelId: string,
    data: { name?: string; position?: number }
  ): Promise<Channel> {
    return this.request<Channel>(`/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.request(`/channels/${channelId}`, {
      method: 'DELETE',
    })
  }

  async getChannelOverwrites(channelId: string): Promise<ChannelOverwrite[]> {
    return this.request<ChannelOverwrite[]>(`/channels/${channelId}/permissions`)
  }

  async setChannelOverwrite(
    channelId: string,
    targetId: string,
    data: { type: number; allow: string; deny: string }
  ): Promise<void> {
    await this.request(`/channels/${channelId}/permissions/${targetId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteChannelOverwrite(channelId: string, targetId: string): Promise<void> {
    await this.request(`/channels/${channelId}/permissions/${targetId}`, {
      method: 'DELETE',
    })
  }

  // ── Messages ───────────────────────────────────────
  async getMessages(
    guildId: string,
    channelId: string,
    before?: string,
    limit = 50,
    after?: string
  ): Promise<Message[]> {
    const params = new URLSearchParams()
    if (before) params.set('before', before)
    if (after) params.set('after', after)
    if (limit) params.set('limit', String(limit))
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.request<Message[]>(`/guilds/${guildId}/channels/${channelId}/messages${query}`)
  }

  async sendMessage(guildId: string, channelId: string, content: string): Promise<Message> {
    return this.request<Message>(`/guilds/${guildId}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  }

  // ── Search ─────────────────────────────────────────
  async searchMessages(
    guildId: string,
    query: string,
    filters?: SearchFilters
  ): Promise<SearchResponse> {
    const params = new URLSearchParams()
    params.set('q', query)
    if (filters?.channelId) params.set('channel_id', filters.channelId)
    if (filters?.authorId) params.set('author_id', filters.authorId)
    if (filters?.before) params.set('before', filters.before)
    if (filters?.limit) params.set('limit', String(filters.limit))
    if (filters?.offset !== undefined) params.set('offset', String(filters.offset))

    return this.request<SearchResponse>(`/guilds/${guildId}/messages/search?${params.toString()}`, {
      signal: filters?.signal,
    })
  }

  // ── Invites ────────────────────────────────────────
  async createInvite(channelId: string, maxAge = 86400, maxUses = 0): Promise<import('./types').Invite> {
    return this.request<import('./types').Invite>('/invites', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, max_age: maxAge, max_uses: maxUses }),
    })
  }

  async joinInvite(code: string): Promise<Guild> {
    const cleanCode = code.trim().replace(/^.*\/join\//, '').replace(/^.*\/invites?\//, '')
    return this.request<Guild>(`/invites/${encodeURIComponent(cleanCode)}/join`, {
      method: 'POST',
    })
  }
}

export const api = new ApiClient()
