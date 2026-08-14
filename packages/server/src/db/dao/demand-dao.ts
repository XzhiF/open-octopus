import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { DemandRow } from "../types"

/**
 * Priority ordering map — lower number = higher priority.
 * Single source of truth for priority ordering in both TS and SQL.
 */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

/**
 * Timestamp columns that are auto-set on status transitions.
 */
const STATUS_TIMESTAMP: Record<string, string> = {
  ready: "ready_at",
  dispatched: "dispatched_at",
  done: "completed_at",
  failed: "completed_at",
}

/**
 * Fields allowed in update() — prevents accidental overwrite of id, timestamps, etc.
 */
const ALLOWED_UPDATE_FIELDS = new Set([
  "title", "description", "priority", "project_ids",
  "demand_workflow_ref", "exec_workflow_chain",
  "workspace_id", "result", "error_message",
])

export class DemandDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  /**
   * Insert a new demand row.
   */
  insert(demand: DemandRow): void {
    this.stmt(
      `INSERT INTO demands (
        id, title, description, status, priority,
        project_ids, demand_workflow_ref, exec_workflow_chain,
        workspace_id, ready_at, dispatched_at, completed_at,
        result, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      demand.id,
      demand.title,
      demand.description ?? "",
      demand.status ?? "draft",
      demand.priority ?? "normal",
      demand.project_ids ?? "[]",
      demand.demand_workflow_ref ?? "",
      demand.exec_workflow_chain ?? "[]",
      demand.workspace_id ?? null,
      demand.ready_at ?? null,
      demand.dispatched_at ?? null,
      demand.completed_at ?? null,
      demand.result ?? null,
      demand.error_message ?? null,
      demand.created_at,
      demand.updated_at,
    )
  }

  /**
   * Find a demand by its primary key.
   */
  findById(id: string): DemandRow | null {
    return (this.stmt("SELECT * FROM demands WHERE id = ?").get(id) as DemandRow) ?? null
  }

  /**
   * List demands with optional filtering and pagination.
   */
  list(filter: {
    status?: string
    priority?: string
    page?: number
    pageSize?: number
  }): { data: DemandRow[]; total: number; page: number; pageSize: number } {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.status) {
      conditions.push("status = ?")
      params.push(filter.status)
    }
    if (filter.priority) {
      conditions.push("priority = ?")
      params.push(filter.priority)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    return this.paginate<DemandRow>(
      `SELECT * FROM demands ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      `SELECT COUNT(*) as cnt FROM demands ${where}`,
      params,
      filter.page ?? 1,
      filter.pageSize ?? 20,
    )
  }

  /**
   * Update the status of a demand.
   * Automatically sets lifecycle timestamps (ready_at, dispatched_at, completed_at)
   * based on the target status.
   */
  updateStatus(id: string, newStatus: string): void {
    const now = new Date().toISOString()
    const tsColumn = STATUS_TIMESTAMP[newStatus]

    if (tsColumn) {
      this.stmt(
        `UPDATE demands SET status = ?, ${tsColumn} = ?, updated_at = ? WHERE id = ?`
      ).run(newStatus, now, now, id)
    } else {
      this.stmt(
        `UPDATE demands SET status = ?, updated_at = ? WHERE id = ?`
      ).run(newStatus, now, id)
    }
  }

  /**
   * Update mutable fields of a demand.
   * Only fields in ALLOWED_UPDATE_FIELDS are applied.
   */
  update(id: string, fields: Partial<DemandRow>): void {
    const sets: string[] = []
    const params: unknown[] = []

    for (const [key, value] of Object.entries(fields)) {
      if (ALLOWED_UPDATE_FIELDS.has(key)) {
        sets.push(`${key} = ?`)
        params.push(value ?? null)
      }
    }

    if (sets.length === 0) return

    sets.push("updated_at = ?")
    params.push(new Date().toISOString())
    params.push(id)

    this.stmt(
      `UPDATE demands SET ${sets.join(", ")} WHERE id = ?`
    ).run(...params)
  }

  /**
   * Delete a demand by id.
   */
  delete(id: string): void {
    this.stmt("DELETE FROM demands WHERE id = ?").run(id)
  }

  /**
   * List demands in 'ready' status, ordered by priority (critical first) then created_at.
   * Used by the TaskPoolDispatcher to pick demands for execution.
   */
  listReady(limit = 100): DemandRow[] {
    const caseExpr = Object.entries(PRIORITY_ORDER)
      .map(([p, n]) => `WHEN '${p}' THEN ${n}`)
      .join("\n           ")
    return this.stmt(
      `SELECT * FROM demands WHERE status = 'ready'
       ORDER BY
         CASE priority
           ${caseExpr}
           ELSE 99
         END ASC,
         created_at ASC
       LIMIT ?`
    ).all(limit) as DemandRow[]
  }

  /**
   * Count demands grouped by status.
   */
  countByStatus(): Record<string, number> {
    const rows = this.stmt(
      "SELECT status, COUNT(*) as cnt FROM demands GROUP BY status"
    ).all() as Array<{ status: string; cnt: number }>

    const counts: Record<string, number> = {}
    for (const row of rows) {
      counts[row.status] = row.cnt
    }
    return counts
  }

  /**
   * Set or clear the error_message on a demand.
   */
  setError(id: string, message: string | null): void {
    this.stmt(
      "UPDATE demands SET error_message = ?, updated_at = ? WHERE id = ?"
    ).run(message, new Date().toISOString(), id)
  }
}
