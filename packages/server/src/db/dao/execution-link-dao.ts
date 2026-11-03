import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/**
 * 执行 → 归属会话/任务的持久关联（2026-11-03 消耗口径）。
 *
 * 任务轮的身份是 executions.task_id（ADR-0021）。两类执行拿不到它：
 *   · task_aux —— 任务里的系统辅助执行（当前唯一成员：验收规划）。挂 task_id
 *     会撞 ux_exec_task_active 的单实例闸，也会混进看板 / run_stats 的「轮」口径，
 *     所以插行时刻意留 NULL，改用本表登记；
 *   · chat_run —— 主对话里 run_workflow 直接拉起的工作流。它不属于任何任务，
 *     只认发起它的会话。
 *
 * 任务账本 / 会话账本按本表归集；表的主键是 execution_id，重复登记只更新归属。
 */
export type ExecutionLinkKind = "task_aux" | "chat_run"

/** 创建执行时一并登记的归属（ExecutionService.create 的 origin 字段）。
 *  约定：凡是为某个对话/任务代跑、但又没有 task_id 的执行，都在创建时带上它。 */
export interface ExecutionOriginInput {
  sessionId?: string | null
  taskId?: string | null
  kind: ExecutionLinkKind
  phaseIndex?: number | null
  roundIndex?: number | null
}

export interface ExecutionLinkRow {
  execution_id: string
  session_id: string | null
  task_id: string | null
  kind: ExecutionLinkKind
  phase_index: number | null
  round_index: number | null
  created_at: string
}

/** 关联执行 + executions 行上的展示字段（消费侧一次取全，免二次查询）。 */
export interface LinkedExecutionRow {
  id: string
  name: string | null
  workflow_ref: string
  status: string
  started_at: string | null
  completed_at: string | null
  /** 执行所在工作区 —— 消费窗点行打开运行窗时需要。 */
  workspace_id: string
  task_id: string | null
  kind: ExecutionLinkKind
  phase_index: number | null
  round_index: number | null
}

/** 任务账本的一行：任务自己的轮（task_id 命中）或登记到该任务的辅助执行。 */
export interface TaskUsageExecutionRow {
  id: string
  phase_index: number | null
  round_index: number | null
  workflow_ref: string | null
  status: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  parent_id: string
  /** 行上自带的 task_id（轮）为 NULL 时，说明它来自 execution_links（辅助执行）。 */
  task_id: string | null
  link_kind: ExecutionLinkKind | null
}

