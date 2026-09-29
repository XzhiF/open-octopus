// packages/server/src/db/dao/harness-dao.ts
//
// HarnessDAO — CRUD operations for harness_events and harness_config tables.
// Used by the Harness API routes and HarnessController.
//
// P1 B1: postgres.js / BasePgDAO。注意 Harness 域对 executions / node_executions /
// agent_events 的直写不在本 DAO（属 B5 域表，暂留 SQLite，见 detector-pipeline.ts）。

import type { HarnessEvent } from "@octopus/shared"
import { BasePgDAO } from "./base-pg"
import { iso, jsonStr, num } from "./pg-mappers"

/**
 * Row shape for harness_config table.
 */
export interface HarnessConfigRow {
  id: string
  config_yaml: string
  updated_at: string
  version: number
}

/** harness_events 的 PG 原始行：*_json 为 jsonb（解析后对象）、timestamp 为 int8（string）、created_at 为 timestamptz（Date）。 */
interface HarnessEventPgRow {
  id: string
  execution_id: string
  node_id: string | null
  timestamp: string | number
  event_type: HarnessEvent["event_type"]
  detector: string | null
  severity: string | null
  report_json: unknown
  action_json: unknown
  result_json: unknown
  token_usage_json: unknown
  created_at: Date | string | null
}

function fromEvent(r: HarnessEventPgRow): HarnessEvent {
  return {
    id: r.id,
    execution_id: r.execution_id,
    node_id: r.node_id,
    timestamp: num(r.timestamp),
    event_type: r.event_type,
    detector: r.detector,
    severity: r.severity,
    report_json: jsonStr(r.report_json),
    action_json: jsonStr(r.action_json),
    result_json: jsonStr(r.result_json),
    token_usage_json: jsonStr(r.token_usage_json),
    // 旧 SQLite 行把 datetime('now') 文本塞进 created_at；共享契约 HarnessEvent.created_at 是
    // epoch 秒 number（实际消费者只按 timestamp 排序）。PG 统一出口：Date → epoch 秒。
    created_at: r.created_at instanceof Date
      ? Math.floor(r.created_at.getTime() / 1000)
      : r.created_at ? Math.floor(new Date(r.created_at).getTime() / 1000) : 0,
  }
}

interface HarnessConfigPgRow {
  id: string
  config_yaml: string
  updated_at: Date | string
  version: number
}

function fromConfig(r: HarnessConfigPgRow): HarnessConfigRow {
  return { id: r.id, config_yaml: r.config_yaml, updated_at: iso(r.updated_at), version: r.version }
}

/**
 * HarnessDAO — harness event persistence and config storage.
 */
export class HarnessDAO extends BasePgDAO {
  // ── harness_events ──────────────────────────────────────────────

  /**
   * Insert a harness event row.
   * S4: created_at 的 datetime('now') → now()（列本身也有 DEFAULT now()，保留显式与旧行为对齐）。
   */
  async insertEvent(row: HarnessEvent): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO harness_events
        (id, execution_id, node_id, timestamp, event_type, detector, severity,
         report_json, action_json, result_json, token_usage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
    `, [
      row.id,
      row.execution_id,
      row.node_id,
      row.timestamp,
      row.event_type,
      row.detector,
      row.severity,
      row.report_json,
      row.action_json,
      row.result_json,
      row.token_usage_json,
    ])
  }

  /**
   * Query harness events for a given execution, with optional filters.
   * Ordered by timestamp ASC.
   */
  async findEvents(
    executionId: string,
    opts?: { type?: string; severity?: string },
  ): Promise<HarnessEvent[]> {
    const conditions: string[] = ["execution_id = ?"]
    const params: unknown[] = [executionId]

    if (opts?.type) {
      conditions.push("event_type = ?")
      params.push(opts.type)
    }
    if (opts?.severity) {
      conditions.push("severity = ?")
      params.push(opts.severity)
    }

    const where = conditions.join(" AND ")
    const rows = await this.q<HarnessEventPgRow>(
      `SELECT * FROM harness_events WHERE ${where} ORDER BY timestamp ASC`,
      params,
    )
    return rows.map(fromEvent)
  }

  /**
   * Count events for a given execution.
   */
  async countEvents(executionId: string): Promise<number> {
    const row = await this.q1<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM harness_events WHERE execution_id = ?",
      [executionId],
    )
    return num(row?.count)
  }

  // ── harness_config ──────────────────────────────────────────────

  /**
   * Get the current harness config (singleton row, id='default').
   * Returns null if no config has been saved yet.
   */
  async getConfig(id: string = "default"): Promise<HarnessConfigRow | null> {
    const row = await this.q1<HarnessConfigPgRow>(
      "SELECT * FROM harness_config WHERE id = ?",
      [id],
    )
    return row ? fromConfig(row) : null
  }

  /**
   * Insert or update the harness config (upsert).
   * Bumps version on update.
   * S13: ON CONFLICT DO UPDATE 是 PG 原生语法，零改写；S4: 时间参数用 ISO 串（timestamptz 上下文解析）。
   */
  async saveConfig(configYaml: string, id: string = "default"): Promise<HarnessConfigRow> {
    const existing = await this.getConfig(id)
    const newVersion = existing ? existing.version + 1 : 1
    const now = new Date().toISOString()

    await this.exec(`
      INSERT INTO harness_config (id, config_yaml, updated_at, version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config_yaml = excluded.config_yaml,
        updated_at = excluded.updated_at,
        version = excluded.version
    `, [id, configYaml, now, newVersion])

    return { id, config_yaml: configYaml, updated_at: now, version: newVersion }
  }

  // ── Token tracking for harness agent delegations ─────────────────

  // insertHarnessTokenUsage 已删除（C3）：node_token_usages 唯一写入口 = TokenUsageDAO.recordNodeUsage(source='harness')
}
