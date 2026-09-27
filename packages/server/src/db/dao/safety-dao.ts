import { BasePgDAO, type PgSql } from "./base-pg"
import type { SafetyEventRow, ReportRow, ScheduledJobExecutionRow } from "../types"

/**
 * SafetyDAO — safety events, reports, and scheduled job executions.
 * Covers: safety_events, reports, reports (BM25 via pg_search),
 * scheduled_job_executions tables.
 *
 * P1 B2：better-sqlite3 → postgres.js。行形态契约：
 *   - safety_events.id PG 为 bigint（IDENTITY）—— postgres.js 把 bigint 回传成
 *     字符串，读出 ::int 归一（事件量远小于 int4 上限）；行契约 number 不变。
 *   - timestamp/started_at/finished_at/created_at 等 timestamptz 列读侧 to_char
 *     归 `…Z` ISO 文本（S4「B 期保留 text」裁决）；duration_ms bigint → ::int。
 *   - **reports_fts（FTS5 虚表）→ pg_search BM25**：SQLite 侧 reports_fts 是
 *     「外部内容虚表」，仓内零写路径（从未被填充，searchReports 实际恒空）。
 *     PG 侧不再造影子表 —— BM25 索引直接建在 reports 真表（db/pg/schema.sql
 *     idx_reports_bm25），searchReports 逐列 ||| 匹配 task_name，失败退回
 *     ILIKE（与旧 try/catch 两段式同构）。返回体把虚造的 content 换成
 *     file_path（真表有的列）。生产侧零调用方（实测 grep），返回形态可重定。
 */
const TS = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const SAFETY_EVENT_COLS = `id::int AS id, type, operation, decision, actor, context, org,
  ${TS("timestamp")} AS timestamp`

const REPORT_COLS = `id, task_name, date, file_path, status, org,
  ${TS("created_at")} AS created_at`

const SJE_COLS = `id, job_name, status,
  ${TS("started_at")} AS started_at, ${TS("finished_at")} AS finished_at,
  duration_ms::int AS duration_ms, report_path, report_summary, error_message,
  trigger_type, org, metadata`

