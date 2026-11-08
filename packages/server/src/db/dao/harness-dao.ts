// packages/server/src/db/dao/harness-dao.ts
//
// HarnessDAO — CRUD for the harness_events audit log.
// Detector signals are still recorded here; the incident lifecycle lives in
// `services/supervision/incident-store.ts`. The harness_config table and its
// accessors were retired with the global Harness YAML (2026-11-07).

import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { HarnessEvent } from "@octopus/shared"

/**
 * HarnessDAO — harness event persistence.
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
}
