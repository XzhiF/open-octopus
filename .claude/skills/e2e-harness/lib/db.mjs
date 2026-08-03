/**
 * E2E Harness — db.mjs
 * SQLite CLI execution for E2E tests.
 *
 * @module db
 * @status STABLE
 *
 * Unifies 3 historical approaches to SQL execution:
 *   1. Direct sqlite3 CLI calls
 *   2. matt-sql-executor skill scripts
 *   3. Inline child_process in E2E scripts
 *
 * Uses a single approach: node:child_process + sqlite3 CLI.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { safeName } from "./api.mjs"

const DEFAULT_DB_DIR = path.join(os.homedir(), ".octopus", "db")
const SQLITE_TIMEOUT = 10000
const SQLITE_MAX_BUFFER = 10 * 1024 * 1024 // 10MB

/**
 * Resolve the SQLite database path.
 *
 * Priority:
 *   1. Explicit dbPath argument
 *   2. OCTOPUS_DB_PATH env var
 *   3. Worktree DB: octopus-{branch}.db in DEFAULT_DB_DIR
 *   4. Default: ~/.octopus/db/octopus.db
 *
 * @param {string} [dbPath] - Explicit path override
 * @param {string} [mode] - "dev" | "worktree" | "prod"
 * @returns {string} absolute path to the SQLite database
 */
export function resolveDbPath(dbPath, mode) {
  // 1. Explicit
  if (dbPath) return dbPath

  // 2. Env var
  if (process.env.OCTOPUS_DB_PATH) return process.env.OCTOPUS_DB_PATH

  // 3. Mode-based
  if (mode === "prod") {
    return path.join(DEFAULT_DB_DIR, "octopus-prod.db")
  }

  if (mode === "worktree") {
    // Try to get branch name for worktree DB
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim()
      const safe = safeName(branch)
      const wtPath = path.join(DEFAULT_DB_DIR, `octopus-${safe}.db`)
      if (fs.existsSync(wtPath)) return wtPath
    } catch { /* fall through */ }
  }

  // 4. Default
  return path.join(DEFAULT_DB_DIR, "octopus.db")
}

// ─── Internal Helper ──────────────────────────────────────────────

/**
 * Run a sqlite3 command with arguments (no shell interpretation).
 *
 * @param {string[]} flags - sqlite3 flags (e.g. ["-header", "-column"] or ["-json"])
 * @param {string} sql - SQL statement
 * @param {string} [dbPath] - Explicit DB path override
 * @param {object} [options] - Execution options
 * @returns {{ output: string, ok: boolean, error: string | null }}
 */
function runSqlite(flags, sql, dbPath, options = {}) {
  const db = resolveDbPath(dbPath, options.mode)
  if (!fs.existsSync(db)) {
    return { output: "", ok: false, error: `Database not found: ${db}` }
  }
  try {
    const output = execFileSync("sqlite3", [...flags, db, sql], {
      encoding: "utf8",
      timeout: options.timeout || SQLITE_TIMEOUT,
      maxBuffer: SQLITE_MAX_BUFFER,
    })
    return { output: output.trim(), ok: true, error: null }
  } catch (err) {
    return { output: "", ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Execute a SQL statement against the SQLite database.
 *
 * @param {string} sql - SQL statement to execute
 * @param {string} [dbPath] - Explicit DB path override
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=10000] - Timeout in ms
 * @param {string} [options.mode] - "dev" | "worktree" | "prod"
 * @returns {{ rows: string, ok: boolean, error: string | null }}
 */
export function executeSQL(sql, dbPath, options = {}) {
  const result = runSqlite(["-header", "-column"], sql, dbPath, options)
  return {
    rows: result.output,
    ok: result.ok,
    error: result.error,
  }
}

/**
 * Execute a SQL query and parse the result into objects.
 * Uses -json mode for structured output.
 *
 * @param {string} sql - SELECT query
 * @param {string} [dbPath] - Explicit DB path override
 * @param {object} [options] - Execution options
 * @returns {{ data: any[], ok: boolean, error: string | null }}
 */
export function querySQL(sql, dbPath, options = {}) {
  const result = runSqlite(["-json"], sql, dbPath, options)
  if (!result.ok) return { data: [], ok: false, error: result.error }

  if (!result.output) return { data: [], ok: true, error: null }

  try {
    const data = JSON.parse(result.output)
    return { data: Array.isArray(data) ? data : [data], ok: true, error: null }
  } catch (err) {
    return { data: [], ok: false, error: `JSON parse error: ${err.message}` }
  }
}

/**
 * List tables in the database.
 *
 * @param {string} [dbPath]
 * @returns {string[]} table names
 */
export function listTables(dbPath) {
  const result = querySQL(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    dbPath,
  )
  if (!result.ok) return []
  return result.data.map((row) => row.name)
}
