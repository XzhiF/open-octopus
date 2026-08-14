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

export const SCHEMA_VERSION = 36

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

  // Drop legacy linked_* columns from chat_sessions (removed in interaction-node feature)
  dropLegacyColumnsFromChatSessions(db)

  // Add missing columns for existing tables
  ensureColumnsForExistingTables(db)

  // Migrate FTS table to include source column (schema version 29)
  migrateFtsTableWithSource(db)

  // Migrate experiences_fts to v2 content-sync mode (schema version 35)
  migrateExperiencesFtsV2(db)
}

/**
 * Drop legacy linked_* columns from chat_sessions.
 * These columns were part of an earlier interaction design that has been replaced
 * by the interaction_messages table. SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN.
 */
function dropLegacyColumnsFromChatSessions(db: Database.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_sessions'").all()
  if (tables.length === 0) return

  const cols = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[]
  const legacyColumns = ["linked_execution_id", "linked_node_id", "interaction_mode", "interaction_status"]

  for (const column of legacyColumns) {
    if (cols.some(c => c.name === column)) {
      try {
        db.exec(`ALTER TABLE chat_sessions DROP COLUMN ${column}`)
      } catch (err) {
        // SQLite < 3.35.0 doesn't support DROP COLUMN — log and continue
        console.warn(`[schema] Failed to drop chat_sessions.${column}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
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

  // Clone system columns for sessions
  ensureColumn(db, 'sessions', 'scope_id', "TEXT")
  ensureColumn(db, 'sessions', 'provider_session_id', "TEXT")

  // Clone system columns for messages
  ensureColumn(db, 'messages', 'type', "TEXT NOT NULL DEFAULT 'text'")
  ensureColumn(db, 'messages', 'metadata', "TEXT")

  // Source column for memory FTS (clone memory alignment — iteration #10)
  ensureColumn(db, 'messages', 'source', "TEXT NOT NULL DEFAULT 'main'")

  // Clone system columns for clones
  ensureColumn(db, 'clones', 'type', "TEXT NOT NULL DEFAULT 'user'")

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
  ensureColumn(db, 'workspace_archive', 'extracted_workflows', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'extracted_agents', "INTEGER DEFAULT 0")
  ensureColumn(db, 'workspace_archive', 'analysis_report', "TEXT")
  ensureColumn(db, 'workspace_archive', 'file_deleted', "INTEGER DEFAULT 0")

  // Interaction metadata for executions
  ensureColumn(db, 'executions', 'interaction_metadata', "TEXT")

  // Nested execution hierarchy (sub-workflow parent tracking + loop iteration tracking)
  ensureColumn(db, 'node_executions', 'parent_node_id', "TEXT")
  ensureColumn(db, 'node_executions', 'iteration_index', "INTEGER")

  // Agent version tracking (schema version 33)
  ensureColumn(db, 'clones', 'current_version_id', "TEXT")

  // Harness columns (schema version 34)
  ensureColumn(db, 'node_executions', 'harness_status', "TEXT")
  ensureColumn(db, 'node_executions', 'harness_interventions', "TEXT")
  ensureColumn(db, 'node_token_usages', 'source', "TEXT DEFAULT 'node'")

  // Execution-level harness status (schema version 35 — harness-semantic-v2)
  ensureColumn(db, 'executions', 'harness_status', "TEXT DEFAULT NULL")
  ensureColumn(db, 'executions', 'harness_summary', "TEXT DEFAULT NULL")

  // Budget snapshot (schema version 36 — workflow-observability)
  ensureColumn(db, 'executions', 'budget_snapshot', "TEXT DEFAULT NULL")

  // Experience v2 columns (schema version 35 — harness-learning-platform)
  ensureColumn(db, 'experiences', 'scope', "TEXT NOT NULL DEFAULT 'agent'")
  ensureColumn(db, 'experiences', 'scope_ref', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'pattern_tags', "TEXT DEFAULT '[]'")
  ensureColumn(db, 'experiences', 'outcome', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'source_type', "TEXT NOT NULL DEFAULT 'session'")
  ensureColumn(db, 'experiences', 'execution_id', "TEXT DEFAULT NULL")
  ensureColumn(db, 'experiences', 'node_id', "TEXT DEFAULT NULL")
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

/**
 * Migrate session_memory_fts to include source column.
 * FTS5 virtual tables don't support ALTER TABLE, so we drop and recreate.
 * Schema.sql will recreate the table with the new schema (IF NOT EXISTS).
 */
function migrateFtsTableWithSource(db: Database.Database): void {
  try {
    // Check if the FTS table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_memory_fts'").all()
    if (tables.length === 0) return // Will be created by schema.sql

    // Check if source column exists by trying to query it
    try {
      db.prepare("SELECT source FROM session_memory_fts LIMIT 1").get()
      return // Already has source column
    } catch {
      // Source column missing — drop table, schema.sql will recreate it
      db.exec("DROP TABLE IF EXISTS session_memory_fts")
      // eslint-disable-next-line no-console
      console.log("[schema] Dropped old session_memory_fts (missing source column), will recreate")
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[schema] FTS migration check failed:", err instanceof Error ? err.message : String(err))
  }
}

/**
 * Blue-green migration for experiences_fts → v2 content-sync mode.
 *
 * Strategy:
 *   1. Check if old (non-content-sync) FTS table exists
 *   2. If yes: create experiences_fts_v2, populate from experiences, swap names
 *   3. If no: schema.sql will create it fresh
 *
 * This prevents data loss that would occur with a simple DROP + CREATE.
 * After migration, schema.sql's CREATE VIRTUAL TABLE IF NOT EXISTS is a no-op
 * because the table already exists (renamed from v2).
 */
function migrateExperiencesFtsV2(db: Database.Database): void {
  try {
    // Check if the old FTS table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='experiences_fts'"
    ).all()
    if (tables.length === 0) return // Will be created by schema.sql

    // Check if the FTS table already has the v2 columns (scope, scope_ref, pattern_tags)
    // FTS5 virtual tables show up in table_info, so we can check columns
    try {
      const cols = db.prepare("PRAGMA table_info(experiences_fts)").all() as { name: string }[]
      const hasScope = cols.some(c => c.name === "scope")
      if (hasScope) return // Already migrated to v2
    } catch {
      // table_info might fail on virtual tables in some SQLite versions — proceed with migration
    }

    // Check if experiences table has the new columns (they should, via ensureColumn above)
    const expCols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[]
    const hasScopeCol = expCols.some(c => c.name === "scope")
    if (!hasScopeCol) {
      // experiences table doesn't have new columns yet — skip FTS migration,
      // the columns will be added by ensureColumn and FTS will be created fresh by schema.sql
      return
    }

    // Blue-green migration: create v2 → populate → swap
    // eslint-disable-next-line no-console
    console.log("[schema] Starting experiences_fts blue-green migration to v2...")

    db.exec("DROP TABLE IF EXISTS experiences_fts_v2")

    db.exec(`
      CREATE VIRTUAL TABLE experiences_fts_v2 USING fts5(
        skill_name, content, scope, scope_ref, pattern_tags
      )
    `)

    // Populate from experiences table (which now has the new columns via ensureColumn)
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM experiences").get() as { cnt: number }).cnt
    if (count > 0) {
      db.exec(`
        INSERT INTO experiences_fts_v2 (rowid, skill_name, content, scope, scope_ref, pattern_tags)
        SELECT id, skill_name, content, scope, scope_ref, pattern_tags FROM experiences
      `)
    }

    // Atomic swap
    db.exec("DROP TABLE IF EXISTS experiences_fts")
    db.exec("ALTER TABLE experiences_fts_v2 RENAME TO experiences_fts")

    // eslint-disable-next-line no-console
    console.log(`[schema] experiences_fts migrated to v2 (${count} rows populated)`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[schema] experiences_fts v2 migration failed:", err instanceof Error ? err.message : String(err))
    // Non-fatal — FTS will be recreated by schema.sql if needed
    try { db.exec("DROP TABLE IF EXISTS experiences_fts_v2") } catch { /* ignore */ }
  }
}
