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

export const SCHEMA_VERSION = 24

/**
 * Apply the complete unified schema to the given database.
 * Reads schema.sql from the same directory (works in both dev and bundled output).
 * Idempotent — all statements use IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  // Read current schema version
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) || 0

  // Run migrations for existing databases
  if (currentVersion > 0 && currentVersion < 24) {
    // P0: Add archived column to workspaces (soft delete)
    if (currentVersion < 24) {
      try {
        db.exec('ALTER TABLE workspaces ADD COLUMN archived INTEGER DEFAULT 0')
      } catch (e: any) {
        if (!e.message?.includes('duplicate column')) throw e
      }
    }
  }

  // Apply full schema (idempotent via IF NOT EXISTS)
  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
