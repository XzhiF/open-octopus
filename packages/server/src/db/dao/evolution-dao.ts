import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { EvolutionLogRow, ExperienceRow } from "../types"

/**
 * EvolutionDAO — skill evolution and experience management.
 * Covers: evolution_log, experiences, experiences_fts tables.
 */
export class EvolutionDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── evolution_log ───────────────────────────────────────────────

  listChangelog(org: string, filters?: { skill_name?: string; limit?: number }): EvolutionLogRow[] {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT * FROM evolution_log WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.skill_name) { sql += ` AND skill_name = ?`; params.push(filters.skill_name) }
    sql += ` ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as EvolutionLogRow[]
  }

  findEvolutionById(id: number): EvolutionLogRow | null {
    return (this.stmt("SELECT * FROM evolution_log WHERE id = ?").get(id) as EvolutionLogRow) ?? null
  }

  findEvolutionByIdAndOrg(id: number, org: string): EvolutionLogRow | null {
    return (this.stmt("SELECT * FROM evolution_log WHERE id = ? AND org = ?").get(id, org) as EvolutionLogRow) ?? null
  }

  insertEvolution(row: Omit<EvolutionLogRow, "id" | "rolled_back"> & { rolled_back?: number }): Database.RunResult {
    return this.stmt(`
      INSERT INTO evolution_log (skill_name, change_type, level, summary, diff_path, rolled_back, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.skill_name, row.change_type, row.level, row.summary,
      row.diff_path ?? null, row.rolled_back ?? 0, row.org, row.timestamp,
    )
  }

  markRolledBack(id: number): Database.RunResult {
    return this.stmt("UPDATE evolution_log SET rolled_back = 1 WHERE id = ?").run(id)
  }

  // ── experiences ─────────────────────────────────────────────────

  listExperiences(org: string, skillName?: string): ExperienceRow[] {
    let sql = `SELECT * FROM experiences WHERE org = ?`
    const params: unknown[] = [org]
    if (skillName) { sql += ` AND skill_name = ?`; params.push(skillName) }
    sql += ` ORDER BY created_at DESC`
    return this.stmt(sql).all(...params) as ExperienceRow[]
  }

  findRecentExperiences(org: string, daysAgo: number = 7, limit: number = 20): ExperienceRow[] {
    return this.stmt(`
      SELECT * FROM experiences
      WHERE org = ? AND created_at > datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT ?
    `).all(org, daysAgo, limit) as ExperienceRow[]
  }

  findExperiencesWithFailurePattern(org: string): Array<{ count: number; skill_name: string }> {
    return this.stmt(`
      SELECT COUNT(*) as count, skill_name FROM experiences
      WHERE org = ? AND created_at > datetime('now', '-7 days')
      AND (content LIKE '%失败%' OR content LIKE '%error%' OR content LIKE '%failed%')
      GROUP BY skill_name HAVING count >= 3
    `).all(org) as Array<{ count: number; skill_name: string }>
  }

  insertExperience(row: Omit<ExperienceRow, "id">): Database.RunResult {
    const result = this.stmt(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at)

    // Also insert into FTS index (non-fatal on failure)
    try {
      this.stmt(`
        INSERT INTO experiences_fts (rowid, skill_name, content)
        VALUES (?, ?, ?)
      `).run(result.lastInsertRowid, row.skill_name, row.content)
    } catch {
      // FTS insert failure is non-fatal
    }

    return result
  }

  searchExperiences(query: string, limit: number = 10): Array<{ skill_name: string; content: string }> {
    try {
      return this.stmt(`
        SELECT skill_name, content FROM experiences_fts
        WHERE experiences_fts MATCH ? LIMIT ?
      `).all(query, limit) as Array<{ skill_name: string; content: string }>
    } catch {
      return this.stmt(`
        SELECT skill_name, content FROM experiences_fts
        WHERE content LIKE ? LIMIT ?
      `).all(`%${query}%`, limit) as Array<{ skill_name: string; content: string }>
    }
  }

  // ── Additional methods for evolution-service migration ─────────────

  findEvolutionByIdAndOrgChecked(id: number, org: string): EvolutionLogRow | null {
    return (this.stmt("SELECT * FROM evolution_log WHERE id = ? AND org = ?").get(id, org) as EvolutionLogRow) ?? null
  }

  findRecentExperiencesForReflection(org: string, limit: number = 20): ExperienceRow[] {
    return this.stmt(`
      SELECT skill_name, content FROM experiences
      WHERE org = ? AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(org, limit) as ExperienceRow[]
  }

  insertExperienceWithFts(row: Omit<ExperienceRow, "id">): Database.RunResult {
    const result = this.stmt(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at)

    try {
      this.stmt(`
        INSERT INTO experiences_fts (rowid, skill_name, content)
        VALUES (?, ?, ?)
      `).run(result.lastInsertRowid, row.skill_name, row.content)
    } catch {
      // FTS insert failure is non-fatal
    }
    return result
  }
}
