import { BasePgDAO, type PgSql } from "./base-pg"
import { iso, isoOrNull, num } from "./pg-mappers"
import type { WorkspaceRow, OptimizationSuggestionRow } from "../types"

/**
 * WorkspaceDAO — P1 B5 票6a：BaseDAO → BasePgDAO（事务簇终批收尾）。
 * 覆盖 workspaces / optimization_suggestions + workspace 级联删除面。
 * 出口经 pg-mappers 归一回旧 SQLite 行契约（timestamptz→ISO、COUNT→number）；
 * `datetime('now')` → `now()`；cascadeDeleteByWorkspace 的事务体全部经
 * tx 构造的实例执行（红线：体内禁 this.*，写入不得逃逸出事务）。
 */

/** workspaces 的 PG 原始行（created_at/updated_at 是 timestamptz → Date）。 */
interface WsPg extends Omit<WorkspaceRow, "created_at" | "updated_at"> {
  created_at: Date | string
  updated_at: Date | string
}

function fromWs(r: WsPg): WorkspaceRow {
  return { ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }
}

interface SuggPg extends Omit<OptimizationSuggestionRow, "applied_at" | "created_at"> {
  applied_at: Date | string | null
  created_at: Date | string
}

function fromSugg(r: SuggPg): OptimizationSuggestionRow {
  return { ...r, applied_at: isoOrNull(r.applied_at), created_at: iso(r.created_at) }
}

