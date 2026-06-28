import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// Cross-format __dirname: works in both CJS (tsup provides it) and ESM
declare const __dirname: string
const _dirname: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url))

export const SCHEMA_VERSION = 27

/**
 * Apply the complete unified schema to the given database.
 * Reads schema.sql from the same directory (works in both dev and bundled output).
 * Idempotent — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  // Read current schema version
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) || 0

  // Run migrations for existing databases
  // NOTE: Use literal 27 instead of SCHEMA_VERSION due to tsup __esm lazy init ordering
  if (currentVersion > 0 && currentVersion < 27) {
    // v24: Add archived column to workspaces (soft delete)
    if (currentVersion < 24) {
      try {
        db.exec('ALTER TABLE workspaces ADD COLUMN archived INTEGER DEFAULT 0')
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
    }

    // v25: Add archive status columns to workspaces
    if (currentVersion < 25) {
      try {
        db.exec("ALTER TABLE workspaces ADD COLUMN archive_status TEXT DEFAULT 'none'")
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
      try {
        db.exec('ALTER TABLE workspaces ADD COLUMN archive_started_at TEXT')
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
      try {
        db.exec('ALTER TABLE workspaces ADD COLUMN archive_error TEXT')
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
    }

    // v27: Add org column to tables that may lack it
    // (DBs created at v24-v26 may have these tables without org)
    if (currentVersion < 27) {
      const tablesNeedingOrg = [
        'node_executions', 'node_edges', 'branch_executions', 'chat_sessions',
        'chat_messages', 'node_token_usages', 'agent_events', 'optimization_suggestions',
        'execution_summaries', 'pipeline_state', 'schedule_executions', 'schedule_audit_logs',
        'scheduler_state', 'scheduler_audit_logs', 'schedule_workspaces', 'messages',
      ]
      const existingTables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
      )
      for (const table of tablesNeedingOrg) {
        if (!existingTables.has(table)) continue
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN org TEXT NOT NULL DEFAULT ''`)
        } catch (e: any) {
          if (!e.message?.includes('duplicate column')) throw e
        }
      }
    }
  }

  // Apply full schema (idempotent via IF NOT EXISTS)
  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
