import { BasePgDAO, type PgSql } from "./base-pg"
import type { EvolutionLogRow, ExperienceRow, ExperienceRowV2, InsightMarkRow } from "../types"
import { bool, flag, iso, jsonStr, num } from "./pg-mappers"
import { queryTokens, scoreNorm } from "./query-tokens"

/**
 * EvolutionDAO — skill evolution and experience management.
 * Covers: evolution_log, experiences, insight_marks tables
 * (P1 B3: better-sqlite3 → postgres.js)。
 *
 * 行形态契约（pg-mappers 出口归一，旧 Row 接口不动直到 B6）：
 *   - evolution_log.rolled_back / insight_marks.processed: PG boolean ↔ 旧 0/1。
 *   - id 列（IDENTITY bigint）→ postgres.js int8 字符串 → num() 归一 number。
 *   - timestamp/created_at/marked_at: timestamptz(Date) ↔ 旧 ISO 文本。
 *   - experiences.pattern_tags: PG jsonb ↔ 旧 JSON 数组文本（出口 jsonStr）。
 *   - json_extract(outcome,'$.label') → `outcome::jsonb ->> 'label'`（S5）——
 *     outcome 列保持 text，写入侧全部是 JSON.stringify 产物；非 JSON 脏行会抛
 *     22P02（SQLite json_extract 静默 NULL），归属见 B3 报告。
 *
 * FTS 面（P1 B3 段2 终态）：experiences_fts 虚表 + jieba 预分词影子列退役 ——
 *   检索走 experiences 真表 pg_search BM25 索引 idx_experiences_bm25
 *   （列面 = 旧 MATCH 面：skill_name/content/scope/scope_ref/pattern_tags），
 *   tantivy 抛错或零命中退回 ILIKE 两段式。返回原文 content/skill_name 的契约不变。
 */

/** ILIKE 模式串转义。 */
function likePattern(token: string): string {
  return `%${token.replace(/[%_\\]/g, '\\$&')}%`
}

/**
 * JSON 文本 → 对象（jsonb 参数专用，与 agent-session-dao 同因）：postgres.js 实测
 * 对 jsonb 参数（含 `?::jsonb` —— PG 把参数类型直接推断为 jsonb）会把 JS string 再
 * JSON.stringify 成 jsonb 字符串标量，算子面失明。绑前解析成对象才是唯一正确姿势。
 */
function jsonbParam(v: unknown): unknown {
  if (typeof v !== "string") return v
  try { return JSON.parse(v) } catch { return v }
}

interface EvolutionLogPgRow {
  id: string | number
  skill_name: string
  change_type: string
  level: string
  summary: string
  diff_path: string | null
  rolled_back: boolean | number
  org: string
  timestamp: Date | string
}

interface ExperiencePgRow {
  id: string | number
  skill_name: string
  content: string
  source_session_id: string | null
  org: string
  created_at: Date | string
  scope: string
  scope_ref: string | null
  pattern_tags: unknown
  outcome: string | null
  source_type: string
  execution_id: string | null
  node_id: string | null
}

interface InsightMarkPgRow {
  id: string | number
  skill_name: string
  insight: string
  session_id: string | null
  org: string
  marked_at: Date | string
  processed: boolean | number
}

function fromEvolutionLog(r: EvolutionLogPgRow): EvolutionLogRow {
  return {
    id: num(r.id),
    skill_name: r.skill_name,
    change_type: r.change_type,
    level: r.level,
    summary: r.summary,
    diff_path: r.diff_path,
    rolled_back: flag(r.rolled_back),
    org: r.org,
    timestamp: iso(r.timestamp),
  }
}

function fromExperience(r: ExperiencePgRow): ExperienceRowV2 {
  return {
    id: num(r.id),
    skill_name: r.skill_name,
    content: r.content,
    source_session_id: r.source_session_id,
    org: r.org,
    created_at: iso(r.created_at),
    scope: r.scope,
    scope_ref: r.scope_ref,
    pattern_tags: jsonStr(r.pattern_tags) ?? '[]',
    outcome: r.outcome,
    source_type: r.source_type,
    execution_id: r.execution_id,
    node_id: r.node_id,
  }
}

