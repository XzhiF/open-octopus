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
