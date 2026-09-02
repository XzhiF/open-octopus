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

export const SCHEMA_VERSION = 40

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

  // schema v37: schedules — drop NOT NULL on cron_expression + add task-pool columns
  migrateSchedulesV37(db)

  // schema v38 ADDITIVE: origin cols are added via ensureColumnsForExistingTables
  // above (origin_type/origin_id/origin_role/assoc_meta). Nothing to do here for
  // the additive phase — origin cols coexist with the v37 task-pool hack cols
  // (trigger_source / source_chat_session_id) transiently.

  // schema v38b (ticket 06 / SG1b): DROP the task-pool hack cols trigger_source +
  // source_chat_session_id. Their承重 sites (scheduler-engine failed-promotion +
  // checkQueuedTasks filter + task-dispatch-service child creation) are migrated
  // to origin_type in the same ticket. Done AFTER the origin col migration above
  // so the build stays green through the removal. Safe on fresh DBs (table may
  // not exist yet / cols may not exist) and on existing dev DBs (cols dropped).
  migrateSchedulesV38DropTriggerCols(db)

  // schema v40 (task-phase-redesign K3): tasks.status CHECK gains awaiting_review +
  // archiving. Runs AFTER ensureColumnsForExistingTables so the v40 cols
  // (workspace_id / phase_index / round_index) are already on the old table and get
  // carried by the copy. Re-entrant: once the live table's DDL text contains the new
  // statuses it no-ops.
  migrateTasksStatusCheckV40(db)
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

  // Run-phase + polymorphic origin columns (schema v37 → v38, ADDITIVE then DROP).
  // v37: status/claimed_at for the task-pool run lifecycle (trigger_source /
  //      source_chat_session_id were also added in v37 as the task-pool hack).
  // v38: ADD origin_type/origin_id/origin_role/assoc_meta (S2 polymorphic origin, no
  //      FK — app-level cascade-reap + orphan reaper maintain integrity).
  // v38b (ticket 06 / SG1b): DROP trigger_source + source_chat_session_id — the
  //      承重 sites are migrated to origin_type. The cols are NO LONGER
  //      ensured (removed below) and the migrateSchedulesV38DropTriggerCols
  //      migration drops them from existing dev DBs. Fresh DBs created by
  //      schema.sql still have the cols (schema.sql is 02's, not touched here);
  //      the migration runs on every applySchema and drops them idempotently.
  ensureColumn(db, 'schedules', 'status', "TEXT NOT NULL DEFAULT 'queued'")
  ensureColumn(db, 'schedules', 'claimed_at', "TEXT")
  ensureColumn(db, 'schedules', 'origin_type', "TEXT NOT NULL DEFAULT 'cron'")
  ensureColumn(db, 'schedules', 'origin_id', "TEXT")
  ensureColumn(db, 'schedules', 'origin_role', "TEXT")
  ensureColumn(db, 'schedules', 'assoc_meta', "TEXT")
  // v39: one-shot due time for task-origin manual/time triggers. NULL =
  // cron/legacy/claim-immediately. Additive nullable column — no rebuild.
  ensureColumn(db, 'schedules', 'scheduled_at', "TEXT")

  // schema v40 (task-phase-redesign K4): executions gains the round identity
  // (phase_index/round_index, NULL = v3/generic); tasks gains its bound workspace
  // (NULL = never triggered). Additive nullable cols — no rebuild.
  ensureColumn(db, 'executions', 'phase_index', "INTEGER DEFAULT NULL")
  ensureColumn(db, 'executions', 'round_index', "INTEGER DEFAULT NULL")
  ensureColumn(db, 'tasks', 'workspace_id', "TEXT DEFAULT NULL")
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

/**
 * schema v37: schedules — drop NOT NULL on cron_expression.
 *
 * SQLite cannot remove a NOT NULL constraint in place. The columns added in
 * ensureColumnsForExistingTables (status, trigger_source, source_chat_session_id,
 * claimed_at) are already present on existing DBs. The remaining task is making
 * cron_expression nullable: detect the old constraint and rename the table to
 * a backup, letting schema.sql recreate schedules fresh with the new shape.
 *
 * Existing rows are preserved in schedules_old_schema_backup_v37 for manual
 * inspection — matching the execution_archive migration pattern. New active
 * table starts empty. Acceptable for rapid-iteration dev DBs.
 */
