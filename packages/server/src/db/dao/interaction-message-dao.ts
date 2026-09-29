// packages/server/src/db/dao/interaction-message-dao.ts
//
// InteractionMessageDAO — CRUD operations for interaction_messages table.
// Stores conversation messages for workflow interaction nodes,
// keyed by execution_id + node_id (not chat sessions).

import { BasePgDAO, type PgSql } from "./base-pg"
import type { InteractionMessageRow } from "../types"

/**
 * InteractionMessageDAO — interaction node conversation messages.
 * Covers: interaction_messages table.
 *
 * P1 B2：better-sqlite3 → postgres.js。行形态契约：
 *   - metadata 列 PG 为 jsonb（B0 平移裁定，live 库 66/66 json_valid）——
 *     读出经 #>> '{}' 归 text（jsonb 直读在 string/object 间漂移，见 task-dao 头注），
 *     行契约 string|null 不变；写入仍收 JSON 串。
 *     ⚠ 非 JSON 文本（旧 SQLite 宽容期写进的裸串）会被 jsonb 拒收 ——
 *     调用面（InteractionService）全部 JSON.stringify 后写入，实测无裸串。
 *   - created_at timestamptz：读侧 to_char 归 ISO 文本；游标比较
 *     `created_at < ?` 由 PG 按 timestamptz 解析 ISO 串参数，语义与文本序一致
 *     （同 UTC 同时区，单调）。
 *   - FK：execution_id → executions.id 两引擎同 DDL。混合期 executions 仍在
 *     SQLite —— PG 侧消息行要求 PG executions 有父行（p1-batch-plan 未覆盖的
 *     跨引擎 FK 缺口，已记入 B2 报告 §4）。
 */
const TS = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const MSG_COLS = `id, execution_id, node_id, role, type, content, metadata #>> '{}' AS metadata,
  ${TS("created_at")} AS created_at`

export class InteractionMessageDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  /**
   * Insert a new interaction message.
   */
  insertMessage(row: InteractionMessageRow): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO interaction_messages (id, execution_id, node_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.execution_id, row.node_id, row.role,
      row.type, row.content, row.metadata, row.created_at,
    ])
  }

  /**
   * Find messages for an interaction, ordered by created_at ASC.
   * Supports pagination via limit and before (cursor-based).
   */
  async findMessages(
    executionId: string,
    nodeId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<InteractionMessageRow[]> {
    if (opts?.before) {
      const limit = opts.limit ?? 100
      const rows = await this.q<InteractionMessageRow>(
        `SELECT ${MSG_COLS} FROM interaction_messages WHERE execution_id = ? AND node_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
        [executionId, nodeId, opts.before, limit],
      )
      return rows.reverse()
    }
    const limit = opts?.limit ?? 100
    return this.q<InteractionMessageRow>(
      `SELECT ${MSG_COLS} FROM interaction_messages WHERE execution_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT ?`,
      [executionId, nodeId, limit],
    )
  }

  /**
   * Find a single message by ID.
   */
  async findMessageById(id: string): Promise<InteractionMessageRow | null> {
    return (await this.q1<InteractionMessageRow>(`SELECT ${MSG_COLS} FROM interaction_messages WHERE id = ?`, [id])) ?? null
  }

  /**
   * Count messages for an interaction.
   */
  async countMessages(executionId: string, nodeId: string): Promise<number> {
    // COUNT 在 PG 是 bigint → postgres.js 回字符串，Number() 归一（S11）。
    const row = await this.q1<{ count: number | string }>(
      "SELECT COUNT(*) as count FROM interaction_messages WHERE execution_id = ? AND node_id = ?",
      [executionId, nodeId],
    )
    return Number(row!.count)
  }

  /**
   * Update message content and metadata together.
   */
  updateMessageContentAndMetadata(id: string, content: string, metadata: string): Promise<{ changes: number }> {
    return this.exec("UPDATE interaction_messages SET content = ?, metadata = ? WHERE id = ?", [content, metadata, id])
  }

  /**
   * Update message metadata (JSON string).
   */
  updateMessageMetadata(id: string, metadata: string): Promise<{ changes: number }> {
    return this.exec("UPDATE interaction_messages SET metadata = ? WHERE id = ?", [metadata, id])
  }

  /**
   * Delete all messages for an execution.
   */
  deleteMessagesByExecution(executionId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM interaction_messages WHERE execution_id = ?", [executionId])
  }
}
