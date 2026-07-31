// packages/server/src/db/dao/interaction-message-dao.ts
//
// InteractionMessageDAO — CRUD operations for interaction_messages table.
// Stores conversation messages for workflow interaction nodes,
// keyed by execution_id + node_id (not chat sessions).

import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { InteractionMessageRow } from "../types"

/**
 * InteractionMessageDAO — interaction node conversation messages.
 * Covers: interaction_messages table.
 */
export class InteractionMessageDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  /**
   * Insert a new interaction message.
   */
  insertMessage(row: InteractionMessageRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.execution_id, row.node_id, row.role,
      row.type, row.content, row.metadata, row.created_at,
    )
  }

  /**
   * Find messages for an interaction, ordered by created_at ASC.
   * Supports pagination via limit and before (cursor-based).
   */
  findMessages(
    executionId: string,
    nodeId: string,
    opts?: { limit?: number; before?: string },
  ): InteractionMessageRow[] {
    if (opts?.before) {
      const limit = opts.limit ?? 100
      return this.stmt(
        "SELECT * FROM interaction_messages WHERE execution_id = ? AND node_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
      ).all(executionId, nodeId, opts.before, limit).reverse() as InteractionMessageRow[]
    }
    const limit = opts?.limit ?? 100
    return this.stmt(
      "SELECT * FROM interaction_messages WHERE execution_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT ?"
    ).all(executionId, nodeId, limit) as InteractionMessageRow[]
  }

  /**
   * Find a single message by ID.
   */
  findMessageById(id: string): InteractionMessageRow | null {
    return (this.stmt("SELECT * FROM interaction_messages WHERE id = ?").get(id) as InteractionMessageRow) ?? null
  }

  /**
   * Count messages for an interaction.
   */
  countMessages(executionId: string, nodeId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM interaction_messages WHERE execution_id = ? AND node_id = ?"
    ).get(executionId, nodeId) as { count: number }).count
  }

  /**
   * Update message metadata (JSON string).
   */
  updateMessageMetadata(id: string, metadata: string): Database.RunResult {
    return this.stmt("UPDATE interaction_messages SET metadata = ? WHERE id = ?").run(metadata, id)
  }

  /**
   * Delete all messages for an execution.
   */
  deleteMessagesByExecution(executionId: string): Database.RunResult {
    return this.stmt("DELETE FROM interaction_messages WHERE execution_id = ?").run(executionId)
  }
}
