import { randomUUID } from "crypto"
import { SSEService } from "./sse"
import { ChatDAO } from "../db/dao"
import type { ChatSessionRow, ChatMessageRow } from "../db/types"

export interface ChatSession {
  id: string
  workspaceId: string
  title: string | null
  isActive: boolean
  provider: string
  providerSessionId: string | null
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  totalMessageCount: number
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: string
  type: string
  content: string
  metadata: string | null
  createdAt: string
}

function toSession(row: ChatSessionRow, messages: ChatMessage[] = [], totalMessageCount: number = 0): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    isActive: row.is_active === 1,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    totalMessageCount,
  }
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    type: row.type,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

export class ChatService {
  private dao: ChatDAO
  private sse: SSEService

  constructor(dao: ChatDAO, sse: SSEService) {
    this.dao = dao
    this.sse = sse
  }

  async updateProviderSession(sessionId: string, providerSessionId: string): Promise<void> {
    await this.dao.updateProviderSession(sessionId, providerSessionId)
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.dao.updateSession(sessionId, { title })
  }

  async createSession(workspaceId: string, title?: string): Promise<ChatSession> {
    const id = randomUUID()
    const now = new Date().toISOString()
    await this.dao.insertSession({
      id, workspace_id: workspaceId,
      title: title ?? null,
      created_at: now, updated_at: now,
    })
    return (await this.getSession(id))!
  }

  async listSessions(workspaceId: string): Promise<ChatSession[]> {
    const rows = await this.dao.listSessions(workspaceId)
    return rows.map(r => toSession(r))
  }

  async getSession(sessionId: string, limit?: number, beforeCreatedAt?: string): Promise<ChatSession | undefined> {
    const row = await this.dao.findSessionById(sessionId)
    if (!row) return undefined
    const totalMessageCount = await this.getMessageCount(sessionId)

    let messages: ChatMessage[]
    if (limit !== undefined && beforeCreatedAt) {
      // "Load more" — get messages older than the given timestamp (cursor-based)
      messages = await this.getOlderMessages(sessionId, limit, beforeCreatedAt)
    } else if (limit !== undefined) {
      // Initial load — get the latest N messages using DESC order
      messages = await this.getLatestMessages(sessionId, limit)
    } else {
      // Full history (for title generation etc.)
      messages = await this.getAllMessages(sessionId)
    }
    return toSession(row, messages, totalMessageCount)
  }

  async getMessageCount(sessionId: string): Promise<number> {
    return this.dao.countMessages(sessionId)
  }

  async getAllMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = await this.dao.findMessagesBySession(sessionId)
    return rows.map(toMessage)
  }

  async getLatestMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    // DESC order gets the newest messages first, then reverse for display
    const rows = await this.dao.findLatestMessages(sessionId, limit)
    return rows.reverse().map(toMessage)
  }

  async getOlderMessages(sessionId: string, limit: number, beforeCreatedAt: string): Promise<ChatMessage[]> {
    // Get messages older than the cursor timestamp
    const rows = await this.dao.findOlderMessages(sessionId, limit, beforeCreatedAt)
    return rows.reverse().map(toMessage)
  }

  async addMessage(sessionId: string, input: { role: string; type?: string; content: string; metadata?: string | null }): Promise<ChatMessage> {
    const id = randomUUID()
    const now = new Date().toISOString()
    await this.dao.insertMessage({
      id, session_id: sessionId,
      role: input.role,
      type: input.type ?? "text",
      content: input.content,
      metadata: input.metadata ?? null,
      created_at: now,
    })
    await this.dao.updateSession(sessionId, { updated_at: now })

    const msg = (await this.dao.findMessageById(id))!

    // SSE emit moved to chat route — streamSSE handles real-time events directly
    return toMessage(msg)
  }

  async updateMessageMetadata(messageId: string, metadata: string): Promise<void> {
    await this.dao.updateMessageMetadata(messageId, metadata)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.dao.deleteMessagesBySession(sessionId)
    await this.dao.deleteSession(sessionId)
  }

}
