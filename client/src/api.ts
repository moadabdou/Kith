import type { Attachment, AuthResponse, Channel, ChannelLatest, ChannelOverwrite, GIFCategory, GIFResponse, Guild, GuildEmoji, GuildSticker, Member, Message, PresignedUpload, ReadState, ResendVerificationResponse, Role, SearchFilters, SearchResponse, User, VerifyEmailPayload } from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export const STORAGE_KEY_TOKEN = 'kith_token'
export const STORAGE_KEY_REFRESH = 'kith_refresh_token'
export const STORAGE_KEY_EXPIRES_AT = 'kith_expires_at'
export const STORAGE_KEY_USER = 'kith_user'

export interface SessionData {
  token: string
  refreshToken?: string | null
  expiresIn?: number | null // in seconds
  expiresAt?: number | null // timestamp in ms
}

class ApiClient {
  private token: string | null = null
  private refreshToken: string | null = null
  private expiresAt: number | null = null
  private refreshPromise: Promise<string> | null = null
  private authChangeListeners: Set<(token: string | null) => void> = new Set()
  private unauthorizedListeners: Set<() => void> = new Set()

  constructor() {
    if (typeof localStorage !== 'undefined') {
      this.token = localStorage.getItem(STORAGE_KEY_TOKEN)
      this.refreshToken = localStorage.getItem(STORAGE_KEY_REFRESH)
      const exp = localStorage.getItem(STORAGE_KEY_EXPIRES_AT)
      this.expiresAt = exp ? parseInt(exp, 10) : null
    }
  }

  setSession(data: SessionData | null) {
    if (!data || !data.token) {
      this.clearSession()
      return
    }

    this.token = data.token
    if (data.refreshToken !== undefined) {
      this.refreshToken = data.refreshToken
    }
    if (data.expiresIn) {
      this.expiresAt = Date.now() + data.expiresIn * 1000
    } else if (data.expiresAt) {
      this.expiresAt = data.expiresAt
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_TOKEN, this.token)
      if (this.refreshToken) {
        localStorage.setItem(STORAGE_KEY_REFRESH, this.refreshToken)
      } else {
        localStorage.removeItem(STORAGE_KEY_REFRESH)
      }
      if (this.expiresAt) {
        localStorage.setItem(STORAGE_KEY_EXPIRES_AT, this.expiresAt.toString())
      } else {
        localStorage.removeItem(STORAGE_KEY_EXPIRES_AT)
      }
    }

