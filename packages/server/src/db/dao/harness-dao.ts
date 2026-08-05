// packages/server/src/db/dao/harness-dao.ts
//
// HarnessDAO — CRUD operations for harness_events and harness_config tables.
// Used by the Harness API routes and HarnessController.

import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { HarnessEvent } from "@octopus/shared"

/**
 * Row shape for harness_config table.
 */
export interface HarnessConfigRow {
  id: string
  config_yaml: string
  updated_at: string
  version: number
}

/**
 * HarnessDAO — harness event persistence and config storage.
 */
export class HarnessDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── harness_events ──────────────────────────────────────────────

  /**
   * Insert a harness event row.
   */
  insertEvent(row: HarnessEvent): Database.RunResult {
    return this.stmt(`
      INSERT INTO harness_events
        (id, execution_id, node_id, timestamp, event_type, detector, severity,
         report_json, action_json, result_json, token_usage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
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
    )
  }

  /**
   * Query harness events for a given execution, with optional filters.
   * Ordered by timestamp ASC.
   */
  findEvents(
    executionId: string,
    opts?: { type?: string; severity?: string },
  ): HarnessEvent[] {
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
    return this.stmt(
      `SELECT * FROM harness_events WHERE ${where} ORDER BY timestamp ASC`,
    ).all(...params) as HarnessEvent[]
  }

  /**
   * Count events for a given execution.
   */
  countEvents(executionId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM harness_events WHERE execution_id = ?",
    ).get(executionId) as { count: number }).count
  }

  // ── harness_config ──────────────────────────────────────────────

  /**
   * Get the current harness config (singleton row, id='default').
   * Returns null if no config has been saved yet.
   */
  getConfig(id: string = "default"): HarnessConfigRow | null {
    return (this.stmt(
      "SELECT * FROM harness_config WHERE id = ?",
    ).get(id) as HarnessConfigRow) ?? null
  }

  /**
   * Insert or update the harness config (upsert).
   * Bumps version on update.
   */
  saveConfig(configYaml: string, id: string = "default"): HarnessConfigRow {
    const existing = this.getConfig(id)
    const newVersion = existing ? existing.version + 1 : 1
    const now = new Date().toISOString()

    this.stmt(`
      INSERT INTO harness_config (id, config_yaml, updated_at, version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config_yaml = excluded.config_yaml,
        updated_at = excluded.updated_at,
        version = excluded.version
    `).run(id, configYaml, now, newVersion)

    return { id, config_yaml: configYaml, updated_at: now, version: newVersion }
  }
}