function migrateSchedulesV37(db: Database.Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'"
  ).all()
  if (tables.length === 0) return // Will be created by schema.sql

  const cols = db.prepare("PRAGMA table_info(schedules)").all() as {
    name: string
    notnull: number
    type: string
  }[]

  const cronCol = cols.find(c => c.name === 'cron_expression')
  if (!cronCol || cronCol.notnull === 0) return // Already nullable

  const count = (db.prepare("SELECT COUNT(*) as cnt FROM schedules").get() as { cnt: number }).cnt
  db.exec("ALTER TABLE schedules RENAME TO schedules_old_schema_backup_v37")
  // eslint-disable-next-line no-console
  console.log(`[schema] Renamed old schedules (${count} rows) → schedules_old_schema_backup_v37; schema.sql will recreate with nullable cron_expression`)

  // ponytail: SQLite FK targets are name-bound — when schedules was renamed,
  // schedule_executions and schedule_workspaces FKs now point to the backup table,
  // not the new active schedules. Rename them too so schema.sql recreates with FK
  // on the new schedules table. Without this, every INSERT into schedule_executions
  // fails with "FOREIGN KEY constraint failed" because schedule_id exists in new
  // schedules but FK validates against the backup table. T-6 E2E caught this.
  for (const dep of ['schedule_executions', 'schedule_workspaces', 'schedule_audit_logs']) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).all(dep)
    if (exists.length > 0) {
      const depCount = (db.prepare(`SELECT COUNT(*) as cnt FROM ${dep}`).get() as { cnt: number }).cnt
      db.exec(`ALTER TABLE ${dep} RENAME TO ${dep}_old_schema_backup_v37`)
      // eslint-disable-next-line no-console
      console.log(`[schema] Renamed ${dep} (${depCount} rows) → ${dep}_old_schema_backup_v37; schema.sql will recreate with FK on new schedules`)
    }
  }
}

/**
 * schema v38b (ticket 06 / SG1b): DROP the task-pool hack cols `trigger_source`
 * and `source_chat_session_id` from `schedules`.
 *
 * These cols were added in v37 as the task-pool hack (storing task drafts inside
 * the cron scheduler). v2 (task-domain-redesign) replaces them with the
 * first-class `tasks` table + S2 polymorphic `origin_type`/`origin_id`/`origin_role`
 * cols (added additively in v38). The 3 承重 sites (scheduler-engine failed-
 * promotion gate + checkQueuedTasks filter + task-dispatch-service child creation)
 * are migrated to `origin_type` in the same ticket, so dropping the cols is safe.
 *
 * CONSTRAINT: schema.sql (02's file, off-limits to this ticket) defines
 * `idx_schedules_status ON schedules(status, trigger_source)` — an index that
 * REFERENCES trigger_source. SQLite cannot DROP a column that's part of an index
 * ("error in index ... after drop column"). So the migration must:
 *   1. DROP the index (so the column is no longer indexed)
 *   2. DROP the column
 *   3. RECREATE the index on just `status` (trigger_source is gone)
 * After step 3, schema.sql's `CREATE INDEX IF NOT EXISTS idx_schedules_status
 * ON schedules(status, trigger_source)` is a no-op (index already exists) and
 * does NOT validate column references — so it doesn't break on the missing col.
 *
 * Fresh DBs (1st applySchema): migration runs before schema.sql creates the
 * table → no-op. schema.sql then creates table + index WITH the cols. So the
 * cols exist after the 1st applySchema. On the 2nd+ applySchema (idempotent
 * test, dev DB restart), the migration drops them. Code never reads/writes them
 * regardless (ScheduleRow type has them removed; insertSchedule doesn't write
 * them), so the lingering cols on 1st-applySchema DBs are harmless.
 *
 * Wrapped in try-catch per col so a failure on one is non-fatal (the col stays,
 * code is type-clean + doesn't use it).
 */
function migrateSchedulesV38DropTriggerCols(db: Database.Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'"
  ).all()
  if (tables.length === 0) return // Will be created by schema.sql (with the cols; next run drops them)

  // The index referencing trigger_source must be dropped first (SQLite can't
  // drop a column that's part of an index). Recreate it on just `status` after.
  const hasStatusIdx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedules_status'",
  ).get() as { name: string } | undefined

  for (const col of ['trigger_source', 'source_chat_session_id']) {
    const cols = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) continue // already dropped
    try {
      // Drop the status index before dropping trigger_source (it references it).
      // For source_chat_session_id the index isn't affected, but dropping it once
      // for the first col is enough; the recreate below re-adds it on `status`.
      if (col === 'trigger_source' && hasStatusIdx) {
        db.exec("DROP INDEX IF EXISTS idx_schedules_status")
      }
      db.exec(`ALTER TABLE schedules DROP COLUMN ${col}`)
      // eslint-disable-next-line no-console
      console.log(`[schema] Dropped schedules.${col} (v38b / ticket 06 SG1b — migrated to origin_type)`)
    } catch (err) {
      // SQLite < 3.35.0 doesn't support DROP COLUMN, or other failure — log + continue.
      // The col stays but code no longer reads/writes it (type-clean); the orphan
      // col is harmless on legacy DBs.
      console.warn(
        `[schema] Failed to drop schedules.${col}: ${err instanceof Error ? err.message : String(err)} (non-fatal — col is no longer used)`,
      )
    }
  }

  // Recreate the status index on just `status` (trigger_source is gone). Use
  // IF NOT EXISTS so this is idempotent + so schema.sql's later
  // `CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status, trigger_source)`
  // is a no-op (the index already exists → no column-reference validation).
  if (hasStatusIdx) {
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status) WHERE deleted_at IS NULL",
      )
    } catch (err) {
      console.warn(
        `[schema] Failed to recreate idx_schedules_status: ${err instanceof Error ? err.message : String(err)} (non-fatal)`,
      )
    }
  }
}