function fromMark(r: InsightMarkPgRow): InsightMarkRow {
  return {
    id: num(r.id),
    skill_name: r.skill_name,
    insight: r.insight,
    session_id: r.session_id,
    org: r.org,
    marked_at: iso(r.marked_at),
    processed: flag(r.processed),
  }
}

export class EvolutionDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── evolution_log ───────────────────────────────────────────────

  async listChangelog(org: string, filters?: { skill_name?: string; limit?: number }): Promise<EvolutionLogRow[]> {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT * FROM evolution_log WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.skill_name) { sql += ` AND skill_name = ?`; params.push(filters.skill_name) }
    sql += ` ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)
    const rows = await this.q<EvolutionLogPgRow>(sql, params)
    return rows.map(fromEvolutionLog)
  }

  async findEvolutionById(id: number): Promise<EvolutionLogRow | null> {
    const r = await this.q1<EvolutionLogPgRow>("SELECT * FROM evolution_log WHERE id = ?", [id])
    return r ? fromEvolutionLog(r) : null
  }

  async findEvolutionByIdAndOrg(id: number, org: string): Promise<EvolutionLogRow | null> {
    const r = await this.q1<EvolutionLogPgRow>("SELECT * FROM evolution_log WHERE id = ? AND org = ?", [id, org])
    return r ? fromEvolutionLog(r) : null
  }

  async insertEvolution(row: Omit<EvolutionLogRow, "id" | "rolled_back"> & { rolled_back?: number }): Promise<{ changes: number; id: number }> {
    const r = await this.q1<{ id: string | number }>(`
      INSERT INTO evolution_log (skill_name, change_type, level, summary, diff_path, rolled_back, org, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      row.skill_name, row.change_type, row.level, row.summary,
      row.diff_path ?? null, bool(row.rolled_back ?? 0), row.org, row.timestamp,
    ])
    return { changes: 1, id: num(r?.id) }
  }

  async markRolledBack(id: number): Promise<{ changes: number }> {
    return this.exec("UPDATE evolution_log SET rolled_back = true WHERE id = ?", [id])
  }

  // ── experiences ─────────────────────────────────────────────────

  async listExperiences(org: string, skillName?: string): Promise<ExperienceRow[]> {
    let sql = `SELECT * FROM experiences WHERE org = ?`
    const params: unknown[] = [org]
    if (skillName) { sql += ` AND skill_name = ?`; params.push(skillName) }
    sql += ` ORDER BY created_at DESC`
    const rows = await this.q<ExperiencePgRow>(sql, params)
    return rows.map(fromExperience)
  }

  async findRecentExperiences(org: string, daysAgo: number = 7, limit: number = 20): Promise<ExperienceRow[]> {
    const rows = await this.q<ExperiencePgRow>(`
      SELECT * FROM experiences
      WHERE org = ? AND created_at > now() - make_interval(days => ?::int)
      ORDER BY created_at DESC LIMIT ?
    `, [org, daysAgo, limit])
    return rows.map(fromExperience)
  }

  async findExperiencesWithFailurePattern(org: string): Promise<Array<{ count: number; skill_name: string }>> {
    return this.q<{ count: number; skill_name: string }>(`
      SELECT COUNT(*)::int AS count, skill_name FROM experiences
      WHERE org = ? AND created_at > now() - interval '7 days'
      AND (content LIKE '%失败%' OR content LIKE '%error%' OR content LIKE '%failed%')
      GROUP BY skill_name HAVING COUNT(*) >= 3
    `, [org])
  }

  /**
   * v1 经验写入（PG 面：experiences 真表；原 experiences_fts 影子写退役）。
   */
  async insertExperience(row: Omit<ExperienceRow, "id">): Promise<{ changes: number; id: number }> {
    const r = await this.q1<{ id: string | number }>(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `, [row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at])
    return { changes: 1, id: num(r?.id) }
  }

  /**
   * v1 experiences search. Returns ORIGINAL content, never a tokenized blob.
   * B3 段2：主路径 BM25（idx_experiences_bm25，逐列 &&& 自 OR —— key 列 |||
   * 只查 key 本身，跨列没有快捷式）；tantivy 抛错（语法 token/空串）退回
   * ILIKE 两段式（AND→OR + 无 token 全文 LIKE，与段1 同构）。
   */
  async searchExperiences(query: string, limit: number = 10): Promise<Array<{ skill_name: string; content: string }>> {
    try {
      const rows = await this.q<{ skill_name: string; content: string }>(
        `SELECT skill_name, content FROM experiences
         WHERE skill_name &&& ? OR content &&& ?
         ORDER BY paradedb.score(id) DESC, created_at DESC LIMIT ?`,
        [query, query, limit],
      )
      if (rows.length > 0) return rows
    } catch {
      // tantivy 解析失败 → ILIKE 兜底
    }
    const tokens = queryTokens(query)
    const run = async (terms: string[], mode: 'and' | 'or'): Promise<Array<{ skill_name: string; content: string }>> => {
      const joiner = mode === 'and' ? ' AND ' : ' OR '
      const legs = terms.map(() => `(skill_name ILIKE ? OR content ILIKE ?)`)
      const params: unknown[] = terms.flatMap((t) => [likePattern(t), likePattern(t)])
      params.push(limit)
      return this.q<{ skill_name: string; content: string }>(
        `SELECT skill_name, content FROM experiences WHERE ${legs.join(joiner)} ORDER BY created_at DESC LIMIT ?`,
        params,
      )
    }
    if (tokens.length > 0) {
      const and = await run(tokens, 'and')
      if (and.length > 0 || tokens.length === 1) return and
      return run(tokens, 'or')
    }
    const escaped = query.replace(/[%_\\]/g, '\\$&')
    return this.q<{ skill_name: string; content: string }>(
      `SELECT skill_name, content FROM experiences WHERE content ILIKE ? LIMIT ?`,
      [`%${escaped}%`, limit],
    )
  }

  // ── Additional methods for evolution-service migration ─────────────

  async findEvolutionByIdAndOrgChecked(id: number, org: string): Promise<EvolutionLogRow | null> {
    return this.findEvolutionByIdAndOrg(id, org)
  }

  async findRecentExperiencesForReflection(org: string, limit: number = 20): Promise<ExperienceRow[]> {
    const rows = await this.q<ExperiencePgRow>(`
      SELECT * FROM experiences
      WHERE org = ? AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC
      LIMIT ?
    `, [org, limit])
    return rows.map(fromExperience)
  }

  /**
   * Find recent experiences filtered by scope, for scope-aware reflection.
   * Returns V2 rows so pattern_tags and outcome are available for analysis.
   */
  async findRecentExperiencesForReflectionByScope(
    org: string,
    scope: string,
    limit: number = 20,
  ): Promise<ExperienceRowV2[]> {
    const rows = await this.q<ExperiencePgRow>(`
      SELECT * FROM experiences
      WHERE org = ? AND scope = ? AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC
      LIMIT ?
    `, [org, scope, limit])
    return rows.map(fromExperience)
  }

  /**
   * Find experiences with failure patterns filtered by scope.
   */
  async findExperiencesWithFailurePatternByScope(
    org: string,
    scope: string,
  ): Promise<Array<{ count: number; skill_name: string; scope_ref: string | null }>> {
    return this.q<{ count: number; skill_name: string; scope_ref: string | null }>(`
      SELECT COUNT(*)::int AS count, skill_name, scope_ref
      FROM experiences
      WHERE org = ? AND scope = ? AND created_at > now() - interval '7 days'
      AND (content LIKE '%失败%' OR content LIKE '%error%' OR content LIKE '%failed%')
      GROUP BY skill_name, scope_ref HAVING COUNT(*) >= 3
    `, [org, scope])
  }

  /**
   * 与 insertExperience 同义（原双写 FTS 的入口名保留 —— 调用面不改名）。
   */
  async insertExperienceWithFts(row: Omit<ExperienceRow, "id">): Promise<{ changes: number; id: number }> {
    return this.insertExperience(row)
  }

  /** 经验行总数（recall-service 重建入口的「已索引条数」—— BM25 自动维护，计数即语义）。 */
  async countExperiences(): Promise<number> {
    const r = await this.q1<{ cnt: number | string }>("SELECT COUNT(*)::int AS cnt FROM experiences")
    return num(r?.cnt)
  }

  /**
   * recall 面检索（原 experiences_fts BM25 + org/scope 过滤 + rank 的替身）。
   * 与 searchByScope 同构但带 org 隔离，且返回归一 score（(0,1)，与会场面同尺）。
   * B3 段2：主路径 BM25（skill_name/content 面 &&&），score = paradedb.score
   * 的 s/(1+s) 归一（越大越相关方向）；抛错或零命中 → ILIKE 两段式分层常数分。
   * 空/纯标点查询 → 显式空数组（与段1 同）。
   */
  async searchExperiencesForRecall(
    query: string,
    org: string,
    scope: string | undefined,
    limit: number,
  ): Promise<Array<{ id: number; skill_name: string; content: string; scope: string | null; created_at: string; score: number }>> {
    const tokens = queryTokens(query)
    if (tokens.length === 0) return []
    try {
      let sql = `
        SELECT id, skill_name, content, scope, created_at, paradedb.score(id) AS score
        FROM experiences
        WHERE (skill_name &&& ? OR content &&& ?) AND org = ?`
      const params: unknown[] = [query, query, org]
      if (scope) { sql += ` AND scope = ?`; params.push(scope) }
      sql += ` ORDER BY paradedb.score(id) DESC, created_at DESC LIMIT ?`
      params.push(limit)
      const rows = await this.q<{
        id: string | number; skill_name: string; content: string;
        scope: string; created_at: Date | string; score: unknown
      }>(sql, params)
      if (rows.length > 0) {
        return rows.map((r) => ({
          id: num(r.id), skill_name: r.skill_name, content: r.content,
          scope: r.scope ?? null, created_at: iso(r.created_at), score: scoreNorm(r.score),
        }))
      }
    } catch {
      // tantivy 解析失败 → ILIKE 兜底
    }
    const run = async (mode: 'and' | 'or', score: number) => {
      const joiner = mode === 'and' ? ' AND ' : ' OR '
      const legs = tokens.map(() => `(skill_name ILIKE ? OR content ILIKE ?)`)
      const params: unknown[] = tokens.flatMap((t) => [likePattern(t), likePattern(t)])
      let sql = `SELECT id, skill_name, content, scope, created_at FROM experiences WHERE ${legs.join(joiner)} AND org = ?`
      params.push(org)
      if (scope) {
        sql += ` AND scope = ?`
        params.push(scope)
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`
      params.push(limit)
      const rows = await this.q<{ id: string | number; skill_name: string; content: string; scope: string; created_at: Date | string }>(sql, params)
      return rows.map((r) => ({
        id: num(r.id), skill_name: r.skill_name, content: r.content,
        scope: r.scope ?? null, created_at: iso(r.created_at), score,
      }))
    }
    const and = await run('and', 0.9)
    if (and.length > 0 || tokens.length === 1) return and
    return run('or', 0.4)
  }

  /**
   * Insert an experience with all V2 scope-aware fields.
   * （原「双写 experiences + experiences_fts」的 FTS 腿退役：PG 检索面是
   * experiences 真表上的 BM25 索引，写侧只有一份 —— 无 split-brain。）
   */
  async insertExperienceV2(row: Omit<ExperienceRowV2, "id">): Promise<{ changes: number; id: number }> {
    const r = await this.q1<{ id: string | number }>(`
      INSERT INTO experiences (skill_name, content, source_session_id, org, created_at,
        scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      row.skill_name, row.content, row.source_session_id ?? null, row.org, row.created_at,
      row.scope, row.scope_ref ?? null, jsonbParam(row.pattern_tags), row.outcome ?? null,
      row.source_type, row.execution_id ?? null, row.node_id ?? null,
    ])
    return { changes: 1, id: num(r?.id) }
  }

  // ── Experiences V2 (scope-aware) ────────────────────────────────

  /**
   * List experiences filtered by scope, with optional scope_ref and limit.
   */
  async listByScope(
    org: string,
    scope: string,
    opts?: { scopeRef?: string; limit?: number },
  ): Promise<ExperienceRowV2[]> {
    const limit = Math.min(opts?.limit ?? 50, 200)
    let sql = `SELECT * FROM experiences WHERE org = ? AND scope = ?`
    const params: unknown[] = [org, scope]
    if (opts?.scopeRef) {
      sql += ` AND scope_ref = ?`
      params.push(opts.scopeRef)
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)
    const rows = await this.q<ExperiencePgRow>(sql, params)
    return rows.map(fromExperience)
  }

  /**
   * Scope-aware search（原 experiences_fts MATCH 面的替身）。
   * B3 段2：主路径 BM25，逐列 &&& 自 OR 覆盖旧 MATCH 面
   * （skill_name/content/scope_ref/pattern_tags —— pattern_tags 为 jsonb，
   * bm25 已实测支持）；抛错或零命中 → ILIKE 两段式（token queryTokens，
   * AND→OR；无 token → ILIKE 全文兜底）。返回原文。
   */
  async searchByScope(
    query: string,
    scope?: string,
    limit: number = 10,
  ): Promise<Array<{ id: number; skill_name: string; content: string; scope: string; scope_ref: string | null; pattern_tags: string; outcome: string | null }>> {
    const safeLimit = Math.min(limit, 100)
    const pick = (r: ExperiencePgRow) => ({
      id: num(r.id), skill_name: r.skill_name, content: r.content, scope: r.scope,
      scope_ref: r.scope_ref, pattern_tags: jsonStr(r.pattern_tags) ?? '[]', outcome: r.outcome,
    })
    const tokens = queryTokens(query)

    try {
      let sql = `
        SELECT * FROM experiences
        WHERE (skill_name &&& ? OR content &&& ? OR scope_ref &&& ? OR pattern_tags &&& ?)`
      const params: unknown[] = [query, query, query, query]
      if (scope) {
        sql += ` AND scope = ?`
        params.push(scope)
      }
      sql += ` ORDER BY paradedb.score(id) DESC, created_at DESC LIMIT ?`
      params.push(safeLimit)
      const rows = await this.q<ExperiencePgRow>(sql, params)
      if (rows.length > 0) return rows.map(pick)
    } catch {
      // tantivy 解析失败 → ILIKE 兜底
    }

    const run = async (terms: string[], mode: 'and' | 'or'): Promise<Array<ExperiencePgRow>> => {
      const joiner = mode === 'and' ? ' AND ' : ' OR '
      const legs = terms.map(() => `(skill_name ILIKE ? OR content ILIKE ? OR COALESCE(scope_ref,'') ILIKE ? OR COALESCE(pattern_tags::text,'') ILIKE ?)`)
      const params: unknown[] = terms.flatMap((t) => [likePattern(t), likePattern(t), likePattern(t), likePattern(t)])
      let sql = `SELECT * FROM experiences WHERE ${legs.join(joiner)}`
      if (scope) {
        sql += ` AND scope = ?`
        params.push(scope)
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`
      params.push(safeLimit)
      return this.q<ExperiencePgRow>(sql, params)
    }

    if (tokens.length > 0) {
      const and = await run(tokens, 'and')
      if (and.length > 0 || tokens.length === 1) return and.map(pick)
      return (await run(tokens, 'or')).map(pick)
    }
    const escaped = query.replace(/[%_\\]/g, '\\$&')
    let sql = `
      SELECT * FROM experiences WHERE content ILIKE ?
    `
    const params: unknown[] = [`%${escaped}%`]
    if (scope) {
      sql += ` AND scope = ?`
      params.push(scope)
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(safeLimit)
    return (await this.q<ExperiencePgRow>(sql, params)).map(pick)
  }

  /**
   * Update the outcome field for an experience row.
   * Outcome is a JSON string: {label, success_rate, usage_count, last_applied}.
   */
  async updateOutcome(id: number, outcome: string): Promise<{ changes: number }> {
    return this.exec("UPDATE experiences SET outcome = ? WHERE id = ?", [outcome, id])
  }

  /**
   * List experiences for a given execution_id, optionally filtered by outcome label.
   * Used by HarnessController.onExecutionEnd() to batch-update pending outcomes.
   * （S5：json_extract → `outcome::jsonb ->> 'label'`）
   */
  async listByExecutionId(
    executionId: string,
    opts?: { outcomeLabel?: string },
  ): Promise<ExperienceRowV2[]> {
    let sql = `SELECT * FROM experiences WHERE execution_id = ?`
    const params: unknown[] = [executionId]
    if (opts?.outcomeLabel) {
      sql += ` AND outcome::jsonb ->> 'label' = ?`
      params.push(opts.outcomeLabel)
    }
    sql += ` ORDER BY created_at ASC`
    const rows = await this.q<ExperiencePgRow>(sql, params)
    return rows.map(fromExperience)
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
  async getSuccessStats(
    org: string,
    scope: string,
    scopeRef?: string,
  ): Promise<{
    decisionStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }>
    patternStats: Record<string, { success: number; failed: number; pending: number; total: number; rate: number }>
  }> {
    let sql = `SELECT pattern_tags, outcome FROM experiences WHERE org = ? AND scope = ?`
    const params: unknown[] = [org, scope]
    if (scopeRef) {
      sql += ` AND scope_ref = ?`
      params.push(scopeRef)
    }

    const rows = await this.q<{ pattern_tags: unknown; outcome: string | null }>(sql, params)

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

      // Parse pattern_tags as JSON array（PG jsonb 出口可能是对象或文本）
      let tags: string[] = []
      try {
        const parsed = JSON.parse(jsonStr(row.pattern_tags) || "[]")
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

  async insertMark(row: { skill_name: string; insight: string; session_id?: string; org: string }): Promise<{ changes: number; id: number }> {
    const now = new Date().toISOString()
    const r = await this.q1<{ id: string | number }>(`
      INSERT INTO insight_marks (skill_name, insight, session_id, org, marked_at, processed)
      VALUES (?, ?, ?, ?, ?, false)
      RETURNING id
    `, [row.skill_name, row.insight, row.session_id ?? null, row.org, now])
    return { changes: 1, id: num(r?.id) }
  }

  async listUnprocessedMarks(org: string, limit: number = 50): Promise<InsightMarkRow[]> {
    const rows = await this.q<InsightMarkPgRow>(`
      SELECT * FROM insight_marks
      WHERE org = ? AND processed = false
      ORDER BY marked_at ASC
      LIMIT ?
    `, [org, limit])
    return rows.map(fromMark)
  }

  async markProcessed(id: number): Promise<{ changes: number }> {
    return this.exec("UPDATE insight_marks SET processed = true WHERE id = ?", [id])
  }

  async listAllMarks(org: string, filters?: { processed?: number; limit?: number }): Promise<InsightMarkRow[]> {
    const limit = Math.min(filters?.limit ?? 50, 200)
    let sql = `SELECT * FROM insight_marks WHERE org = ?`
    const params: unknown[] = [org]
    if (filters?.processed !== undefined) {
      sql += ` AND processed = ?`
      params.push(bool(filters.processed))
    }
    sql += ` ORDER BY marked_at DESC LIMIT ?`
    params.push(limit)
    const rows = await this.q<InsightMarkPgRow>(sql, params)
    return rows.map(fromMark)
  }
}
