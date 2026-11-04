import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/** One row per subagent the main Agent spawned (SDK Task/Agent tool). */
export interface SubagentRunRow {
  id: string
  session_id: string
  parent_tool_use_id: string | null
  agent_type: string | null
  description: string | null
  prompt: string | null
  status: string
  started_at: string
  ended_at: string | null
  summary: string | null
  model: string | null
  cwd: string | null
  sdk_session_id: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  tool_uses: number
  duration_ms: number | null
  step_count: number
  steps: string | null
  created_at: string
  updated_at: string
}

/** List shape — `steps` may be large, so list queries drop it. */
export type SubagentRunSummaryRow = Omit<SubagentRunRow, "steps">

export interface SubagentRunUpsert {
  id: string
  session_id: string
  started_at: string
  parent_tool_use_id?: string | null
  agent_type?: string | null
  description?: string | null
  prompt?: string | null
  status?: string
  ended_at?: string | null
  summary?: string | null
  model?: string | null
  cwd?: string | null
  sdk_session_id?: string | null
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  tool_uses?: number
  duration_ms?: number | null
  step_count?: number
  steps?: string | null
}

/**
 * Subagent runs (作业坞「子代理」).
 *
 * Live data comes from the provider's `subagent` chunk; the row survives the
 * turn so a reopened chat can still replay what each subagent did. Token totals
 * are backfilled from the SDK transcript (`subagents/agent-<id>.jsonl`).
 */
export class SubagentRunDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  /** Insert-or-merge. Null/undefined patch fields keep the stored value. */
  upsert(patch: SubagentRunUpsert): void {
    const now = new Date().toISOString()
    const existing = this.findById(patch.id)
    const merged = {
      id: patch.id,
      session_id: existing?.session_id ?? patch.session_id,
      parent_tool_use_id: patch.parent_tool_use_id ?? existing?.parent_tool_use_id ?? null,
      agent_type: patch.agent_type ?? existing?.agent_type ?? null,
      description: patch.description ?? existing?.description ?? null,
      prompt: patch.prompt ?? existing?.prompt ?? null,
      status: patch.status ?? existing?.status ?? "running",
      started_at: existing?.started_at ?? patch.started_at,
      ended_at: patch.ended_at ?? existing?.ended_at ?? null,
      summary: patch.summary ?? existing?.summary ?? null,
      model: patch.model ?? existing?.model ?? null,
      cwd: patch.cwd ?? existing?.cwd ?? null,
      sdk_session_id: patch.sdk_session_id ?? existing?.sdk_session_id ?? null,
      input_tokens: patch.input_tokens ?? existing?.input_tokens ?? 0,
      output_tokens: patch.output_tokens ?? existing?.output_tokens ?? 0,
      cache_read_tokens: patch.cache_read_tokens ?? existing?.cache_read_tokens ?? 0,
      cache_creation_tokens: patch.cache_creation_tokens ?? existing?.cache_creation_tokens ?? 0,
      tool_uses: patch.tool_uses ?? existing?.tool_uses ?? 0,
      duration_ms: patch.duration_ms ?? existing?.duration_ms ?? null,
      step_count: patch.step_count ?? existing?.step_count ?? 0,
      steps: patch.steps ?? existing?.steps ?? null,
    }
    this.stmt(`
      INSERT INTO subagent_runs (
        id, session_id, parent_tool_use_id, agent_type, description, prompt,
        status, started_at, ended_at, summary, model, cwd, sdk_session_id,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        tool_uses, duration_ms, step_count, steps, created_at, updated_at
      ) VALUES (
        @id, @session_id, @parent_tool_use_id, @agent_type, @description, @prompt,
        @status, @started_at, @ended_at, @summary, @model, @cwd, @sdk_session_id,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @tool_uses, @duration_ms, @step_count, @steps, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        parent_tool_use_id = excluded.parent_tool_use_id,
        agent_type = excluded.agent_type,
        description = excluded.description,
        prompt = excluded.prompt,
        status = excluded.status,
        ended_at = excluded.ended_at,
        summary = excluded.summary,
        model = excluded.model,
        cwd = excluded.cwd,
        sdk_session_id = excluded.sdk_session_id,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        tool_uses = excluded.tool_uses,
        duration_ms = excluded.duration_ms,
        step_count = excluded.step_count,
        steps = excluded.steps,
        updated_at = excluded.updated_at
    `).run({
      ...merged,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    })
  }

  listBySession(sessionId: string, limit = 60): SubagentRunSummaryRow[] {
    return this.stmt(`
      SELECT id, session_id, parent_tool_use_id, agent_type, description, prompt,
             status, started_at, ended_at, summary, model, cwd, sdk_session_id,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             tool_uses, duration_ms, step_count, created_at, updated_at
      FROM subagent_runs
      WHERE session_id = ?
      ORDER BY datetime(started_at) DESC
      LIMIT ?
    `).all(sessionId, limit) as SubagentRunSummaryRow[]
  }

  findById(id: string): SubagentRunRow | null {
    return (this.stmt(`SELECT * FROM subagent_runs WHERE id = ?`).get(id) as SubagentRunRow | undefined) ?? null
  }
}
