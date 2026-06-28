import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExperienceIndexRow, PaginatedResult } from "../types"

export class ExperienceDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  insert(row: Omit<ExperienceIndexRow, "rowid" | "created_at" | "updated_at"> & { created_at?: string; updated_at?: string }): string {
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO experience_index (id, org, archive_id, workflow_name, type, title, content, status, resolved_at, resolved_by, project, package, file_pattern, keywords, relevance_score, use_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.archive_id, row.workflow_name, row.type, row.title, row.content,
      row.status, row.resolved_at, row.resolved_by, row.project, row.package, row.file_pattern,
      row.keywords, row.relevance_score, row.use_count,
      row.created_at ?? now, row.updated_at ?? now
    )
    return row.id
  }

  findById(id: string): ExperienceIndexRow | null {
    return (this.stmt("SELECT * FROM experience_index WHERE id = ?").get(id) as ExperienceIndexRow) ?? null
  }

  searchFTS(query: string, opts: { org?: string; project?: string; type?: string; status?: string; limit?: number }): ExperienceIndexRow[] {
    const conditions: string[] = ["experience_index_fts MATCH ?"]
    const params: unknown[] = [query]
    if (opts.org) { conditions.push("ei.org = ?"); params.push(opts.org) }
    if (opts.project) { conditions.push("ei.project = ?"); params.push(opts.project) }
    if (opts.type) { conditions.push("ei.type = ?"); params.push(opts.type) }
    if (opts.status) { conditions.push("ei.status = ?"); params.push(opts.status) }
    const limit = opts.limit ?? 20
    const where = conditions.join(" AND ")
    return this.stmt(`
      SELECT ei.* FROM experience_index ei
      JOIN experience_index_fts ON experience_index_fts.rowid = ei.rowid
      WHERE ${where}
      ORDER BY rank
      LIMIT ?
    `).all(...params, limit) as ExperienceIndexRow[]
  }

  findByScope(scope: { projects?: string[]; packages?: string[]; types?: string[]; status: string; limit: number }): ExperienceIndexRow[] {
    const conditions: string[] = ["status = ?"]
    const params: unknown[] = [scope.status]
    if (scope.projects?.length) {
      conditions.push(`project IN (${scope.projects.map(() => "?").join(",")})`)
      params.push(...scope.projects)
    }
    if (scope.packages?.length) {
      conditions.push(`package IN (${scope.packages.map(() => "?").join(",")})`)
      params.push(...scope.packages)
    }
    if (scope.types?.length) {
      conditions.push(`type IN (${scope.types.map(() => "?").join(",")})`)
      params.push(...scope.types)
    }
    const where = conditions.join(" AND ")
    return this.stmt(`
      SELECT * FROM experience_index
      WHERE ${where}
      ORDER BY relevance_score DESC, use_count DESC
      LIMIT ?
    `).all(...params, scope.limit) as ExperienceIndexRow[]
  }

  updateStatus(id: string, status: string, resolvedAt?: string, resolvedBy?: string): void {
    const now = new Date().toISOString()
    this.stmt(`
      UPDATE experience_index SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?
    `).run(status, resolvedAt ?? null, resolvedBy ?? null, now, id)
  }

  incrementUseCount(ids: string[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => "?").join(",")
    this.stmt(`
      UPDATE experience_index SET use_count = use_count + 1 WHERE id IN (${placeholders})
    `).run(...ids)
  }

  decayStale(daysThreshold: number): number {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString()
    const result = this.stmt(`
      UPDATE experience_index SET status = 'obsolete', updated_at = datetime('now')
      WHERE use_count = 0 AND created_at < ? AND status = 'active'
    `).run(cutoff)
    return result.changes
  }

  supersedeByDimension(project: string, filePattern: string, type: string, excludeId: string): void {
    this.stmt(`
      UPDATE experience_index SET status = 'superseded', updated_at = datetime('now')
      WHERE project = ? AND file_pattern = ? AND type = ? AND id != ? AND status = 'active'
    `).run(project, filePattern, type, excludeId)
  }

  countByType(org: string, status?: string): Record<string, number> {
    let sql = "SELECT type, COUNT(*) as cnt FROM experience_index WHERE org = ?"
    const params: unknown[] = [org]
    if (status) { sql += " AND status = ?"; params.push(status) }
    sql += " GROUP BY type"
    const rows = this.stmt(sql).all(...params) as { type: string; cnt: number }[]
    const result: Record<string, number> = {}
    for (const r of rows) result[r.type] = r.cnt
    return result
  }

  listActive(org: string, opts: { page: number; pageSize: number; project?: string; type?: string }): PaginatedResult<ExperienceIndexRow> {
    const conditions: string[] = ["org = ?", "status = 'active'"]
    const params: unknown[] = [org]
    if (opts.project) { conditions.push("project = ?"); params.push(opts.project) }
    if (opts.type) { conditions.push("type = ?"); params.push(opts.type) }
    const where = conditions.join(" AND ")
    const dataSql = `SELECT * FROM experience_index WHERE ${where} ORDER BY relevance_score DESC, created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as cnt FROM experience_index WHERE ${where}`
    return this.paginate<ExperienceIndexRow>(dataSql, countSql, params, opts.page, opts.pageSize)
  }
}
