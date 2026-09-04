/**
 * Schema Migration Tests — Experiences V2 (schema version 35)
 *
 * Tests:
 * - 7 new columns on experiences table with correct DEFAULTs
 * - FTS5 v2 table with scope-aware columns
 * - 5 new indexes
 * - Backward compatibility (existing data gets DEFAULT values)
 * - Blue-green FTS migration (existing data preserved)
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema, SCHEMA_VERSION } from "../db/schema"

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  return db
}

describe("Schema v35 — Experience Schema Migration", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  it("sets schema version to the current SCHEMA_VERSION", () => {
    db = createTestDb()
    applySchema(db)
    const rows = db.pragma("user_version") as Array<{ user_version: number }>
    // v40 = task-phase-redesign (acceptances table + executions/tasks cols).
    // Was stale at 35 since v36; assert the live constant instead of a pinned old
    // number so future version bumps don't re-break this v35-focused suite.
    expect(rows[0].user_version).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(35)
  })

  // ── AC-1: 7 new columns with DEFAULT values ─────────────────────────

  it("experiences table has 7 new columns", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining([
      "scope", "scope_ref", "pattern_tags", "outcome",
      "source_type", "execution_id", "node_id",
    ]))
  })

  it("scope column has DEFAULT 'agent'", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const scopeCol = cols.find(c => c.name === "scope")
    expect(scopeCol).toBeDefined()
    expect(scopeCol!.dflt_value).toBe("'agent'")
  })

  it("scope_ref column has DEFAULT NULL", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "scope_ref")
    expect(col).toBeDefined()
    // SQLite returns the string "NULL" for DEFAULT NULL
    expect(col!.dflt_value === "NULL" || col!.dflt_value === null).toBe(true)
  })

  it("pattern_tags column has DEFAULT '[]'", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "pattern_tags")
    expect(col).toBeDefined()
    expect(col!.dflt_value).toBe("'[]'")
  })

  it("outcome column has DEFAULT NULL", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "outcome")
    expect(col).toBeDefined()
    // SQLite returns the string "NULL" for DEFAULT NULL
    expect(col!.dflt_value === "NULL" || col!.dflt_value === null).toBe(true)
  })

  it("source_type column has DEFAULT 'session'", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "source_type")
    expect(col).toBeDefined()
    expect(col!.dflt_value).toBe("'session'")
  })

  it("execution_id column has DEFAULT NULL", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "execution_id")
    expect(col).toBeDefined()
    // SQLite returns the string "NULL" for DEFAULT NULL
    expect(col!.dflt_value === "NULL" || col!.dflt_value === null).toBe(true)
  })

  it("node_id column has DEFAULT NULL", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string; dflt_value: string | null }[]
    const col = cols.find(c => c.name === "node_id")
    expect(col).toBeDefined()
    // SQLite returns the string "NULL" for DEFAULT NULL
    expect(col!.dflt_value === "NULL" || col!.dflt_value === null).toBe(true)
  })

  // ── AC-2: Backward compatibility — existing data gets DEFAULT values ──

  it("existing data without new columns gets DEFAULT values", () => {
    db = createTestDb()
    // Insert using old schema (without new columns)
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        org TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    db.prepare(`
      INSERT INTO experiences (skill_name, content, org, created_at)
      VALUES (?, ?, ?, ?)
    `).run("old-skill", "old experience content", "test-org", "2024-01-01")

    // Apply new schema — adds columns with DEFAULTs
    applySchema(db)

    // Verify existing row got default values
    const row = db.prepare("SELECT * FROM experiences WHERE id = 1").get() as Record<string, unknown>
    expect(row.scope).toBe("agent")
    expect(row.scope_ref).toBeNull()
    expect(row.pattern_tags).toBe("[]")
    expect(row.outcome).toBeNull()
    expect(row.source_type).toBe("session")
    expect(row.execution_id).toBeNull()
    expect(row.node_id).toBeNull()
    // Original columns preserved
    expect(row.skill_name).toBe("old-skill")
    expect(row.content).toBe("old experience content")
    expect(row.org).toBe("test-org")
  })

  // ── AC-3: FTS5 v2 table ─────────────────────────────────────────────

  it("creates experiences_fts with 5 columns (v2)", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(experiences_fts)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining([
      "skill_name", "content", "scope", "scope_ref", "pattern_tags",
    ]))
  })

  it("FTS5 search works with new columns", () => {
    db = createTestDb()
    applySchema(db)
    // Insert experience with scope
    db.prepare(`
      INSERT INTO experiences (skill_name, content, org, created_at, scope, scope_ref, pattern_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("harness-skill", "harness intervention for timeout", "test-org", "2024-01-01", "harness", "timeout_detector", '["fix_and_retry"]')

    // Insert into FTS manually (since external content mode)
    db.prepare(`
      INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, "harness-skill", "harness intervention for timeout", "harness", "timeout_detector", '["fix_and_retry"]')

    // FTS search should find it
    const results = db.prepare(`
      SELECT * FROM experiences_fts WHERE experiences_fts MATCH ?
    `).all("harness") as Array<{ skill_name: string; content: string }>
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].skill_name).toBe("harness-skill")
  })

  // ── AC-4: 5 new indexes ─────────────────────────────────────────────

  it("creates 5 new experiences v2 indexes", () => {
    db = createTestDb()
    applySchema(db)
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='experiences'"
    ).all() as { name: string }[]
    const idxNames = indexes.map(i => i.name)
    expect(idxNames).toContain("idx_experiences_scope")
    expect(idxNames).toContain("idx_experiences_scope_ref")
    expect(idxNames).toContain("idx_experiences_source_type")
    expect(idxNames).toContain("idx_experiences_execution_id")
    expect(idxNames).toContain("idx_experiences_org_scope_time")
  })

  // ── Blue-green FTS migration ────────────────────────────────────────

  it("blue-green migration preserves existing FTS data", () => {
    db = createTestDb()

    // Simulate old schema: create old FTS table and insert data
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        org TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    db.exec(`CREATE VIRTUAL TABLE experiences_fts USING fts5(skill_name, content)`)
    db.prepare(`
      INSERT INTO experiences (skill_name, content, org, created_at)
      VALUES (?, ?, ?, ?)
    `).run("old-skill", "old content about errors", "test-org", "2024-01-01")
    db.prepare(`
      INSERT INTO experiences_fts (rowid, skill_name, content)
      VALUES (?, ?, ?)
    `).run(1, "old-skill", "old content about errors")

    // Apply new schema — should migrate FTS to v2
    applySchema(db)

    // Verify experiences table has new columns
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain("scope")
    expect(colNames).toContain("scope_ref")

    // Verify FTS table has new columns
    const ftsCols = db.prepare("PRAGMA table_info(experiences_fts)").all() as { name: string }[]
    const ftsColNames = ftsCols.map(c => c.name)
    expect(ftsColNames).toContain("scope")
    expect(ftsColNames).toContain("pattern_tags")

    // Verify old data migrated (with default scope='agent')
    const ftsResults = db.prepare(`
      SELECT * FROM experiences_fts WHERE experiences_fts MATCH ?
    `).all("errors") as Array<{ skill_name: string }>
    expect(ftsResults.length).toBeGreaterThan(0)
    expect(ftsResults[0].skill_name).toBe("old-skill")
  })

  it("is idempotent for v2 schema", () => {
    db = createTestDb()
    applySchema(db)
    applySchema(db) // Second application should not error

    const rows = db.pragma("user_version") as Array<{ user_version: number }>
    expect(rows[0].user_version).toBe(SCHEMA_VERSION)

    // experiences table should still have all columns
    const cols = db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain("scope")
    expect(colNames).toContain("node_id")
  })
})
