import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { EvolutionLogRow, ExperienceRow, ExperienceRowV2, InsightMarkRow } from "../types"

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
        INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
        VALUES (?, ?, ?, 'agent', NULL, '[]')
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

  /**
   * Find recent experiences filtered by scope, for scope-aware reflection.
   * Returns V2 rows so pattern_tags and outcome are available for analysis.
   */
  findRecentExperiencesForReflectionByScope(
    org: string,
    scope: string,
    limit: number = 20,
  ): ExperienceRowV2[] {
    return this.stmt(`
      SELECT * FROM experiences
      WHERE org = ? AND scope = ? AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(org, scope, limit) as ExperienceRowV2[]
  }

  /**
   * Find experiences with failure patterns filtered by scope.
   */
  findExperiencesWithFailurePatternByScope(
    org: string,
    scope: string,
  ): Array<{ count: number; skill_name: string; scope_ref: string | null }> {
    return this.stmt(`
      SELECT COUNT(*) as count, skill_name, scope_ref
      FROM experiences
      WHERE org = ? AND scope = ? AND created_at > datetime('now', '-7 days')
      AND (content LIKE '%失败%' OR content LIKE '%error%' OR content LIKE '%failed%')
      GROUP BY skill_name, scope_ref HAVING count >= 3
    `).all(org, scope) as Array<{ count: number; skill_name: string; scope_ref: string | null }>
  }

  insertExperienceWithFts(row: Omit<ExperienceRow, "id">): Database.RunResult {
    const result = this.stmt(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at)

    try {
      this.stmt(`
        INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
        VALUES (?, ?, ?, 'agent', NULL, '[]')
      `).run(result.lastInsertRowid, row.skill_name, row.content)
    } catch {
      // FTS insert failure is non-fatal
    }
    return result
  }

  /**
   * Insert an experience with all V2 scope-aware fields.
   * Inserts into both experiences table and FTS index.
   */
  insertExperienceV2(row: Omit<ExperienceRowV2, "id">): Database.RunResult {
    const result = this.stmt(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at,
        scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at,
      row.scope, row.scope_ref ?? null, row.pattern_tags, row.outcome ?? null,
      row.source_type, row.execution_id ?? null, row.node_id ?? null,
    )

    try {
      this.stmt(`
        INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        result.lastInsertRowid, row.skill_name, row.content,
        row.scope, row.scope_ref ?? null, row.pattern_tags,
      )
    } catch {
      // FTS insert failure is non-fatal
    }
    return result
  }

  // ── Experiences V2 (scope-aware) ────────────────────────────────

  /**
   * List experiences filtered by scope, with optional scope_ref and limit.
   */
  listByScope(
    org: string,
    scope: string,
    opts?: { scopeRef?: string; limit?: number },
  ): ExperienceRowV2[] {
    const limit = Math.min(opts?.limit ?? 50, 200)
    let sql = `SELECT * FROM experiences WHERE org = ? AND scope = ?`
    const params: unknown[] = [org, scope]
    if (opts?.scopeRef) {
      sql += ` AND scope_ref = ?`
      params.push(opts.scopeRef)
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as ExperienceRowV2[]
  }

  /**
   * Scope-aware FTS5 search with LIKE fallback.
   * Searches skill_name, content, scope, scope_ref, and pattern_tags.
   */
  searchByScope(
    query: string,
    scope?: string,
    limit: number = 10,
  ): Array<{ id: number; skill_name: string; content: string; scope: string; scope_ref: string | null; pattern_tags: string; outcome: string | null }> {
    const safeLimit = Math.min(limit, 100)
    try {
      let sql: string
      const params: unknown[] = []
      if (scope) {
        sql = `
          SELECT e.id, e.skill_name, e.content, e.scope, e.scope_ref, e.pattern_tags, e.outcome
          FROM experiences e
          JOIN experiences_fts fts ON e.id = fts.rowid
          WHERE experiences_fts MATCH ? AND e.scope = ?
          ORDER BY rank
          LIMIT ?
        `
        params.push(query, scope, safeLimit)
      } else {
        sql = `
          SELECT e.id, e.skill_name, e.content, e.scope, e.scope_ref, e.pattern_tags, e.outcome
          FROM experiences e
          JOIN experiences_fts fts ON e.id = fts.rowid
          WHERE experiences_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `
        params.push(query, safeLimit)
      }
      return this.stmt(sql).all(...params) as Array<{
        id: number; skill_name: string; content: string; scope: string;
        scope_ref: string | null; pattern_tags: string; outcome: string | null
      }>
    } catch {
      // FTS MATCH failed — fallback to LIKE search
      let sql = `
        SELECT id, skill_name, content, scope, scope_ref, pattern_tags, outcome
        FROM experiences WHERE content LIKE ?
      `
      const params: unknown[] = [`%${query}%`]
      if (scope) {
        sql += ` AND scope = ?`
        params.push(scope)
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`
      params.push(safeLimit)
      return this.stmt(sql).all(...params) as Array<{
        id: number; skill_name: string; content: string; scope: string;
        scope_ref: string | null; pattern_tags: string; outcome: string | null
      }>
    }
  }

  /**
   * Update the outcome field for an experience row.
   * Outcome is a JSON string: {label, success_rate, usage_count, last_applied}.
   */
  updateOutcome(id: number, outcome: string): Database.RunResult {
    return this.stmt("UPDATE experiences SET outcome = ? WHERE id = ?").run(outcome, id)
  }

  /**
   * List experiences for a given execution_id, optionally filtered by outcome label.
   * Used by HarnessController.onExecutionEnd() to batch-update pending outcomes.
   */
  listByExecutionId(
    executionId: string,
    opts?: { outcomeLabel?: string },
  ): ExperienceRowV2[] {
    let sql = `SELECT * FROM experiences WHERE execution_id = ?`
    const params: unknown[] = [executionId]
    if (opts?.outcomeLabel) {
      sql += ` AND json_extract(outcome, '$.label') = ?`
      params.push(opts.outcomeLabel)
    }
    sql += ` ORDER BY created_at ASC`
    return this.stmt(sql).all(...params) as ExperienceRowV2[]
  }

  /**
   * Aggregate success rate statistics grouped by decision (from pattern_tags) and scope.
   *
   * Returns two stat maps:
   * - decisionStats: { [decision]: { success: number, failed: number, pending: number, total: number, rate: number } }
   * - patternStats: { [pattern]: { success: number, failed: number, pending: number, total: number, rate: number } }
   *
   * Only includes decisions/patterns with ≥1 resolved outcome.
   */
  getSuccessStats(
    org: string,
    scope: string,
    scopeRef?: string,
  ): {
    decisionStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }>
    patternStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }>
  } {
    let sql = `SELECT pattern_tags, outcome FROM experiences WHERE org = ? AND scope = ?`
    const params: unknown[] = [org, scope]
    if (scopeRef) {
      sql += ` AND scope_ref = ?`
      params.push(scopeRef)
    }

    const rows = this.stmt(sql).all(...params) as Array<{ pattern_tags: string; outcome: string | null }>

    const decisionMap = new Map<string, { success: number; failed: number; pending: number }>()
    const patternMap = new Map<string, { success: number; failed: number; pending: number }>()

    const getOrInit = (map: Map<string, { success: number; failed: number; pending: number }>, key: string) => {
      let entry = map.get(key)
      if (!entry) {
        entry = { success: 0, failed: 0, pending: 0 }
        map.set(key, entry)
      }
      return entry
    }

    for (const row of rows) {
      let outcomeLabel: string
      try {
        const parsed = row.outcome ? JSON.parse(row.outcome) : null
        outcomeLabel = parsed?.label ?? "pending"
      } catch {
        outcomeLabel = "pending"
      }

      // Parse pattern_tags as JSON array
      let tags: string[] = []
      try {
        const parsed = JSON.parse(row.pattern_tags || "[]")
        tags = Array.isArray(parsed) ? parsed : []
      } catch {
        tags = []
      }

      // First tag is treated as the decision type
      const decision = tags[0]
      if (decision) {
        const entry = getOrInit(decisionMap, decision)
        if (outcomeLabel === "success") entry.success++
        else if (outcomeLabel === "failed") entry.failed++
        else entry.pending++
      }

      // All tags contribute to pattern stats
      for (const tag of tags) {
        const entry = getOrInit(patternMap, tag)
        if (outcomeLabel === "success") entry.success++
        else if (outcomeLabel === "failed") entry.failed++
        else entry.pending++
      }
    }

    const computeRate = (entry: { success: number; failed: number; pending: number }) => {
      const total = entry.success + entry.failed + entry.pending
      const resolved = entry.success + entry.failed
      return {
        ...entry,
        total,
        rate: resolved > 0 ? Math.round((entry.success / resolved) * 100) / 100 : 0,
      }
    }

    const decisionStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }> = {}
    for (const [key, val] of decisionMap) {
      decisionStats[key] = computeRate(val)
    }

    const patternStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }> = {}
    for (const [key, val] of patternMap) {
      patternStats[key] = computeRate(val)
    }

    return { decisionStats, patternStats }
  }

  // ── insight_marks ──────────────────────────────────────────────────

  insertMark(row: { skill_name: string; insight: string; session_id?: string; org: string }): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(`
      INSERT INTO insight_marks (skill_name, insight, session_id, org, marked_at, processed)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(row.skill_name, row.insight, row.session_id ?? null, row.org, now)
  }

  listUnprocessedMarks(org: string, limit: number = 50): InsightMarkRow[] {
    return this.stmt(`
      SELECT * FROM insight_marks
      WHERE org = ? AND processed = 0
      ORDER BY marked_at ASC
      LIMIT ?
    `).all(org, limit) as InsightMarkRow[]
  }

  markProcessed(id: number): Database.RunResult {
    return this.stmt("UPDATE insight_marks SET processed = 1 WHERE id = ?").run(id)
  }

  listAllMarks(org: string, filters?: { processed?: number; limit?: number }): InsightMarkRow[] {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT * FROM insight_marks WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.processed !== undefined) {
      sql += ` AND processed = ?`
      params.push(filters.processed)
    }
    sql += ` ORDER BY marked_at DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as InsightMarkRow[]
  }
}
