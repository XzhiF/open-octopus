/**
 * Self-test for db.mjs
 * Run: node lib/db.self-test.mjs
 * Requires: SQLite database exists (default: ~/.octopus/db/octopus.db)
 */

import { createResults, record, exitWithResults } from "./reporter.mjs"
import { resolveDbPath, executeSQL, querySQL, listTables } from "./db.mjs"
import fs from "node:fs"

const results = createResults()

// Test 1: resolveDbPath returns a path
try {
  const dbPath = resolveDbPath()
  const valid = typeof dbPath === "string" && dbPath.length > 0
  record(results, "resolveDbPath returns path", valid, `path=${dbPath}`)
} catch (err) {
  record(results, "resolveDbPath returns path", false, err.message)
}

// Test 2: resolveDbPath with explicit path
try {
  const custom = "/tmp/custom.db"
  const dbPath = resolveDbPath(custom)
  record(results, "resolveDbPath respects explicit path", dbPath === custom, `path=${dbPath}`)
} catch (err) {
  record(results, "resolveDbPath respects explicit path", false, err.message)
}

// Test 3: executeSQL SELECT
try {
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    record(results, "executeSQL SELECT", false, `DB not found: ${dbPath}`)
    record(results, "querySQL returns data", false, "skipped — DB not found")
    record(results, "listTables returns names", false, "skipped — DB not found")
  } else {
    const result = executeSQL("SELECT 1 AS val")
    record(results, "executeSQL SELECT 1", result.ok && result.rows.includes("1"), `rows=${result.rows.slice(0, 50)}`)

    // Test 4: querySQL returns structured data
    const qr = querySQL("SELECT name FROM sqlite_master WHERE type='table' LIMIT 3")
    record(results, "querySQL returns structured data", qr.ok && Array.isArray(qr.data), `tables=${qr.data.length}`)

    // Test 5: listTables
    const tables = listTables()
    record(results, "listTables returns names", Array.isArray(tables) && tables.length > 0, `count=${tables.length}`)
  }
} catch (err) {
  record(results, "executeSQL SELECT", false, err.message)
}

exitWithResults(results, { title: "db.mjs self-test" })
