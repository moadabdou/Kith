export interface User {
  id: string
  username: string
  discriminator: string
  email: string
  created_at: string
}

export interface AuthResponse {
  token: string
  refresh_token: string
  expires_in: number
  user?: User
}

export interface Guild {
  id: string
  name: string
  owner_id: string
  created_at: string
}

export interface Channel {
  id: string
  guild_id: string
  type: number // 0 = text, 2 = voice
  name: string
  position: number
  parent_id?: string | null
  created_at: string
}

export interface AuthorRef {
  id: string
  username: string
  discriminator: string
}

export interface Message {
  id: string
  channel_id: string
  author: AuthorRef
  content: string
  timestamp: string
  edited_timestamp?: string | null
}

export interface Invite {
  code: string
  guild: {
    id: string
    name: string
  }
  channel: {
    id: string
    name: string
    type: number
  }
  inviter: AuthorRef
  uses: number
  max_uses: number
  expires_at: string | null
}

export interface ApiError {
  code?: number
  message: string
  retry_after?: number
  errors?: Record<string, { _errors: Array<{ code: string; message: string }> }>
}
