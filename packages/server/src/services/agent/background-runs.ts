// 后台作业记录服务（2026-11-24 用户 #1 · 活动日志）。
//
// 与 SubagentRunService 同一套路，但数据源是 SDK 的后台作业：
//   · 实时：`background_tasks_changed` 电平（REPLACE）→ 本服务把 payload 里的
//     任务 upsert 成 running，把已经不在电平里的 running 行收口为 stopped；
//   · 结束：`task_notification` 边沿（provider 的 `background_task_ended` chunk）
//     → 落最终状态 / 摘要 / output_file；
//   · 输出尾不落库：SDK `get_task_output` 控制请求实时读（≤8 KiB），宿主只在
//     详情窗打开时按需拉取。
//
// 服务重启后，旧进程留下的 running 行不再有任何 query 消费者 —— 首次使用本
// 服务时统一收口，避免右栏永远显示「运行中」。

import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { BackgroundTaskEnded, BackgroundTaskInfo } from '@octopus/providers'

export type BackgroundRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface BackgroundRunRow {
  id: string
  session_id: string
  task_id: string
  run_id: string | null
  description: string
  task_type: string | null
  status: BackgroundRunStatus
  summary: string | null
  output_file: string | null
  started_at: string
  ended_at: string | null
  created_at: string
  updated_at: string
}

export class BackgroundRunService {
  private db: Database.Database
  private bootSwept = false

  constructor(db: Database.Database) {
    this.db = db
  }

  /** 进程重启会把「上一个进程里在跑」的行标成 stopped（只跑一次）。 */
  private ensureBootSweep(): void {
    if (this.bootSwept) return
    this.bootSwept = true
    const now = new Date().toISOString()
    try {
      this.db.prepare(`
        UPDATE background_runs
           SET status = 'stopped', ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE status = 'running'
      `).run(now, now)
    } catch { /* 老库还没这张表 —— 首次读写会由 schema 补齐 */ }
  }

  /**
   * 电平同步：payload 内任务 → running；本会话不在 payload 的 running 行 →
   * stopped（任务结束但通知丢失 / 回合收尾 / 会话切走）。
   */
  syncLevel(sessionId: string, tasks: readonly BackgroundTaskInfo[]): void {
    this.ensureBootSweep()
    const now = new Date().toISOString()
    const liveIds = new Set(tasks.map((task) => task.id))
    const upsert = this.db.prepare(`
      INSERT INTO background_runs
        (id, session_id, task_id, run_id, description, task_type, status,
         started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      ON CONFLICT(session_id, task_id) DO UPDATE SET
        description = excluded.description,
        task_type   = excluded.task_type,
        run_id      = excluded.run_id,
        started_at  = CASE
          WHEN background_runs.status = 'running'
           AND COALESCE(background_runs.run_id, '') = COALESCE(excluded.run_id, '')
          THEN background_runs.started_at
          ELSE excluded.started_at END,
        status      = 'running',
        ended_at    = NULL,
        summary     = NULL,
        updated_at  = excluded.updated_at
    `)
    const close = this.db.prepare(`
      UPDATE background_runs
         SET status = 'stopped', ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE session_id = ? AND task_id = ? AND status = 'running'
    `)
    const runningRows = this.db.prepare(
      "SELECT task_id FROM background_runs WHERE session_id = ? AND status = 'running'",
    )
    const tx = this.db.transaction(() => {
      for (const task of tasks) {
        upsert.run(
          crypto.randomUUID(),
          sessionId,
          task.id,
          task.runId ?? null,
          task.description,
          task.taskType ?? null,
          now,
          now,
          now,
        )
      }
      const running = runningRows.all(sessionId) as Array<{ task_id: string }>
      for (const row of running) {
        if (!liveIds.has(row.task_id)) close.run(now, now, sessionId, row.task_id)
      }
    })
    tx()
  }

  /** 结束边沿：`task_notification`（行不存在时补一条收口行）。 */
  markEnded(sessionId: string, task: BackgroundTaskEnded): void {
    this.ensureBootSweep()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO background_runs
        (id, session_id, task_id, run_id, description, task_type, status,
         summary, output_file, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, task_id) DO UPDATE SET
        status      = excluded.status,
        run_id      = COALESCE(excluded.run_id, background_runs.run_id),
        summary     = COALESCE(excluded.summary, background_runs.summary),
        output_file = COALESCE(excluded.output_file, background_runs.output_file),
        ended_at    = excluded.ended_at,
        updated_at  = excluded.updated_at
    `).run(
      crypto.randomUUID(),
      sessionId,
      task.id,
      task.runId ?? null,
      task.summary?.trim() || task.id,
      task.status,
      task.summary ?? null,
      task.outputFile ?? null,
      now,
      now,
      now,
      now,
    )
  }

  /** 回合收尾 / 流注销：本会话所有 running 行收口。 */
  closeRunning(sessionId: string, status: Exclude<BackgroundRunStatus, 'running'> = 'stopped'): void {
    this.ensureBootSweep()
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE background_runs
         SET status = ?, ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE session_id = ? AND status = 'running'
    `).run(status, now, now, sessionId)
  }

  list(sessionId: string, limit = 40): BackgroundRunRow[] {
    this.ensureBootSweep()
    return this.db.prepare(`
      SELECT * FROM background_runs
       WHERE session_id = ?
       ORDER BY started_at DESC
       LIMIT ?
    `).all(sessionId, limit) as BackgroundRunRow[]
  }

  find(sessionId: string, taskId: string): BackgroundRunRow | null {
    this.ensureBootSweep()
    const row = this.db.prepare(
      'SELECT * FROM background_runs WHERE session_id = ? AND task_id = ?',
    ).get(sessionId, taskId) as BackgroundRunRow | undefined
    return row ?? null
  }
}