export class SafetyDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── safety_events ───────────────────────────────────────────────

  findSafetyEvents(org: string, filters?: {
    type?: string; actor?: string; limit?: number
  }): Promise<SafetyEventRow[]> {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT ${SAFETY_EVENT_COLS} FROM safety_events WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.type) { sql += ` AND type = ?`; params.push(filters.type) }
    if (filters?.actor) { sql += ` AND actor = ?`; params.push(filters.actor) }
    sql += ` ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)
    return this.q<SafetyEventRow>(sql, params)
  }

  async findSafetyEventById(id: number): Promise<SafetyEventRow | null> {
    return (await this.q1<SafetyEventRow>(`SELECT ${SAFETY_EVENT_COLS} FROM safety_events WHERE id = ?`, [id])) ?? null
  }

  insertSafetyEvent(row: Omit<SafetyEventRow, "id">): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO safety_events (type, operation, decision, actor, context, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [row.type, row.operation, row.decision, row.actor, row.context ?? null, row.org, row.timestamp])
  }

  updateDecision(id: number, decision: string): Promise<{ changes: number }> {
    return this.exec("UPDATE safety_events SET decision = ? WHERE id = ?", [decision, id])
  }

  // ── reports ─────────────────────────────────────────────────────

  async findReportById(id: string): Promise<ReportRow | null> {
    return (await this.q1<ReportRow>(`SELECT ${REPORT_COLS} FROM reports WHERE id = ?`, [id])) ?? null
  }

  listReportsByOrg(org: string, filters?: {
    task_name?: string; date?: string
  }): Promise<ReportRow[]> {
    let sql = `SELECT ${REPORT_COLS} FROM reports WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.task_name) { sql += ` AND task_name = ?`; params.push(filters.task_name) }
    if (filters?.date) { sql += ` AND date = ?`; params.push(filters.date) }
    sql += ` ORDER BY date DESC`
    return this.q<ReportRow>(sql, params)
  }

  insertReport(row: ReportRow): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO reports (id, task_name, date, file_path, status, org, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [row.id, row.task_name, row.date, row.file_path, row.status, row.org, row.created_at])
  }

  updateReport(id: string, fields: Partial<ReportRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return Promise.resolve({ changes: 0 })
    vals.push(id)
    return this.exec(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  /**
   * BM25 全文检索（pg_search）—— P1 B2 全计划首战（p1-batch-plan §3 S8 缩微版）。
   * 索引：schema.sql `idx_reports_bm25`（key_field=id）。pg_search 的 `|||` 是
   * 「列字段 ||| 查询串」形态，跨列检索须显式 OR（key 列 ||| 只查 key 本身，实测）。
   * 查询串经 tantivy 解析器 —— 特殊语法（`a:b`、括号等）可能抛 parse 错误，
   * try/catch 退回 ILIKE（与 SQLite FTS5 时代的两段式同构）。
   */
  async searchReports(query: string, limit: number = 10): Promise<Array<{ task_name: string; file_path: string }>> {
    try {
      return await this.q<{ task_name: string; file_path: string }>(`
        SELECT task_name, file_path FROM reports
        WHERE task_name ||| ?
        ORDER BY paradedb.score(id) DESC
        LIMIT ?
      `, [query, limit])
    } catch {
      return this.q<{ task_name: string; file_path: string }>(`
        SELECT task_name, file_path FROM reports
        WHERE task_name ILIKE ? LIMIT ?
      `, [`%${query}%`, limit])
    }
  }

  // ── scheduled_job_executions ────────────────────────────────────

  async findJobExecutionById(id: string): Promise<ScheduledJobExecutionRow | null> {
    return (await this.q1<ScheduledJobExecutionRow>(`SELECT ${SJE_COLS} FROM scheduled_job_executions WHERE id = ?`, [id])) ?? null
  }

  listJobExecutionsByOrg(org: string, filters?: {
    job_name?: string; status?: string; limit?: number
  }): Promise<ScheduledJobExecutionRow[]> {
    let sql = `SELECT ${SJE_COLS} FROM scheduled_job_executions WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.job_name) { sql += ` AND job_name = ?`; params.push(filters.job_name) }
    if (filters?.status) { sql += ` AND status = ?`; params.push(filters.status) }
    sql += ` ORDER BY started_at DESC`
    const limit = filters?.limit ?? 50
    params.push(limit)
    return this.q<ScheduledJobExecutionRow>(sql, params)
  }

  async findRunningJobExecution(jobName: string, org: string): Promise<ScheduledJobExecutionRow | null> {
    return (await this.q1<ScheduledJobExecutionRow>(
      `SELECT ${SJE_COLS} FROM scheduled_job_executions WHERE job_name = ? AND org = ? AND status = 'running' LIMIT 1`,
      [jobName, org],
    )) ?? null
  }

  insertJobExecution(row: ScheduledJobExecutionRow): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO scheduled_job_executions (id, job_name, status, started_at, finished_at, duration_ms, report_path, report_summary, error_message, trigger_type, org, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.job_name, row.status, row.started_at, row.finished_at,
      row.duration_ms, row.report_path, row.report_summary, row.error_message,
      row.trigger_type, row.org, row.metadata,
    ])
  }

  updateJobExecution(id: string, fields: Partial<ScheduledJobExecutionRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return Promise.resolve({ changes: 0 })
    vals.push(id)
    return this.exec(`UPDATE scheduled_job_executions SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  // ── Additional methods for agent-service migration ────────────────

  updateSafetyEventDecision(eventId: number, decision: string): Promise<{ changes: number }> {
    return this.exec("UPDATE safety_events SET decision = ? WHERE id = ?", [decision, eventId])
  }

  findSafetyEventsWithFilters(org: string, filters?: {
    type?: string; actor?: string; limit?: number
  }): Promise<SafetyEventRow[]> {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT ${SAFETY_EVENT_COLS} FROM safety_events WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type) }
    if (filters?.actor) { sql += " AND actor = ?"; params.push(filters.actor) }
    sql += " ORDER BY timestamp DESC LIMIT ?"
    params.push(limit)
    return this.q<SafetyEventRow>(sql, params)
  }

  // ── Additional methods for agent route migrations ─────────────────

  insertSafetyEventFull(row: {
    type: string; actor: string; operation: string; decision: string; org: string; timestamp: string
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO safety_events (type, actor, operation, decision, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [row.type, row.actor, row.operation, row.decision, row.org, row.timestamp])
  }

  async findSafetyEventByIdAndOrg(id: number, org: string): Promise<{ id: number; type: string; decision: string; org: string } | null> {
    return (await this.q1<{ id: number; type: string; decision: string; org: string }>(
      "SELECT id::int AS id, type, decision, org FROM safety_events WHERE id = ? AND org = ?",
      [id, org],
    )) ?? null
  }
}
