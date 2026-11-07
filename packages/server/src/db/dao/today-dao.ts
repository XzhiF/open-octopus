import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/**
 * TodayDAO — 「今日」页的只读聚合查询（一次请求 = 当天全部数据）。
 *
 * 这一页的定位是「今天整体工作状态」，不是报表：只读当天窗口，不写任何表。
 * 时间戳一律 ISO 字符串（UTC, `Z`），窗口下界由调用方按本地零点算好传进来。
 *
 * 口径纪律：
 * - 任务「流转」= 当天 created/updated/completed 任一落在窗口内的未删除任务；
 *   状态取当前 status（历史跃迁不入库，见 schema 注）；
 * - 验收 = task_phase_acceptances 的 append-only 决策行；
 * - 会话 = created_at 或 last_message_at 落在窗口内的未删除会话。
 */

export interface TodayTaskRow {
  id: string
  name: string
  status: string
  created_at: string
  updated_at: string
  completed_at: string | null
  workspace_id: string | null
  source_chat_session_id: string | null
}

export interface TodayAcceptanceRow {
  task_id: string
  task_name: string | null
  phase_index: number
  round_index: number
  decision: string
  feedback: string | null
  decided_at: string
}

export interface TodayExecutionRow {
  id: string
  task_id: string | null
  workflow_name: string
  phase_index: number | null
  round_index: number | null
  status: string
  started_at: string | null
  completed_at: string | null
}

export interface TodaySessionRow {
  id: string
  title: string
  clone_name: string | null
  session_type: string
  created_at: string
  last_message_at: string | null
}

export interface TodayVersionRow {
  agent_name: string
  version: string
  changelog: string | null
  published_at: string
}

export interface TodaySkillChangeRow {
  skill_name: string
  change_type: string
  level: string
  summary: string
  timestamp: string
}

export interface TodayWikiRow {
  id: string
  domain: string
  title: string
  path: string
  last_compiled: string
  updated_at: string
}

export class TodayDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  /** 当天有流转的未删除任务（created / updated / completed 任一命中）。 */
  listTasksTouched(sinceIso: string): TodayTaskRow[] {
    return this.stmt(`
      SELECT id, name, status, created_at, updated_at, completed_at,
             workspace_id, source_chat_session_id
      FROM tasks
      WHERE deleted_at IS NULL
        AND (created_at >= ? OR updated_at >= ? OR completed_at >= ?)
      ORDER BY updated_at ASC, id ASC
    `).all(sinceIso, sinceIso, sinceIso) as TodayTaskRow[]
  }

  /** 当天的人工验收决策（append-only ledger）。 */
  listAcceptancesSince(sinceIso: string): TodayAcceptanceRow[] {
    return this.stmt(`
      SELECT a.task_id, t.name AS task_name, a.phase_index, a.round_index,
             a.decision, a.feedback, a.decided_at
      FROM task_phase_acceptances a
      LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.decided_at >= ?
      ORDER BY a.decided_at ASC
    `).all(sinceIso) as TodayAcceptanceRow[]
  }

  /** 当天启动（或已挂上任务）的执行轮。 */
  listExecutionsStartedSince(sinceIso: string): TodayExecutionRow[] {
    return this.stmt(`
      SELECT id, task_id, workflow_name, phase_index, round_index, status,
             started_at, completed_at
      FROM executions
      WHERE started_at >= ?
      ORDER BY started_at ASC
    `).all(sinceIso) as TodayExecutionRow[]
  }

  /** 当天有活动的未删除会话（新建或最后一条消息落在窗口内）。 */
  listSessionsTouched(sinceIso: string): TodaySessionRow[] {
    return this.stmt(`
      SELECT id, title, clone_name, session_type, created_at, last_message_at
      FROM sessions
      WHERE is_deleted = 0
        AND (created_at >= ? OR last_message_at >= ?)
      ORDER BY COALESCE(last_message_at, created_at) ASC
    `).all(sinceIso, sinceIso) as TodaySessionRow[]
  }

  /** 给定会话里有几个已经转成任务（任务行仍存活）。 */
  countTasksFromSessions(sessionIds: readonly string[]): number {
    if (sessionIds.length === 0) return 0
    const marks = sessionIds.map(() => "?").join(", ")
    const row = this.stmt(`
      SELECT COUNT(DISTINCT source_chat_session_id) AS n
      FROM tasks
      WHERE deleted_at IS NULL AND source_chat_session_id IN (${marks})
    `).get(...sessionIds) as { n: number }
    return row.n
  }

  /** 当天发布的分身版本。 */
  listVersionsSince(sinceIso: string): TodayVersionRow[] {
    return this.stmt(`
      SELECT agent_name, version, changelog, published_at
      FROM agent_versions
      WHERE status = 'published' AND published_at >= ?
      ORDER BY published_at ASC
    `).all(sinceIso) as TodayVersionRow[]
  }

  /** 当天的技能演化记录。 */
  listSkillChangesSince(sinceIso: string): TodaySkillChangeRow[] {
    return this.stmt(`
      SELECT skill_name, change_type, level, summary, timestamp
      FROM evolution_log
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `).all(sinceIso) as TodaySkillChangeRow[]
  }

  /**
   * 当天被编译/更新过的 wiki 页（DB 索引口径）。
   * 页面的「新增/更新」拆分走 wiki git 仓库（一次编译 = 一次 commit）；
   * 本查询是 git 不可用时的降级面，也是页面标题清单的来源。
   */
  listWikiPagesTouchedSince(sinceIso: string): TodayWikiRow[] {
    return this.stmt(`
      SELECT id, domain, title, path, last_compiled, updated_at
      FROM wiki_articles
      WHERE last_compiled >= ? OR updated_at >= ?
      ORDER BY updated_at ASC
    `).all(sinceIso, sinceIso) as TodayWikiRow[]
  }

  /** 最近的 LLM 调用模型序列（按会话），用于「模型切换」这一条 Agent 变动。 */
  listRecentModelCalls(sinceMs: number): Array<{ session_id: string; timestamp: number; model: string | null }> {
    return this.stmt(`
      SELECT session_id, timestamp, model
      FROM llm_calls
      WHERE timestamp >= ? AND session_id IS NOT NULL AND model IS NOT NULL
      ORDER BY timestamp ASC
    `).all(sinceMs) as Array<{ session_id: string; timestamp: number; model: string | null }>
  }
}