export class WorkspaceDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── workspaces ──────────────────────────────────────────────────

  async findById(id: string): Promise<WorkspaceRow | null> {
    const row = await this.q1<WsPg>("SELECT * FROM workspaces WHERE id = ?", [id])
    return row ? fromWs(row) : null
  }

  async findAll(org?: string, source?: string, excludeArchived = false): Promise<WorkspaceRow[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (org) { conditions.push("org = ?"); params.push(org) }
    if (source && source !== "all") {
      conditions.push("(source = ? OR source IS NULL)")
      params.push(source)
    }
    if (excludeArchived) { conditions.push("status != 'archived'") }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const rows = await this.q<WsPg>(`SELECT * FROM workspaces ${where} ORDER BY updated_at DESC`, params)
    return rows.map(fromWs)
  }

  async insert(
    row: Omit<WorkspaceRow, "source" | "source_schedule_id" | "task_id"> & {
      source?: string
      source_schedule_id?: string | null
      /** ADR-0021 票03: which task this workspace serves. Replaces walking
       *  source_schedule_id → schedules.origin_id to discover task ownership. */
      task_id?: string | null
    },
  ): Promise<{ changes: number }> {
    return await this.exec(
      `INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [row.id, row.name, row.org, row.description, row.path, row.source ?? "user", row.source_schedule_id ?? null, row.task_id ?? null, row.created_at, row.updated_at],
    )
  }

  /** The workspace bound to a task (newest first — a task binds one, but a hand-deleted
   *  row plus a rebuild leaves the old one behind as history). */
  async findByTaskId(taskId: string): Promise<WorkspaceRow | null> {
    const row = await this.q1<WsPg>(
      "SELECT * FROM workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      [taskId],
    )
    return row ? fromWs(row) : null
  }

  async update(id: string, fields: Record<string, unknown>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return await this.exec(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async deleteById(id: string): Promise<{ changes: number }> {
    return await this.exec("DELETE FROM workspaces WHERE id = ?", [id])
  }

  // ── optimization_suggestions ────────────────────────────────────

  async findSuggestions(workspaceId: string, status?: string): Promise<OptimizationSuggestionRow[]> {
    let sql = "SELECT * FROM optimization_suggestions WHERE workspace_id = ?"
    const params: unknown[] = [workspaceId]
    if (status) { sql += " AND status = ?"; params.push(status) }
    sql += " ORDER BY created_at DESC"
    const rows = await this.q<SuggPg>(sql, params)
    return rows.map(fromSugg)
  }

  async findSuggestionById(id: string): Promise<OptimizationSuggestionRow | null> {
    const row = await this.q1<SuggPg>("SELECT * FROM optimization_suggestions WHERE id = ?", [id])
    return row ? fromSugg(row) : null
  }

  async insertSuggestion(row: Omit<OptimizationSuggestionRow, "applied_at" | "applied_changes">): Promise<{ changes: number }> {
    return await this.exec(
      `INSERT INTO optimization_suggestions (id, workspace_id, workflow_ref, rule_name, node_id, severity, title, detection, diagnosis, prescription, impact_estimate, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.workspace_id, row.workflow_ref, row.rule_name, row.node_id, row.severity, row.title, row.detection, row.diagnosis, row.prescription, row.impact_estimate, row.status, row.created_at],
    )
  }

  async applySuggestion(id: string, appliedChanges: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return await this.exec(
      "UPDATE optimization_suggestions SET status = 'applied', applied_at = ?, applied_changes = ? WHERE id = ?",
      [now, appliedChanges, id],
    )
  }

  async deleteSuggestionsByWorkspace(workspaceId: string): Promise<{ changes: number }> {
    return await this.exec("DELETE FROM optimization_suggestions WHERE workspace_id = ?", [workspaceId])
  }

  // ── Cascade helpers (used by workspace delete) ─────────────────

  async findExecutionIdsByWorkspace(workspaceId: string): Promise<{ id: string }[]> {
    return await this.q<{ id: string }>("SELECT id FROM executions WHERE workspace_id = ?", [workspaceId])
  }

  async deleteChatDataByWorkspace(workspaceId: string): Promise<void> {
    await this.exec("DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE workspace_id = ?)", [workspaceId])
    await this.exec("DELETE FROM chat_sessions WHERE workspace_id = ?", [workspaceId])
  }

  async deletePipelineStateByWorkspace(workspaceId: string): Promise<void> {
    await this.exec("DELETE FROM pipeline_state WHERE workspace_id = ?", [workspaceId])
  }

  async findSuggestionsSorted(workspaceId: string, status?: string): Promise<OptimizationSuggestionRow[]> {
    let query = "SELECT * FROM optimization_suggestions WHERE workspace_id = ?"
    const params: unknown[] = [workspaceId]
    if (status) { query += " AND status = ?"; params.push(status) }
    query += " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC"
    const rows = await this.q<SuggPg>(query, params)
    return rows.map(fromSugg)
  }

  async findByPath(path: string): Promise<WorkspaceRow | null> {
    const row = await this.q1<WsPg>("SELECT * FROM workspaces WHERE path = ?", [path])
    return row ? fromWs(row) : null
  }

  async findPathById(id: string): Promise<string | null> {
    const row = await this.q1<{ path: string }>("SELECT path FROM workspaces WHERE id = ? AND status = 'active'", [id])
    return row?.path ?? null
  }

  async countAll(): Promise<number> {
    // 别名走小写单词（B4 闸：PG 裸 camel 别名会小写化）；COUNT 是 bigint → num() 归一。
    const row = await this.q1<{ count: string | number }>("SELECT COUNT(*) as count FROM workspaces")
    return num(row?.count)
  }

  async findActiveIds(): Promise<string[]> {
    const rows = await this.q<{ id: string }>("SELECT id FROM workspaces WHERE status = 'active'")
    return rows.map(r => r.id)
  }

  /**
   * 票6a · §6 事务清单：workspace 域唯一 DAO 内自事务（cascade 多表级联）。
   * 红线姿势：事务体内一律用 **tx 句柄构造的实例**，禁 this.*（this.db 是池根
   * 句柄，体内经它写入会逃逸出事务且照常提交 —— base-pg 对拍钉桩）。
   * 级联面（chat/suggestions/pipeline_state/schedules/executions 族）在票6a 后
   * 全部已迁 PG，同库同事务，原子性完整。
   */
  async cascadeDeleteByWorkspace(workspaceId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const dao = new WorkspaceDAO(tx)

      // Chat data
      await dao.deleteChatDataByWorkspace(workspaceId)

      // Optimization suggestions
      await dao.deleteSuggestionsByWorkspace(workspaceId)

      // Pipeline state
      await dao.deletePipelineStateByWorkspace(workspaceId)

      // Schedule-related cleanup (uses raw SQL since these are other DAOs' tables)
      await dao.exec("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id = ?)", [workspaceId])
      await dao.exec("DELETE FROM schedule_audit_logs WHERE workspace_id = ?", [workspaceId])
      await dao.exec("DELETE FROM schedules WHERE workspace_id = ?", [workspaceId])

      // Execution cascade (agent_events, llm_calls, node_token_usages, etc.)
      const execIds = await dao.findExecutionIdsByWorkspace(workspaceId)
      if (execIds.length > 0) {
        const placeholders = execIds.map(() => "?").join(",")
        const vals = execIds.map(e => e.id)
        await dao.exec(`DELETE FROM agent_events WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`, vals)
        await dao.exec(`DELETE FROM llm_calls WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`, vals)
        await dao.exec(`DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`, vals)
        await dao.exec(`DELETE FROM branch_executions WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`, vals)
        await dao.exec(`DELETE FROM node_edges WHERE execution_id IN (${placeholders})`, vals)
        await dao.exec(`DELETE FROM node_executions WHERE execution_id IN (${placeholders})`, vals)
        await dao.exec(`DELETE FROM execution_summaries WHERE execution_id IN (${placeholders})`, vals)
        await dao.exec(`DELETE FROM schedule_executions WHERE execution_id IN (${placeholders})`, vals)
      }
      await dao.exec("DELETE FROM executions WHERE workspace_id = ?", [workspaceId])

      // Workspace itself
      await dao.deleteById(workspaceId)
    })
  }

  // ── archive_status ────────────────────────────────────────────────

  async softArchive(id: string): Promise<void> {
    await this.exec(`
      UPDATE workspaces
      SET status = 'archived', archive_status = 'archived', updated_at = now()
      WHERE id = ?
    `, [id])
  }

  async setArchiveStatus(workspaceId: string, status: string | null): Promise<void> {
    await this.exec("UPDATE workspaces SET archive_status = ?, updated_at = ? WHERE id = ?",
      [status, new Date().toISOString(), workspaceId])
  }

  async listByArchiveStatus(status: string): Promise<WorkspaceRow[]> {
    const rows = await this.q<WsPg>("SELECT * FROM workspaces WHERE archive_status = ? ORDER BY updated_at DESC", [status])
    return rows.map(fromWs)
  }
}
