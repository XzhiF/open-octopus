// packages/server/src/db/schema.ts
//
// Initial schema baseline. There is no version number and no migration path:
// schema.sql IS the current shape. Fresh databases are created from it every
// time; historical data is intentionally not carried.
//
import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { llmCallsCostedViewSql } from "./price-sql"

// Cross-format __dirname: works in both CJS (tsup provides it) and ESM.
declare const __dirname: string
const _dirname: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url))

/**
 * Apply the complete schema to the given database.
 * Idempotent — every statement uses IF NOT EXISTS.
 */
export function applySchema(db: Database.Database): void {
  // Additive columns must exist BEFORE schema.sql runs: the file below creates
  // partial indexes / triggers that reference them (e.g. ux_cabins_path on
  // cabins.deleted_at, trg_*_cabin_write_once). Fresh databases get the same
  // columns from CREATE TABLE; on existing databases these ALTERs are the only
  // way in (there is no versioned migration path). Each is wrapped because the
  // table may not exist yet on a fresh DB.
  //
  // executions.cabin_id was added 2026-11-17. Detect the pre-migration shape so
  // the one-time backfill below runs exactly once per database, not on every boot.
  const execCols = db.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>
  const executionsCabinMissing = execCols.length > 0 && !execCols.some((c) => c.name === "cabin_id")

  for (const [table, column] of [
    ["workspaces", "cabin_id"],
    ["tasks", "cabin_id"],
    ["sessions", "cabin_id"],
    ["executions", "cabin_id"],
    ["cabins", "deleted_at"],
    ["cabin_delegations", "archived_at"],
  ] as const) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`) } catch { /* table absent or column exists */ }
  }

  // 历史执行回填（只在新列刚加时跑一次）：task 优先，其次 workspace。
  // 归属是账本，回填完就不再变（后续由 trg_executions_cabin_write_once 兜底）。
  if (executionsCabinMissing) {
    db.exec(`
      UPDATE executions
         SET cabin_id = (SELECT t.cabin_id FROM tasks t WHERE t.id = executions.task_id)
       WHERE cabin_id IS NULL AND task_id IS NOT NULL
         AND (SELECT t.cabin_id FROM tasks t WHERE t.id = executions.task_id) IS NOT NULL;
      UPDATE executions
         SET cabin_id = (SELECT w.cabin_id FROM workspaces w WHERE w.id = executions.workspace_id)
       WHERE cabin_id IS NULL
         AND (SELECT w.cabin_id FROM workspaces w WHERE w.id = executions.workspace_id) IS NOT NULL;
    `)
  }

  const sql = fs.readFileSync(path.join(_dirname, "schema.sql"), "utf-8")
  db.exec(sql)

  // Test fixture compatibility only. The production schema is org-free; a large
  // legacy test corpus still seeds raw rows with an `org` column. Keep the column
  // on in-memory/CI test DBs so those fixtures remain valid — never on a real DB.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    for (const table of [
      "workspaces", "executions", "sessions", "tasks", "schedules", "clones",
      "evolution_log", "experiences", "safety_events", "reports",
      "scheduled_job_executions", "insight_marks", "wiki_articles",
      "execution_archive", "workspace_archive", "archive_drafts", "llm_calls",
    ]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (cols.length > 0 && !cols.some(c => c.name === "org")) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN org TEXT DEFAULT 'default'`) } catch { /* table absent */ }
      }
    }
  }

  // billing NEW-r2: derived view from the ledger + price config.
  // DROP+CREATE every time so the view and the code can never drift.
  db.exec("DROP VIEW IF EXISTS llm_calls_costed")
  db.exec(llmCallsCostedViewSql())
}
