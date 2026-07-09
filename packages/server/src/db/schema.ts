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

    // Old schema: has 'id' as PRIMARY KEY (new schema uses 'execution_id' as PK)
    if (idCol && idCol.pk === 1) {
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM execution_archive").get() as { cnt: number }).cnt
      // Rename to backup instead of dropping — preserves data for manual inspection
      db.exec("ALTER TABLE execution_archive RENAME TO execution_archive_old_schema_backup")
      console.log(`[schema] Renamed old execution_archive (${count} rows) → execution_archive_old_schema_backup`)
    }
  }

  // Check if workspace_archive table exists with old schema (has 'id' column and old column names)
  const wsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_archive'").all()
  if (wsTables.length > 0) {
    const cols = db.prepare("PRAGMA table_info(workspace_archive)").all() as { name: string }[]
    const idCol = cols.find(c => c.name === 'id')
    const nameCol = cols.find(c => c.name === 'name')

    // Old schema: has 'id' as PRIMARY KEY and 'workspace_name' instead of 'name'
    // New schema: uses 'workspace_id' as PRIMARY KEY and has 'name' column
    if (idCol || !nameCol) {
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM workspace_archive").get() as { cnt: number }).cnt
      // Rename to backup instead of dropping — preserves data for manual inspection
      db.exec("ALTER TABLE workspace_archive RENAME TO workspace_archive_old_schema_backup")
      console.log(`[schema] Renamed old workspace_archive (${count} rows) → workspace_archive_old_schema_backup`)
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

  // Archive V2 columns for workspace_archive
  ensureColumn(db, 'workspace_archive', 'name', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'workspace_archive', 'description', "TEXT")
  ensureColumn(db, 'workspace_archive', 'source', "TEXT")
  ensureColumn(db, 'workspace_archive', 'execution_count', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'total_cost', "REAL DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'total_duration_ms', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'created_at', "TEXT")
  ensureColumn(db, 'workspace_archive', 'metadata', "TEXT")
  ensureColumn(db, 'workspace_archive', 'extracted_experiences', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'extracted_skills', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'analysis_report', "TEXT")
  ensureColumn(db, 'workspace_archive', 'file_deleted', "INTEGER DEFAULT 0")
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