    this.notifyAuthChange(this.token)
  }

  setToken(token: string | null) {
    if (token) {
      this.setSession({ token, refreshToken: this.refreshToken, expiresAt: this.expiresAt })
    } else {
      this.clearSession()
    }
  }

  clearSession() {
    this.token = null
    this.refreshToken = null
    this.expiresAt = null
    this.refreshPromise = null
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_TOKEN)
      localStorage.removeItem(STORAGE_KEY_REFRESH)
      localStorage.removeItem(STORAGE_KEY_EXPIRES_AT)
    }
    this.notifyAuthChange(null)
  }

  getToken(): string | null {
    return this.token
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  getExpiresAt(): number | null {
    return this.expiresAt
  }

  isExpiringSoon(thresholdMs = 60_000): boolean {
    if (!this.expiresAt) return false
    return this.expiresAt - Date.now() < thresholdMs
  }

  onAuthChange(cb: (token: string | null) => void): () => void {
    this.authChangeListeners.add(cb)
    return () => {
      this.authChangeListeners.delete(cb)
    }
  }

  onUnauthorized(cb: () => void): () => void {
    this.unauthorizedListeners.add(cb)
    return () => {
      this.unauthorizedListeners.delete(cb)
    }
  }

  private notifyAuthChange(token: string | null) {
    for (const cb of this.authChangeListeners) {
      try {
        cb(token)
      } catch (e) {
        console.error('[API] Auth change listener error:', e)
      }
    }
  }

  private notifyUnauthorized() {
    for (const cb of this.unauthorizedListeners) {
      try {
        cb()
      } catch (e) {
        console.error('[API] Unauthorized listener error:', e)
      }
    }
  }

  async refreshTokens(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    const currentRefreshToken = this.refreshToken
    if (!currentRefreshToken) {
      this.clearSession()
      this.notifyUnauthorized()
      throw new Error('No refresh token available')
    }

    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ refresh_token: currentRefreshToken }),
        })

        if (!response.ok) {
          this.clearSession()
          this.notifyUnauthorized()
          throw new Error(`Token refresh failed with status ${response.status}`)
        }

        const data: AuthResponse = await response.json()
        this.setSession({
          token: data.token,
          refreshToken: data.refresh_token,
          expiresIn: data.expires_in,
        })
        return data.token
      } catch (err) {
        this.clearSession()
        this.notifyUnauthorized()
        throw err
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
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
      const isAuthEndpoint =
        path.startsWith('/auth/login') ||
        path.startsWith('/auth/register') ||
        path.startsWith('/auth/refresh') ||
        path.startsWith('/auth/logout') ||
        path.startsWith('/auth/verify')

      if (response.status === 401 && !isAuthEndpoint) {
        if (this.refreshToken && retryCount === 0) {
          try {
            const newToken = await this.refreshTokens()
            const retryOptions: RequestInit = {
              ...options,
              headers: {
                ...((options.headers as Record<string, string>) || {}),
                Authorization: `Bearer ${newToken}`,
              },
            }
            return this.request<T>(path, retryOptions, retryCount + 1)
          } catch {
            // Refresh failed, fall through to clearSession and notifyUnauthorized
          }
        }

        this.clearSession()
        this.notifyUnauthorized()
      }

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
    this.setSession({
      token: res.token,
      refreshToken: res.refresh_token,
      expiresIn: res.expires_in,
    })
    return res
  }

  async logout(): Promise<void> {
    const rf = this.refreshToken
    if (rf) {
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rf }),
        })
      } catch (err) {
        console.warn('[API] Logout request failed:', err)
      }
    }
    this.clearSession()
  }

  async register(username: string, email: string, password: string): Promise<User> {
    return this.request<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    })
  }

  async verifyEmail(payload: VerifyEmailPayload): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (res.token) {
      this.setSession({
        token: res.token,
        refreshToken: res.refresh_token,
        expiresIn: res.expires_in,
      })
    }
    return res
  }

  async resendVerification(email: string): Promise<ResendVerificationResponse> {
    return this.request<ResendVerificationResponse>('/auth/verify/resend', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
  }

  async getMe(): Promise<User> {
    return this.request<User>('/users/@me')
  }

  async updateMe(data: {
    username?: string
    avatar?: string | null
    banner?: string | null
    bio?: string | null
  }): Promise<User> {
    return this.request<User>('/users/@me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
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

  async updateGuild(
    guildId: string,
    data: { name?: string; icon?: string | null; banner?: string | null }
  ): Promise<Guild> {
    return this.request<Guild>(`/guilds/${guildId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
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

  async kickMember(guildId: string, userId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/members/${userId}`, {
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

  async sendMessage(
    guildId: string,
    channelId: string,
    content: string,
    attachmentIds?: string[],
    messageReference?: { message_id: string },
    stickerIds?: string[]
  ): Promise<Message> {
    return this.request<Message>(`/guilds/${guildId}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        attachment_ids: attachmentIds ?? [],
        message_reference: messageReference,
        sticker_ids: stickerIds,
      }),
    })
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<Message> {
    return this.request<Message>(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    })
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}`, {
      method: 'DELETE',
    })
  }

  // ── Pinned Messages (Phase 9, Issue #115) ───────────
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.request(`/channels/${channelId}/pins/${messageId}`, {
      method: 'PUT',
    })
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    await this.request(`/channels/${channelId}/pins/${messageId}`, {
      method: 'DELETE',
    })
  }

  async getPinnedMessages(channelId: string): Promise<Message[]> {
    return this.request<Message[]>(`/channels/${channelId}/pins`)
  }

  // ── Reactions ──────────────────────────────────────
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: 'PUT',
    })
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: 'DELETE',
    })
  }

  async removeUserReaction(channelId: string, messageId: string, emoji: string, userId: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`, {
      method: 'DELETE',
    })
  }

  async getReactors(channelId: string, messageId: string, emoji: string, limit = 25, after?: string): Promise<User[]> {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (after) params.set('after', after)
    const query = params.toString() ? `?${params.toString()}` : ''
    return this.request<User[]>(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}${query}`)
  }

  // ── Attachments (Phase 8 media, Discord-style presigned flow) ──
  // 1. presign -> 2. PUT bytes to upload_url -> 3. complete -> 4. send with ids
  async presignAttachment(
    channelId: string,
    data: { filename: string; content_type: string; byte_size: number }
  ): Promise<PresignedUpload> {
    return this.request<PresignedUpload>(`/channels/${channelId}/attachments/presign`, {
      method: 'POST',
      body: JSON.stringify({
        filename: data.filename,
        content_type: data.content_type,
        byte_size: data.byte_size,
      }),
    })
  }

  async getAttachment(channelId: string, attachmentId: string): Promise<Attachment> {
    return this.request<Attachment>(`/channels/${channelId}/attachments/${attachmentId}`)
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

  // ── Read States (Issue #103) ──────────────────────
  async ackMessage(channelId: string, messageId: string, manual = false, mentionCount = 0): Promise<void> {
    await this.request<void>(`/channels/${channelId}/messages/${messageId}/ack`, {
      method: 'POST',
      body: JSON.stringify({ manual, mention_count: mentionCount }),
    })
  }

  async getReadStates(): Promise<ReadState[]> {
    return this.request<ReadState[]>('/users/@me/read-states')
  }

  async getChannelsLatest(guildId: string): Promise<ChannelLatest[]> {
    return this.request<ChannelLatest[]>(`/guilds/${guildId}/channels/latest`)
  }

  async getChannelReadState(channelId: string): Promise<ReadState> {
    return this.request<ReadState>(`/channels/${channelId}/read-state`)
  }

  // ── Guild Custom Emojis & Stickers (Phase 9, Issue #118) ───
  async getGuildEmojis(guildId: string): Promise<GuildEmoji[]> {
    return this.request<GuildEmoji[]>(`/guilds/${guildId}/emojis`)
  }

  async uploadGuildEmoji(guildId: string, name: string, file: File): Promise<GuildEmoji> {
    const formData = new FormData()
    formData.append('name', name)
    formData.append('image', file)
    return this.request<GuildEmoji>(`/guilds/${guildId}/emojis`, {
      method: 'POST',
      body: formData,
    })
  }

  async deleteGuildEmoji(guildId: string, emojiId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/emojis/${emojiId}`, {
      method: 'DELETE',
    })
  }

  async getGuildStickers(guildId: string): Promise<GuildSticker[]> {
    return this.request<GuildSticker[]>(`/guilds/${guildId}/stickers`)
  }

  async uploadGuildSticker(guildId: string, name: string, file: File, description?: string): Promise<GuildSticker> {
    const formData = new FormData()
    formData.append('name', name)
    if (description) formData.append('description', description)
    formData.append('file', file)
    return this.request<GuildSticker>(`/guilds/${guildId}/stickers`, {
      method: 'POST',
      body: formData,
    })
  }

  async deleteGuildSticker(guildId: string, stickerId: string): Promise<void> {
    await this.request(`/guilds/${guildId}/stickers/${stickerId}`, {
      method: 'DELETE',
    })
  }

  async getTrendingGifs(page = 1, perPage = 24): Promise<GIFResponse> {
    return this.request<GIFResponse>(`/gifs/trending?page=${page}&per_page=${perPage}`)
  }

  async searchGifs(query: string, page = 1, perPage = 24): Promise<GIFResponse> {
    return this.request<GIFResponse>(`/gifs/search?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`)
  }

  async getGifCategories(): Promise<GIFCategory[]> {
    return this.request<GIFCategory[]>('/gifs/categories')
  }
}

export const api = new ApiClient()
