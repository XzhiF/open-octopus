/**
 * Schema Migration Tests — Experiences V2 (schema version 35) + Schedules V42
 *
 * Tests:
 * - 7 new columns on experiences table with correct DEFAULTs
 * - FTS5 v2 table with scope-aware columns
 * - 5 new indexes
 * - Backward compatibility (existing data gets DEFAULT values)
 * - Blue-green FTS migration (existing data preserved)
 * - v42 (ADR-0021 票03): the task-envelope columns come off an existing DB, and the
 *   pump's own run-state columns stay
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
    // v42 = ADR-0021 票03 (schedules stops carrying the task envelope's origin columns).
    // Was stale at 35 since v36; assert the live constant instead of a pinned old
    // number so future version bumps don't re-break this v35-focused suite.
    // The current version itself is pinned where it is actually the subject — the
    // v42 describe below.
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

/**
 * schema v42 (ADR-0021 票03) — `schedules` stops being a task's shadow.
 *
 * Two shapes have to converge, and only the second one is a migration:
 *   ① a FRESH db is created without the envelope columns at all;
 *   ② an EXISTING dev db (created before 票03, or replayed from a v38/v41 backup) still
 *      has them, and they must go — along with the two indexes that reference them,
 *      because SQLite refuses to DROP COLUMN on an indexed column (hence the ordering).
 * `status` / `claimed_at` stay on purpose: they are the pump's own run-state for cron and
 * agent jobs (manual fire, abort a live fire, the stale sweep), not task bookkeeping.
 */
describe("Schema v42 — schedules drops the task-envelope columns", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  const ENVELOPE_COLS = ["origin_type", "origin_id", "origin_role", "assoc_meta", "scheduled_at"]

  function scheduleCols(database: Database.Database): string[] {
    return (database.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map(c => c.name)
  }

  it("pins the current version at 42", () => {
    db = createTestDb()
    applySchema(db)
    expect(SCHEMA_VERSION).toBe(42)
  })

  it("① fresh DB: no envelope columns, run-state columns present", () => {
    db = createTestDb()
    applySchema(db)
    const cols = scheduleCols(db)
    for (const col of ENVELOPE_COLS) expect(cols, `schedules.${col} 应已删除`).not.toContain(col)
    expect(cols).toEqual(expect.arrayContaining(["status", "claimed_at"]))
  })

  it("② existing DB: the columns are dropped and the run-state columns survive", () => {
    db = createTestDb()
    // Start from a real current DB, then graft the pre-v42 shape back on — that is what a
    // developer's on-disk DB looks like the first time 票03 boots.
    applySchema(db)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'cron'`)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_id TEXT`)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_role TEXT`)
    db.exec(`ALTER TABLE schedules ADD COLUMN assoc_meta TEXT`)
    db.exec(`ALTER TABLE schedules ADD COLUMN scheduled_at TEXT`)
    // The two indexes that referenced them (v38/v39, verbatim from the old schema.sql) —
    // dropping these first is the whole ordering constraint inside
    // migrateSchedulesV42DropOriginCols: SQLite refuses to drop an indexed column.
    db.exec(`CREATE INDEX idx_schedules_origin ON schedules(origin_type, origin_id) WHERE deleted_at IS NULL`)
    db.exec(`CREATE INDEX idx_schedules_due ON schedules(scheduled_at) WHERE deleted_at IS NULL AND status = 'queued'`)
    // Pre-condition: we really built the old shape.
    expect(scheduleCols(db)).toContain("origin_type")

    applySchema(db)

    const cols = scheduleCols(db)
    for (const col of ENVELOPE_COLS) expect(cols, `schedules.${col} 应被迁移删除`).not.toContain(col)
    expect(cols).toEqual(expect.arrayContaining(["status", "claimed_at"]))
    // The indexes that pointed at the dropped columns are gone too (a dangling index over
    // a missing column would make every later applySchema throw).
    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_schedules%'"
    ).all() as { name: string }[]).map(i => i.name)
    expect(idx).not.toContain("idx_schedules_origin")
    expect(idx).not.toContain("idx_schedules_due")
  })

  it("② 迁移后既有作业行仍可读写（DROP COLUMN 不动数据）", () => {
    db = createTestDb()
    applySchema(db)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config,
        parallel_policy, created_at, updated_at, status, claimed_at)
      VALUES ('v42-job', 'xzf', 'v42', '0 9 * * *', 'UTC', 1, 'workflow', '{}', 'skip', ?, ?, 'running', ?)
    `).run(now, now, now)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'cron'`)

    applySchema(db)

    const row = db.prepare("SELECT id, status, claimed_at FROM schedules WHERE id = 'v42-job'").get() as
      { id: string; status: string; claimed_at: string | null }
    expect(row).toEqual({ id: 'v42-job', status: 'running', claimed_at: now })
  })

  it("re-running applySchema over an already-migrated DB is a no-op", () => {
    db = createTestDb()
    applySchema(db)
    expect(() => applySchema(db)).not.toThrow()
    const cols = scheduleCols(db)
    for (const col of ENVELOPE_COLS) expect(cols).not.toContain(col)
  })
})
