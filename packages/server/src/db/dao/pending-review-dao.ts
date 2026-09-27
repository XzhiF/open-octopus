import { BasePgDAO, type PgSql } from "./base-pg"
import type { PaginatedResult } from "../types"

export interface PendingReviewRow {
  id: string
  type: string
  source: string
  source_ref: string
  source_label: string
  content: string
  target_file: string
  scope: string
  conflicts: string | null  // JSON string
  confidence: number
  auto_approve: number
  status: string
  created_at: string
  reviewed_at: string | null
  user_notes: string | null
}

/**
 * P1 B2：better-sqlite3 → postgres.js。
 *   - datetime('now') → now()（S4 裁决：读侧 to_char 归 ISO 文本，写侧收 ISO/now()）。
 *   - auto_approve 列 PG boolean：读 ::int 归一，行契约 number 不变。
 *     ⚠ 写入必须转真 boolean —— postgres.js 把 JS number 0/1 绑进 bool 列会
 *     **静默存 false**（B2 实测，见 task-dao 头注同型地雷），toBool 兜住。
 *   - conflicts 列 PG jsonb：经 #>> '{}' 归 text（同 task_spec 契约，见 task-dao 头注）。
 */
/** 旧 0/1（或 boolean）→ PG boolean 列参数（0/1 直绑会静默存 false，见 task-dao 头注）。 */
const toBool = (v: unknown): boolean =>
  typeof v === "boolean" ? v : Number(v ?? 0) !== 0

const TS = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const PR_COLS = `id, type, source, source_ref, source_label, content, target_file, scope,
  conflicts #>> '{}' AS conflicts, confidence, auto_approve::int AS auto_approve, status,
  ${TS("created_at")} AS created_at, ${TS("reviewed_at")} AS reviewed_at, user_notes`

export class PendingReviewDAO extends BasePgDAO {
  constructor(db: PgSql) {
    super(db)
  }

  insert(item: Omit<PendingReviewRow, 'created_at' | 'reviewed_at'>): Promise<{ changes: number }> {
    return this.exec(
      `INSERT INTO pending_review (id, type, source, source_ref, source_label, content, target_file, scope, conflicts, confidence, auto_approve, status, user_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id, item.type, item.source, item.source_ref, item.source_label,
        item.content, item.target_file, item.scope, item.conflicts,
        item.confidence, toBool(item.auto_approve), item.status ?? 'pending', item.user_notes,
      ],
    )
  }

  getById(id: string): Promise<PendingReviewRow | undefined> {
    return this.q1<PendingReviewRow>(`SELECT ${PR_COLS} FROM pending_review WHERE id = ?`, [id])
  }

  listPending(type?: string, status?: string, page = 1, pageSize = 20): Promise<PaginatedResult<PendingReviewRow>> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (type) { conditions.push('type = ?'); params.push(type) }
    if (status) { conditions.push('status = ?'); params.push(status) }
    else { conditions.push("status IN ('pending', 'deferred')") }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return this.paginate<PendingReviewRow>(
      `SELECT ${PR_COLS} FROM pending_review ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      `SELECT COUNT(*) as cnt FROM pending_review ${where}`,
      params,
      page,
      pageSize
    )
  }

  updateStatus(id: string, status: string, userNotes?: string): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE pending_review SET status = ?, reviewed_at = now(), user_notes = COALESCE(?, user_notes) WHERE id = ?`,
      [status, userNotes ?? null, id],
    )
  }

  batchUpdateStatus(ids: string[], status: string): Promise<{ changes: number }> {
    if (ids.length === 0) return Promise.resolve({ changes: 0 })
    const placeholders = ids.map(() => '?').join(',')
    return this.exec(
      `UPDATE pending_review SET status = ?, reviewed_at = now() WHERE id IN (${placeholders})`,
      [status, ...ids],
    )
  }

  async countPending(type?: string): Promise<number> {
    if (type) {
      return Number((await this.q1<{ cnt: number | string }>(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = ?`, [type]))!.cnt)
    }
    return Number((await this.q1<{ cnt: number | string }>(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending'`))!.cnt)
  }

  async countPendingByType(): Promise<{ rules: number; skills: number; total: number }> {
    const rules = Number((await this.q1<{ cnt: number | string }>(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = 'rule'`))!.cnt)
    const skills = Number((await this.q1<{ cnt: number | string }>(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = 'skill'`))!.cnt)
    return { rules, skills, total: rules + skills }
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.q<{ status: string; cnt: number | string }>(
      `SELECT status, COUNT(*) as cnt FROM pending_review GROUP BY status`
    )
    const counts: Record<string, number> = { all: 0, pending: 0, deferred: 0, approved: 0, rejected: 0, edited: 0 }
    for (const row of rows) {
      counts[row.status] = Number(row.cnt)
      counts.all += Number(row.cnt)
    }
    return counts
  }

  /**
   * Cross-tabulated counts: type × status.
   * Returns { rule: { all, pending, ... }, skill: { all, pending, ... }, all: { all, pending, ... } }
   */
  async countByTypeAndStatus(): Promise<Record<string, Record<string, number>>> {
    const rows = await this.q<{ type: string; status: string; cnt: number | string }>(
      `SELECT type, status, COUNT(*) as cnt FROM pending_review GROUP BY type, status`
    )

    const empty = () => ({ all: 0, pending: 0, deferred: 0, approved: 0, rejected: 0, edited: 0 })
    const result: Record<string, Record<string, number>> = {
      rule: empty(),
      all: empty(),
    }

    for (const row of rows) {
      const cnt = Number(row.cnt)
      if (!result[row.type]) result[row.type] = empty()
      result[row.type]![row.status] = cnt
      result[row.type]!.all += cnt
      result.all![row.status] += cnt
      result.all!.all += cnt
    }

    return result
  }

  listBySource(source: string): Promise<PendingReviewRow[]> {
    return this.q<PendingReviewRow>(`SELECT ${PR_COLS} FROM pending_review WHERE source = ? ORDER BY created_at DESC`, [source])
  }

  updateContent(id: string, content: string): Promise<{ changes: number }> {
    return this.exec(`UPDATE pending_review SET content = ? WHERE id = ?`, [content, id])
  }
}
