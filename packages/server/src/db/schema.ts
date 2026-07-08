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
  // Handle schema changes for existing tables
  handleSchemaMigrations(db)

  const sqlPath = path.join(_dirname, "schema.sql")
  const sql = fs.readFileSync(sqlPath, "utf-8")
  db.exec(sql)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

function handleSchemaMigrations(db: Database.Database): void {
  // Check if execution_archive table exists with old schema (has 'id' column instead of 'execution_id' as PRIMARY KEY)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_archive'").all()
  if (tables.length > 0) {
    const cols = db.prepare("PRAGMA table_info(execution_archive)").all() as { name: string; pk: number }[]
    const idCol = cols.find(c => c.name === 'id')
    const execIdCol = cols.find(c => c.name === 'execution_id')

    // Old schema: has 'id' as PRIMARY KEY, new schema: has 'execution_id' as PRIMARY KEY
    if (idCol && idCol.pk === 1 && execIdCol && execIdCol.pk === 0) {
      // Drop old table, will be recreated by schema.sql
      db.exec("DROP TABLE execution_archive")
    }
  }

  // Add missing columns for existing tables
  ensureColumnsForExistingTables(db)
}

function ensureColumnsForExistingTables(db: Database.Database): void {
  // Tables that need 'org' column
  const tablesNeedingOrg = [
    'workspaces',
    'executions',
    'sessions',
    'clones',
    'evolution_log',
    'experiences',
    'safety_events',
    'reports',
    'scheduled_job_executions',
    'schedule_workspaces',
    'schedules'
  ]

  for (const table of tablesNeedingOrg) {
    ensureColumn(db, table, 'org', "TEXT NOT NULL DEFAULT 'default'")
  }

  // Archive status column for workspaces
  ensureColumn(db, 'workspaces', 'archive_status', "TEXT DEFAULT NULL")
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  // Check if table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table)
  if (tables.length === 0) return // Table doesn't exist yet, will be created by schema.sql

  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
