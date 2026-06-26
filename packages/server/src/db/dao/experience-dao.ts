// packages/server/src/db/dao/experience-dao.ts
// ExperienceDAO — CRUD and lifecycle management for experience_index table.

import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExperienceIndexRow } from "../types-archive"

export class ExperienceDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  insertExperience(row: ExperienceIndexRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO experience_index (
        id, type, title, content, project, package, file_pattern, keywords,
        status, relevance_score, use_count, workflow_name, execution_id,
        resolved_at, resolved_by, org, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.type ?? "pattern", row.title, row.content,
      row.project ?? null, row.package ?? null, row.file_pattern ?? null,
      row.keywords ?? null,
      row.status ?? "active", row.relevance_score ?? 0.5,
      row.use_count ?? 0,
      row.workflow_name ?? null, row.execution_id ?? null,
      row.resolved_at ?? null, row.resolved_by ?? null,
      row.org ?? "",
      row.created_at ?? new Date().toISOString(),
      row.updated_at ?? new Date().toISOString(),
    )
  }

  searchExperiences(
    query: string,
    type?: string,
    status?: string,
    org?: string,
    limit: number = 20,
  ): Array<ExperienceIndexRow & { rank: number }> {
    const typeFilter = type
      ? ` AND ei.type IN (${type.split(",").map(() => "?").join(", ")})`
      : ""
    const statusFilter = status
      ? ` AND ei.status IN (${status.split(",").map(() => "?").join(", ")})`
      : ""
    const orgFilter = org ? " AND ei.org = ?" : ""

    const extraParams: unknown[] = []
    if (type) extraParams.push(...type.split(",").map(s => s.trim()))
    if (status) extraParams.push(...status.split(",").map(s => s.trim()))
    if (org) extraParams.push(org)
    extraParams.push(limit)

    if (!query || query.trim() === "") {
      // No full-text query — return recent items
      return this.stmt(`
        SELECT ei.*, 0 as rank
        FROM experience_index ei
        WHERE 1=1 ${typeFilter} ${statusFilter} ${orgFilter}
        ORDER BY ei.created_at DESC
        LIMIT ?
      `).all(...extraParams) as Array<ExperienceIndexRow & { rank: number }>
    }

    // Use FTS5 MATCH for full-text search
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(" ")

    return this.stmt(`
      SELECT ei.*, fts.rank
      FROM experience_index_fts fts
      JOIN experience_index ei ON ei.rowid = fts.rowid
      WHERE experience_index_fts MATCH ?
        ${typeFilter.replace(/ei\./g, "ei.")}
        ${statusFilter.replace(/ei\./g, "ei.")}
        ${orgFilter.replace(/ei\./g, "ei.")}
      ORDER BY fts.rank, ei.relevance_score DESC, ei.use_count DESC
      LIMIT ?
    `).all(ftsQuery, ...extraParams) as Array<ExperienceIndexRow & { rank: number }>
  }

  findById(id: string): ExperienceIndexRow | null {
    return (this.stmt("SELECT * FROM experience_index WHERE id = ?").get(id) as ExperienceIndexRow) ?? null
  }

  markResolved(keywords: string, resolvedBy: string): number {
    // Extract BUG-\d+, FIX-\d+, ISSUE-\d+ patterns
    const pattern = /(BUG-\d+|FIX-\d+|ISSUE-\d+)/gi
    const matches = keywords.match(pattern)
    if (!matches || matches.length === 0) return 0

    let totalChanges = 0
    for (const kw of matches) {
      const result = this.stmt(`
        UPDATE experience_index
        SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?
        WHERE keywords LIKE ? AND status != 'resolved'
      `).run(resolvedBy, `%${kw}%`)
      totalChanges += result.changes
    }
    return totalChanges
  }

  decayStale(days: number): number {
    const result = this.stmt(`
      UPDATE experience_index
      SET status = 'obsolete', updated_at = datetime('now')
      WHERE use_count = 0
        AND created_at < datetime('now', '-' || ? || ' days')
        AND status = 'active'
    `).run(days)
    return result.changes
  }

  supersede(project: string, filePattern: string, type: string, newId: string): number {
    const result = this.stmt(`
      UPDATE experience_index
      SET status = 'superseded', updated_at = datetime('now')
      WHERE project = ? AND file_pattern = ? AND type = ? AND status = 'active' AND id != ?
    `).run(project, filePattern, type, newId)
    return result.changes
  }

  getByProject(project: string, status?: string): ExperienceIndexRow[] {
    if (status) {
      return this.stmt(`
        SELECT * FROM experience_index
        WHERE project = ? AND status = ?
        ORDER BY created_at DESC
      `).all(project, status) as ExperienceIndexRow[]
    }
    return this.stmt(`
      SELECT * FROM experience_index
      WHERE project = ?
      ORDER BY created_at DESC
    `).all(project) as ExperienceIndexRow[]
  }

  getActiveByScope(projects: string[], types: string[], limit: number): ExperienceIndexRow[] {
    const projectPlaceholders = projects.map(() => "?").join(", ")
    const typePlaceholders = types.map(() => "?").join(", ")
    const params: unknown[] = [...projects, ...types, limit]

    return this.stmt(`
      SELECT * FROM experience_index
      WHERE project IN (${projectPlaceholders})
        AND type IN (${typePlaceholders})
        AND status = 'active'
      ORDER BY relevance_score DESC, use_count DESC
      LIMIT ?
    `).all(...params) as ExperienceIndexRow[]
  }

  incrementUseCount(ids: string[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => "?").join(", ")
    this.stmt(`
      UPDATE experience_index
      SET use_count = use_count + 1, updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...ids)
  }

  getByExecution(executionId: string): ExperienceIndexRow[] {
    return this.stmt(`
      SELECT * FROM experience_index
      WHERE execution_id = ?
      ORDER BY created_at DESC
    `).all(executionId) as ExperienceIndexRow[]
  }

  deleteObsolete(days: number): number {
    const result = this.stmt(`
      DELETE FROM experience_index
      WHERE status = 'obsolete'
        AND created_at < datetime('now', '-' || ? || ' days')
    `).run(days)
    return result.changes
  }

  getByOrg(org: string, limit: number = 50): ExperienceIndexRow[] {
    return this.stmt(`
      SELECT * FROM experience_index
      WHERE org = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(org, limit) as ExperienceIndexRow[]
  }
}
