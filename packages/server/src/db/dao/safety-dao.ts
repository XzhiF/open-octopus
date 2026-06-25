import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { SafetyEventRow, ReportRow, ScheduledJobExecutionRow, PaginatedResult } from "../types"

/**
 * SafetyDAO — safety events, reports, and scheduled job executions.
 * Covers: safety_events, reports, reports_fts, scheduled_job_executions tables.
 */
export class SafetyDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── safety_events ───────────────────────────────────────────────

  findSafetyEvents(org: string, filters?: {
    type?: string; actor?: string; limit?: number
  }): SafetyEventRow[] {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT * FROM safety_events WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.type) { sql += ` AND type = ?`; params.push(filters.type) }
    if (filters?.actor) { sql += ` AND actor = ?`; params.push(filters.actor) }
    sql += ` ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as SafetyEventRow[]
  }

  findSafetyEventById(id: number): SafetyEventRow | null {
    return (this.stmt("SELECT * FROM safety_events WHERE id = ?").get(id) as SafetyEventRow) ?? null
  }

  insertSafetyEvent(row: Omit<SafetyEventRow, "id">): Database.RunResult {
    return this.stmt(`
      INSERT INTO safety_events (type, operation, decision, actor, context, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.type, row.operation, row.decision, row.actor, row.context ?? null, row.org, row.timestamp)
  }

  updateDecision(id: number, decision: string): Database.RunResult {
    return this.stmt("UPDATE safety_events SET decision = ? WHERE id = ?").run(decision, id)
  }

  // ── reports ─────────────────────────────────────────────────────

  findReportById(id: string): ReportRow | null {
    return (this.stmt("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow) ?? null
  }

  listReportsByOrg(org: string, filters?: {
    task_name?: string; date?: string
  }): ReportRow[] {
    let sql = `SELECT * FROM reports WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.task_name) { sql += ` AND task_name = ?`; params.push(filters.task_name) }
    if (filters?.date) { sql += ` AND date = ?`; params.push(filters.date) }
    sql += ` ORDER BY date DESC`
    return this.stmt(sql).all(...params) as ReportRow[]
  }

  insertReport(row: ReportRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO reports (id, task_name, date, file_path, status, org, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.task_name, row.date, row.file_path, row.status, row.org, row.created_at)
  }

  updateReport(id: string, fields: Partial<ReportRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  searchReports(query: string, limit: number = 10): Array<{ task_name: string; content: string }> {
    try {
      return this.stmt(`
        SELECT task_name, content FROM reports_fts
        WHERE reports_fts MATCH ? LIMIT ?
      `).all(query, limit) as Array<{ task_name: string; content: string }>
    } catch {
      return this.stmt(`
        SELECT task_name, content FROM reports_fts
        WHERE content LIKE ? LIMIT ?
      `).all(`%${query}%`, limit) as Array<{ task_name: string; content: string }>
    }
  }

  // ── scheduled_job_executions ────────────────────────────────────

  findJobExecutionById(id: string): ScheduledJobExecutionRow | null {
    return (this.stmt("SELECT * FROM scheduled_job_executions WHERE id = ?").get(id) as ScheduledJobExecutionRow) ?? null
  }

  listJobExecutionsByOrg(org: string, filters?: {
    job_name?: string; status?: string; limit?: number
  }): ScheduledJobExecutionRow[] {
    let sql = `SELECT * FROM scheduled_job_executions WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.job_name) { sql += ` AND job_name = ?`; params.push(filters.job_name) }
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status) }
    sql += ` ORDER BY started_at DESC`
    const limit = filters?.limit ?? 50
    params.push(limit)
    return this.stmt(sql).all(...params) as ScheduledJobExecutionRow[]
  }

  findRunningJobExecution(jobName: string, org: string): ScheduledJobExecutionRow | null {
    return (this.stmt(
      "SELECT * FROM scheduled_job_executions WHERE job_name = ? AND org = ? AND status = 'running' LIMIT 1"
    ).get(jobName, org) as ScheduledJobExecutionRow) ?? null
  }

  insertJobExecution(row: ScheduledJobExecutionRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO scheduled_job_executions (id, job_name, status, started_at, finished_at, duration_ms, report_path, report_summary, error_message, trigger_type, org, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.job_name, row.status, row.started_at, row.finished_at,
      row.duration_ms, row.report_path, row.report_summary, row.error_message,
      row.trigger_type, row.org, row.metadata,
    )
  }

  updateJobExecution(id: string, fields: Partial<ScheduledJobExecutionRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE scheduled_job_executions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  // ── Additional methods for agent-service migration ────────────────

  updateSafetyEventDecision(eventId: number, decision: string): Database.RunResult {
    return this.stmt("UPDATE safety_events SET decision = ? WHERE id = ?").run(decision, eventId)
  }

  findSafetyEventsWithFilters(org: string, filters?: {
    type?: string; actor?: string; limit?: number
  }): SafetyEventRow[] {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = "SELECT * FROM safety_events WHERE org = ?"
    const params: unknown[] = [org]
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type) }
    if (filters?.actor) { sql += " AND actor = ?"; params.push(filters.actor) }
    sql += " ORDER BY timestamp DESC LIMIT ?"
    params.push(limit)
    return this.stmt(sql).all(...params) as SafetyEventRow[]
  }

  // ── Additional methods for agent route migrations ─────────────────

  insertSafetyEventFull(row: {
    type: string; actor: string; operation: string; decision: string; org: string; timestamp: string
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO safety_events (type, actor, operation, decision, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.type, row.actor, row.operation, row.decision, row.org, row.timestamp)
  }

  findSafetyEventByIdAndOrg(id: number, org: string): { id: number; type: string; decision: string; org: string } | null {
    return (this.stmt(
      "SELECT id, type, decision, org FROM safety_events WHERE id = ? AND org = ?"
    ).get(id, org) as { id: number; type: string; decision: string; org: string }) ?? null
  }
}
