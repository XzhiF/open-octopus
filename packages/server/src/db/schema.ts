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

export const SCHEMA_VERSION = 25

/**
 * Apply the complete unified schema to the given database.
 * Reads schema.sql from the same directory (works in both dev and bundled output).
 * Idempotent — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)

  // Safe ALTERs — ignore if columns already exist (SQLite doesn't support IF NOT EXISTS on ALTER)
  const alters = [
    "ALTER TABLE workspaces ADD COLUMN archive_status TEXT DEFAULT 'none'",
    "ALTER TABLE workspaces ADD COLUMN archive_started_at TEXT",
    "ALTER TABLE workspaces ADD COLUMN archive_error TEXT",
  ]
  for (const alter of alters) {
    try { db.exec(alter) } catch { /* column already exists */ }
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