/**
 * schema v40 (task-phase-redesign K3): tasks.status CHECK gains 'awaiting_review'
 * + 'archiving' (the v4 gate states). SQLite cannot alter a CHECK in place, so
 * existing DBs need a rebuild: create the new-shape table, copy rows, swap names.
 *
 * Data-preserving by design — unlike the v37 rename-to-backup (dev-only empty
 * recreate), `tasks` holds real user kanban data; dropping it silently would be
 * destructive. The copy uses the explicit column list (v40 shape); every existing
 * dev DB has at least the v38 set + workspace_id (added by
 * ensureColumnsForExistingTables immediately before this migration runs).
 *
 * Safety notes:
 *   - No table has `FOREIGN KEY … REFERENCES tasks` (verified via grep) — the
 *     DROP+RENAME can't strand child FKs (the v37 pitfall). The new table's own
 *     FK (source_chat_session_id→sessions) is created by DDL text regardless.
 *   - foreign_keys is toggled OFF around the swap so orphaned
 *     source_chat_session_id rows (sessions deleted without cascade) can't abort
 *     the copy; it is restored in `finally`.
 *   - Old idx_tasks_* indexes are dropped with the old table; schema.sql's
 *     CREATE INDEX IF NOT EXISTS (which runs after handleSchemaMigrations)
 *     recreates them on the rebuilt table.
 *
 * Re-entrancy: detection is a DDL-text check (`awaiting_review` present →
 * already migrated), so 2nd+ applySchema runs no-op. Fresh DBs skip entirely
 * (table doesn't exist yet; schema.sql creates it with the v40 CHECK).
 */
function migrateTasksStatusCheckV40(db: Database.Database): void {
  const tbl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
  ).get() as { sql: string } | undefined
  if (!tbl) return // Will be created by schema.sql with the v40 CHECK
  if (tbl.sql.includes("awaiting_review")) return // Already migrated

  const count = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }).cnt
  // Keep this DDL in sync with the tasks CREATE TABLE in schema.sql (v40 shape).
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE tasks_v40_rebuild (
        id TEXT PRIMARY KEY,
        org TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','running','awaiting_review','archiving','done','failed','aborted')),
        source_chat_session_id TEXT,
        task_spec TEXT NOT NULL DEFAULT '{}',
        authoring_resources TEXT NOT NULL DEFAULT '[]',
        resources TEXT NOT NULL DEFAULT '[]',
        skills TEXT NOT NULL DEFAULT '[]',
        project_ids TEXT NOT NULL DEFAULT '[]',
        workflow_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        workspace_id TEXT DEFAULT NULL,
        FOREIGN KEY (source_chat_session_id) REFERENCES sessions(id)
      )
    `)
    const cols = [
      "id", "org", "name", "status", "source_chat_session_id", "task_spec",
      "authoring_resources", "resources", "skills", "project_ids",
      "workflow_ref", "version", "deleted_at", "created_at", "updated_at",
      "completed_at", "workspace_id",
    ]
    db.exec(`
      INSERT INTO tasks_v40_rebuild (${cols.join(", ")})
      SELECT ${cols.join(", ")} FROM tasks
    `)
    db.exec("DROP TABLE tasks")
    db.exec("ALTER TABLE tasks_v40_rebuild RENAME TO tasks")
  })

  const fkWasOn = db.pragma("foreign_keys", { simple: true }) as number
  db.pragma("foreign_keys = OFF")
  try {
    rebuild()
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON")
  }
  // eslint-disable-next-line no-console
  console.log(`[schema] Rebuilt tasks with v40 status CHECK (awaiting_review/archiving added, failed kept for v3; ${count} rows preserved)`)
}