export class ExecutionLinkDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  link(input: {
    executionId: string
    sessionId?: string | null
    taskId?: string | null
    kind: ExecutionLinkKind
    phaseIndex?: number | null
    roundIndex?: number | null
    createdAt?: string
  }): void {
    this.stmt(`
      INSERT INTO execution_links (execution_id, session_id, task_id, kind, phase_index, round_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        kind = excluded.kind,
        phase_index = excluded.phase_index,
        round_index = excluded.round_index
    `).run(
      input.executionId,
      input.sessionId ?? null,
      input.taskId ?? null,
      input.kind,
      input.phaseIndex ?? null,
      input.roundIndex ?? null,
      input.createdAt ?? new Date().toISOString(),
    )
  }

  findByExecution(executionId: string): ExecutionLinkRow | undefined {
    return this.stmt("SELECT * FROM execution_links WHERE execution_id = ?")
      .get(executionId) as ExecutionLinkRow | undefined
  }

  findBySession(sessionId: string): ExecutionLinkRow[] {
    return this.stmt("SELECT * FROM execution_links WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as ExecutionLinkRow[]
  }

  findByTask(taskId: string): ExecutionLinkRow[] {
    return this.stmt("SELECT * FROM execution_links WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as ExecutionLinkRow[]
  }

  /** 批量取关联行（运行列表补坐标用；分片避开 SQLite 变量上限）。 */
  findByExecutionIds(executionIds: readonly string[]): Map<string, ExecutionLinkRow> {
    const out = new Map<string, ExecutionLinkRow>()
    const uniq = [...new Set(executionIds)].filter((v) => typeof v === "string" && v.length > 0)
    const CHUNK = 400
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK)
      const marks = slice.map(() => "?").join(",")
      const rows = this.db.prepare(
        `SELECT * FROM execution_links WHERE execution_id IN (${marks})`,
      ).all(...slice) as ExecutionLinkRow[]
      for (const r of rows) out.set(r.execution_id, r)
    }
    return out
  }

  /** 逐任务拿辅助执行 id（任务列表 / 详情 ai_usage 用）。 */
  executionIdsByTask(taskIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const uniq = [...new Set(taskIds)].filter((v) => typeof v === "string" && v.length > 0)
    const CHUNK = 400
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK)
      const marks = slice.map(() => "?").join(",")
      const rows = this.db.prepare(
        `SELECT task_id, execution_id FROM execution_links
          WHERE task_id IN (${marks}) ORDER BY created_at ASC`,
      ).all(...slice) as Array<{ task_id: string; execution_id: string }>
      for (const r of rows) {
        const list = out.get(r.task_id)
        if (list) list.push(r.execution_id)
        else out.set(r.task_id, [r.execution_id])
      }
    }
    return out
  }

  /** 任务账本用的执行行：任务自己的轮 ∪ 登记到该任务的辅助执行。 */
  listTaskUsageExecutions(taskId: string): TaskUsageExecutionRow[] {
    return this.stmt(`
      SELECT e.id, e.phase_index, e.round_index, e.workflow_ref, e.status,
             e.created_at, e.started_at, e.completed_at, e.parent_id, e.task_id,
             l.kind AS link_kind
        FROM executions e
        LEFT JOIN execution_links l ON l.execution_id = e.id
       WHERE e.task_id = ? OR l.task_id = ?
       ORDER BY e.created_at ASC
    `).all(taskId, taskId) as TaskUsageExecutionRow[]
  }

  /** 会话账本用的关联执行（含 session_id 命中的全部 kind）。 */
  listLinkedExecutionsBySession(sessionId: string): LinkedExecutionRow[] {
    return this.stmt(`
      SELECT e.id, e.name, e.workflow_ref, e.status, e.started_at, e.completed_at, e.workspace_id,
             l.task_id, l.kind, l.phase_index, l.round_index
        FROM execution_links l
        JOIN executions e ON e.id = l.execution_id
       WHERE l.session_id = ?
       ORDER BY e.created_at ASC
    `).all(sessionId) as LinkedExecutionRow[]
  }

  /**
   * 存量回填（2026-11-03 之前的历史行）：验收规划执行的坐标一直在
   * input_values / var_pool 里（pipeline_config 会在 start 时被整体覆盖，
   * 不可依赖）。按 input_values.$.task_id 反查任务及其主对话，INSERT OR IGNORE，
   * 幂等；只在服务启动时跑一次。
   */
  backfillAcceptancePlanLinks(): number {
    return this.stmt(`
      INSERT OR IGNORE INTO execution_links
        (execution_id, session_id, task_id, kind, phase_index, round_index, created_at)
      SELECT e.id, t.source_chat_session_id, t.id, 'task_aux',
             CAST(CASE WHEN json_valid(e.input_values)
                       THEN json_extract(e.input_values, '$.phase_index') END AS INTEGER),
             CAST(CASE WHEN json_valid(e.input_values)
                       THEN json_extract(e.input_values, '$.round_index') END AS INTEGER),
             e.created_at
        FROM executions e
        JOIN tasks t ON t.id = CASE WHEN json_valid(e.input_values)
                                   THEN json_extract(e.input_values, '$.task_id') END
       WHERE e.triggered_by = 'acceptance-plan'
    `).run().changes
  }
}
