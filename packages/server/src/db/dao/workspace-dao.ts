import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { WorkspaceRow, OptimizationSuggestionRow, PaginatedResult } from "../types"

export class WorkspaceDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── workspaces ──────────────────────────────────────────────────

  findById(id: string): WorkspaceRow | null {
    return (this.stmt("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow) ?? null
  }

  findAll(org?: string, source?: string, excludeArchived = false): WorkspaceRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (org) { conditions.push("org = ?"); params.push(org) }
    if (source && source !== "all") {
      conditions.push("(source = ? OR source IS NULL)")
      params.push(source)
    }
    if (excludeArchived) { conditions.push("status != 'archived'") }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    return this.stmt(`SELECT * FROM workspaces ${where} ORDER BY updated_at DESC`).all(...params) as WorkspaceRow[]
  }

  insert(row: Omit<WorkspaceRow, "source" | "source_schedule_id"> & { source?: string; source_schedule_id?: string | null }): Database.RunResult {
    return this.stmt(
      `INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).run(row.id, row.name, row.org, row.description, row.path, row.source ?? "user", row.source_schedule_id ?? null, row.created_at, row.updated_at)
  }

  update(id: string, fields: Record<string, unknown>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return this.stmt(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  deleteById(id: string): Database.RunResult {
    return this.stmt("DELETE FROM workspaces WHERE id = ?").run(id)
  }

  // ── optimization_suggestions ────────────────────────────────────

  findSuggestions(workspaceId: string, status?: string): OptimizationSuggestionRow[] {
    let sql = "SELECT * FROM optimization_suggestions WHERE workspace_id = ?"
    const params: unknown[] = [workspaceId]
    if (status) { sql += " AND status = ?"; params.push(status) }
    sql += " ORDER BY created_at DESC"
    return this.stmt(sql).all(...params) as OptimizationSuggestionRow[]
  }

  findSuggestionById(id: string): OptimizationSuggestionRow | null {
    return (this.stmt("SELECT * FROM optimization_suggestions WHERE id = ?").get(id) as OptimizationSuggestionRow) ?? null
  }

  insertSuggestion(row: Omit<OptimizationSuggestionRow, "applied_at" | "applied_changes">): Database.RunResult {
    return this.stmt(
      `INSERT INTO optimization_suggestions (id, workspace_id, workflow_ref, rule_name, node_id, severity, title, detection, diagnosis, prescription, impact_estimate, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.workspace_id, row.workflow_ref, row.rule_name, row.node_id, row.severity, row.title, row.detection, row.diagnosis, row.prescription, row.impact_estimate, row.status, row.created_at)
  }

  applySuggestion(id: string, appliedChanges: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE optimization_suggestions SET status = 'applied', applied_at = ?, applied_changes = ? WHERE id = ?"
    ).run(now, appliedChanges, id)
  }

  deleteSuggestionsByWorkspace(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM optimization_suggestions WHERE workspace_id = ?").run(workspaceId)
  }

  // ── Cascade helpers (used by workspace delete) ─────────────────

  findExecutionIdsByWorkspace(workspaceId: string): { id: string }[] {
    return this.stmt("SELECT id FROM executions WHERE workspace_id = ?").all(workspaceId) as { id: string }[]
  }

  deleteChatDataByWorkspace(workspaceId: string): void {
    this.stmt("DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE workspace_id = ?)").run(workspaceId)
    this.stmt("DELETE FROM chat_sessions WHERE workspace_id = ?").run(workspaceId)
  }

  deletePipelineStateByWorkspace(workspaceId: string): void {
    this.stmt("DELETE FROM pipeline_state WHERE workspace_id = ?").run(workspaceId)
  }

  findSuggestionsSorted(workspaceId: string, status?: string): OptimizationSuggestionRow[] {
    let query = "SELECT * FROM optimization_suggestions WHERE workspace_id = ?"
    const params: unknown[] = [workspaceId]
    if (status) { query += " AND status = ?"; params.push(status) }
    query += " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC"
    return this.stmt(query).all(...params) as OptimizationSuggestionRow[]
  }

  findByPath(path: string): WorkspaceRow | null {
    return (this.stmt("SELECT * FROM workspaces WHERE path = ?").get(path) as WorkspaceRow) ?? null
  }

  findPathById(id: string): string | null {
    const row = this.stmt("SELECT path FROM workspaces WHERE id = ? AND status = 'active'").get(id) as { path: string } | undefined
    return row?.path ?? null
  }

  countAll(): number {
    const row = this.stmt("SELECT COUNT(*) as count FROM workspaces").get() as { count: number }
    return row.count
  }

  findActiveIds(): string[] {
    const rows = this.stmt("SELECT id FROM workspaces WHERE status = 'active'").all() as { id: string }[]
    return rows.map(r => r.id)
  }

  cascadeDeleteByWorkspace(workspaceId: string): void {
    this.transaction(() => {
      // Chat data
      this.deleteChatDataByWorkspace(workspaceId)

      // Optimization suggestions
      this.deleteSuggestionsByWorkspace(workspaceId)

      // Pipeline state
      this.deletePipelineStateByWorkspace(workspaceId)

      // Schedule-related cleanup (uses db directly since these are other DAOs' tables)
      this.stmt("DELETE FROM schedule_executions WHERE schedule_id IN (SELECT id FROM schedules WHERE workspace_id = ?)").run(workspaceId)
      this.stmt("DELETE FROM schedule_audit_logs WHERE workspace_id = ?").run(workspaceId)
      this.stmt("DELETE FROM schedules WHERE workspace_id = ?").run(workspaceId)

      // Execution cascade (agent_events, llm_calls, node_token_usages, etc.)
      const execIds = this.findExecutionIdsByWorkspace(workspaceId)
      if (execIds.length > 0) {
        const placeholders = execIds.map(() => "?").join(",")
        const vals = execIds.map(e => e.id)
        this.stmt(`DELETE FROM agent_events WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM llm_calls WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM branch_executions WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM node_edges WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM node_executions WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM execution_summaries WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM schedule_executions WHERE execution_id IN (${placeholders})`).run(...vals)
      }
      this.stmt("DELETE FROM executions WHERE workspace_id = ?").run(workspaceId)

      // Workspace itself
      this.deleteById(workspaceId)
    })
  }

  // ── archive_status ────────────────────────────────────────────────

  softArchive(id: string): void {
    this.stmt(`
      UPDATE workspaces
      SET status = 'archived', archive_status = 'archived', updated_at = datetime('now')
      WHERE id = ?
    `).run(id)
  }

  setArchiveStatus(workspaceId: string, status: string | null): void {
    this.stmt("UPDATE workspaces SET archive_status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), workspaceId)
  }

  listByArchiveStatus(status: string): WorkspaceRow[] {
    return this.stmt("SELECT * FROM workspaces WHERE archive_status = ? ORDER BY updated_at DESC")
      .all(status) as WorkspaceRow[]
  }
}
