import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

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

export class PendingReviewDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  insert(item: Omit<PendingReviewRow, 'created_at' | 'reviewed_at'>): void {
    this.stmt(
      `INSERT INTO pending_review (id, type, source, source_ref, source_label, content, target_file, scope, conflicts, confidence, auto_approve, status, user_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      item.id, item.type, item.source, item.source_ref, item.source_label,
      item.content, item.target_file, item.scope, item.conflicts,
      item.confidence, item.auto_approve, item.status ?? 'pending', item.user_notes
    )
  }

  getById(id: string): PendingReviewRow | undefined {
    return this.stmt(`SELECT * FROM pending_review WHERE id = ?`).get(id) as PendingReviewRow | undefined
  }

  listPending(type?: string, status?: string, page = 1, pageSize = 20): { data: PendingReviewRow[]; total: number; page: number; pageSize: number } {
    const conditions: string[] = []
    const params: unknown[] = []

    if (type) { conditions.push('type = ?'); params.push(type) }
    if (status) { conditions.push('status = ?'); params.push(status) }
    else { conditions.push("status IN ('pending', 'deferred')") }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return this.paginate<PendingReviewRow>(
      `SELECT * FROM pending_review ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      `SELECT COUNT(*) as cnt FROM pending_review ${where}`,
      params,
      page,
      pageSize
    )
  }

  updateStatus(id: string, status: string, userNotes?: string): void {
    this.stmt(
      `UPDATE pending_review SET status = ?, reviewed_at = datetime('now'), user_notes = COALESCE(?, user_notes) WHERE id = ?`
    ).run(status, userNotes ?? null, id)
  }

  batchUpdateStatus(ids: string[], status: string): void {
    const placeholders = ids.map(() => '?').join(',')
    this.stmt(
      `UPDATE pending_review SET status = ?, reviewed_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(status, ...ids)
  }

  countPending(type?: string): number {
    if (type) {
      return (this.stmt(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = ?`).get(type) as { cnt: number }).cnt
    }
    return (this.stmt(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending'`).get() as { cnt: number }).cnt
  }

  countPendingByType(): { rules: number; skills: number } {
    const rules = (this.stmt(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = 'rule'`).get() as { cnt: number }).cnt
    const skills = (this.stmt(`SELECT COUNT(*) as cnt FROM pending_review WHERE status = 'pending' AND type = 'skill'`).get() as { cnt: number }).cnt
    return { rules, skills }
  }

  listBySource(source: string): PendingReviewRow[] {
    return this.stmt(`SELECT * FROM pending_review WHERE source = ? ORDER BY created_at DESC`).all(source) as PendingReviewRow[]
  }

  updateContent(id: string, content: string): void {
    this.stmt(`UPDATE pending_review SET content = ? WHERE id = ?`).run(content, id)
  }
}
