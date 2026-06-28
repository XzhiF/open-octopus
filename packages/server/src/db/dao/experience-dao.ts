import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExperienceIndexRow } from "../types"

export class ExperienceDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  insert(item: Omit<ExperienceIndexRow, "id" | "created_at"> & { created_at?: string }): number {
    const now = new Date().toISOString()
    const result = this.stmt(`
      INSERT INTO experience_index (
        type, title, content, project, package, file_pattern, keywords,
        workflow_name, status, relevance_score, use_count,
        resolved_at, resolved_by, superseded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.type, item.title, item.content,
      item.project ?? null, item.package ?? null, item.file_pattern ?? null,
      item.keywords ?? null, item.workflow_name ?? null,
      item.status ?? 'active', item.relevance_score ?? 0, item.use_count ?? 0,
      item.resolved_at ?? null, item.resolved_by ?? null, item.superseded_by ?? null,
      item.created_at ?? now,
    )
    return Number(result.lastInsertRowid)
  }

  findById(id: number): ExperienceIndexRow | null {
    return (this.stmt("SELECT * FROM experience_index WHERE id = ?").get(id) as ExperienceIndexRow) ?? null
  }

  updateStatus(id: number, status: string, resolvedBy?: string): void {
    this.stmt(
      "UPDATE experience_index SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?"
    ).run(status, status !== 'active' ? new Date().toISOString() : null, resolvedBy ?? null, id)
  }

  incrementUseCount(ids: number[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => "?").join(",")
    this.stmt(
      `UPDATE experience_index SET use_count = use_count + 1 WHERE id IN (${placeholders})`
    ).run(...ids)
  }

  /**
   * FTS search with filters.
   * Uses experience_index_fts MATCH for full-text search.
   */
  search(query: string, filters?: {
    project?: string
    type?: string
    status?: string
    limit?: number
  }): Array<ExperienceIndexRow & { relevance_score: number }> {
    let sql = `
      SELECT ei.*, bm25(experience_index_fts) as relevance_score
      FROM experience_index_fts
      JOIN experience_index ei ON ei.rowid = experience_index_fts.rowid
      WHERE experience_index_fts MATCH ?
    `
    const filterParams: unknown[] = [query]

    if (filters?.project) {
      sql += " AND ei.project = ?"
      filterParams.push(filters.project)
    }
    if (filters?.type) {
      sql += " AND ei.type = ?"
      filterParams.push(filters.type)
    }
    if (filters?.status) {
      sql += " AND ei.status = ?"
      filterParams.push(filters.status)
    } else {
      sql += " AND ei.status = 'active'"
    }

    sql += " ORDER BY bm25(experience_index_fts) LIMIT ?"
    filterParams.push(filters?.limit ?? 20)

    return this.stmt(sql).all(...filterParams) as Array<ExperienceIndexRow & { relevance_score: number }>
  }

  /**
   * Find experiences matching the given scope (for engine injection).
   */
  findByScope(scope: {
    projects: string[]
    packages?: string[]
    types: string[]
    limit: number
  }): ExperienceIndexRow[] {
    if (scope.projects.length === 0 || scope.types.length === 0) return []

    const projectPlaceholders = scope.projects.map(() => "?").join(",")
    const typePlaceholders = scope.types.map(() => "?").join(",")

    let sql = `
      SELECT * FROM experience_index
      WHERE project IN (${projectPlaceholders})
        AND type IN (${typePlaceholders})
        AND status = 'active'
    `
    const params: unknown[] = [...scope.projects, ...scope.types]

    if (scope.packages && scope.packages.length > 0) {
      const packagePlaceholders = scope.packages.map(() => "?").join(",")
      sql += ` AND (package IN (${packagePlaceholders}) OR package IS NULL)`
      params.push(...scope.packages)
    }

    sql += " ORDER BY relevance_score DESC LIMIT ?"
    params.push(scope.limit)

    return this.stmt(sql).all(...params) as ExperienceIndexRow[]
  }

  /**
   * Find stale entries for decay (use_count <= maxUseCount and older than N days).
   */
  findStale(days: number, maxUseCount: number): ExperienceIndexRow[] {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    return this.stmt(
      "SELECT * FROM experience_index WHERE use_count <= ? AND created_at < ? AND status = 'active'"
    ).all(maxUseCount, cutoff) as ExperienceIndexRow[]
  }

  /**
   * Find same-dimension entries for supersede detection.
   */
  findByDimensions(project: string, filePattern: string | null, type: string): ExperienceIndexRow[] {
    if (filePattern) {
      return this.stmt(
        "SELECT * FROM experience_index WHERE project = ? AND file_pattern = ? AND type = ? AND status = 'active'"
      ).all(project, filePattern, type) as ExperienceIndexRow[]
    }
    return this.stmt(
      "SELECT * FROM experience_index WHERE project = ? AND file_pattern IS NULL AND type = ? AND status = 'active'"
    ).all(project, type) as ExperienceIndexRow[]
  }

  /**
   * Get active entries for knowledge base file rebuild.
   */
  getActiveByProject(project: string, type?: string, limit: number = 50): ExperienceIndexRow[] {
    let sql = "SELECT * FROM experience_index WHERE project = ? AND status = 'active'"
    const params: unknown[] = [project]
    if (type) {
      sql += " AND type = ?"
      params.push(type)
    }
    sql += " ORDER BY relevance_score DESC LIMIT ?"
    params.push(limit)
    return this.stmt(sql).all(...params) as ExperienceIndexRow[]
  }

  /**
   * Mark entries as resolved by PR reference.
   * Searches content for the ref pattern.
   */
  markResolvedByRef(ref: string, resolvedBy: string): number {
    const result = this.stmt(`
      UPDATE experience_index SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?
      WHERE status = 'active' AND (content LIKE ? OR title LIKE ?)
    `).run(resolvedBy, `%${ref}%`, `%${ref}%`)
    return result.changes ?? 0
  }

  /**
   * Mark entries as superseded.
   */
  markSuperseded(ids: number[], supersededBy: number): void {
    if (ids.length === 0) return
    this.transaction(() => {
      const stmt = this.stmt(
        "UPDATE experience_index SET status = 'superseded', superseded_by = ? WHERE id = ?"
      )
      for (const id of ids) {
        stmt.run(supersededBy, id)
      }
    })
  }

  /**
   * Count active entries by project (for stats).
   */
  countByProject(project: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) as cnt FROM experience_index WHERE project = ? AND status = 'active'"
    ).get(project) as { cnt: number }
    return row.cnt
  }

  /**
   * Count all by status (for stats).
   */
  countByStatus(): Record<string, number> {
    const rows = this.stmt(
      "SELECT status, COUNT(*) as cnt FROM experience_index GROUP BY status"
    ).all() as Array<{ status: string; cnt: number }>
    const result: Record<string, number> = {}
    for (const row of rows) result[row.status] = row.cnt
    return result
  }

  /**
   * Find by execution archive (for detail page).
   */
  findByArchiveId(archiveExecutionId: string): ExperienceIndexRow[] {
    // Search experiences whose workflow_name matches the archived execution's workflow
    return this.stmt(
      `SELECT * FROM experience_index
       WHERE workflow_name IN (
         SELECT workflow_name FROM execution_archive WHERE execution_id = ?
       ) AND status = 'active'
       ORDER BY relevance_score DESC LIMIT 20`
    ).all(archiveExecutionId) as ExperienceIndexRow[]
  }
}
