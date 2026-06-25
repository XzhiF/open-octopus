import Database from "better-sqlite3"
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

  updateProviderSession(sessionId: string, providerSessionId: string): void {
    this.dao.updateProviderSession(sessionId, providerSessionId)
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.dao.updateSession(sessionId, { title })
  }

  createSession(workspaceId: string, title?: string): ChatSession {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.dao.insertSession({
      id, workspace_id: workspaceId,
      title: title ?? null,
      created_at: now, updated_at: now,
    })
    return this.getSession(id)!
  }

  listSessions(workspaceId: string): ChatSession[] {
    const rows = this.dao.listSessions(workspaceId)
    return rows.map(r => toSession(r))
  }

  getSession(sessionId: string, limit?: number, beforeCreatedAt?: string): ChatSession | undefined {
    const row = this.dao.findSessionById(sessionId)
    if (!row) return undefined
    const totalMessageCount = this.getMessageCount(sessionId)

    let messages: ChatMessage[]
    if (limit !== undefined && beforeCreatedAt) {
      // "Load more" — get messages older than the given timestamp (cursor-based)
      messages = this.getOlderMessages(sessionId, limit, beforeCreatedAt)
    } else if (limit !== undefined) {
      // Initial load — get the latest N messages using DESC order
      messages = this.getLatestMessages(sessionId, limit)
    } else {
      // Full history (for title generation etc.)
      messages = this.getAllMessages(sessionId)
    }
    return toSession(row, messages, totalMessageCount)
  }

  getMessageCount(sessionId: string): number {
    return this.dao.countMessages(sessionId)
  }

  getAllMessages(sessionId: string): ChatMessage[] {
    const rows = this.dao.findMessagesBySession(sessionId)
    return rows.map(toMessage)
  }

  getLatestMessages(sessionId: string, limit: number): ChatMessage[] {
    // DESC order gets the newest messages first, then reverse for display
    const rows = this.dao.findLatestMessages(sessionId, limit)
    return rows.reverse().map(toMessage)
  }

  getOlderMessages(sessionId: string, limit: number, beforeCreatedAt: string): ChatMessage[] {
    // Get messages older than the cursor timestamp
    const rows = this.dao.findOlderMessages(sessionId, limit, beforeCreatedAt)
    return rows.reverse().map(toMessage)
  }

addMessage(sessionId: string, input: { role: string; type?: string; content: string; metadata?: string | null }): ChatMessage {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.dao.insertMessage({
      id, session_id: sessionId,
      role: input.role,
      type: input.type ?? "text",
      content: input.content,
      metadata: input.metadata ?? null,
      created_at: now,
    })
    this.dao.updateSession(sessionId, { updated_at: now })

    const msg = this.dao.findMessageById(id)!

    // SSE emit moved to chat route — streamSSE handles real-time events directly
return toMessage(msg)
  }

  updateMessageMetadata(messageId: string, metadata: string): void {
    this.dao.updateMessageMetadata(messageId, metadata)
  }

  deleteSession(sessionId: string): void {
    this.dao.deleteMessagesBySession(sessionId)
    this.dao.deleteSession(sessionId)
  }
}
