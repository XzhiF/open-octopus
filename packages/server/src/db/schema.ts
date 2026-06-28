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

export const SCHEMA_VERSION = 26

/**
 * Apply the complete unified schema to the given database.
 * Reads schema.sql from the same directory (works in both dev and bundled output).
 * Idempotent — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  // Read current schema version
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) || 0

  // Run migrations for existing databases
  if (currentVersion > 0 && currentVersion < 26) {
    // P0 (v24): Add archived column to workspaces (soft delete)
    if (currentVersion < 24) {
      try {
        db.exec('ALTER TABLE workspaces ADD COLUMN archived INTEGER DEFAULT 0')
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
    }

    // P1 (v25): Add archive status columns to workspaces
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

    // P2 (v26): Experience index + FTS5 — new tables use IF NOT EXISTS,
    // no ALTER needed. schema.sql handles creation idempotently.
    if (currentVersion < 26) {
      // No migration SQL needed — experience_index and experience_index_fts
      // are created by schema.sql via IF NOT EXISTS. Just bump version.
    }
  }

  // Apply full schema (idempotent via IF NOT EXISTS)
  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
