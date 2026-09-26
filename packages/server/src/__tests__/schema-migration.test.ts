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

  it("pins the current version at 49", () => {
    db = createTestDb()
    applySchema(db)
    expect(SCHEMA_VERSION).toBe(49)
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

  it("③ 信封 ROWS 随列一起消失（真机 v40 DB 实测：7 行全部 enabled=1）", () => {
    // Dropping only the columns turns every parked envelope into an ENABLED PHANTOM JOB in
    // the 系统调度 list — the exact inverse of what 票05 promises that page to be. A real
    // developer DB (v40, never booted on 票03) had 7 such rows, three of them at
    // status='draft', a value the narrowed ScheduleStatus no longer admits.
    db = createTestDb()
    applySchema(db)
    const now = new Date().toISOString()
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_type TEXT`)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_id TEXT`)
    db.exec(`ALTER TABLE schedules ADD COLUMN origin_role TEXT`)
    const ins = db.prepare(`
      INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config,
        parallel_policy, created_at, updated_at, status, origin_type, origin_id, origin_role)
      VALUES (?, 'xzf', ?, NULL, 'UTC', 1, 'workflow', '{}', 'skip', ?, ?, ?, ?, ?, ?)`)
    ins.run('env-1', 'task envelope (parked)', now, now, 'draft', 'task', 'task-1', 'primary')
    ins.run('env-2', 'task envelope (aborted)', now, now, 'aborted', 'task', 'task-2', 'primary')
    ins.run('real-cron', 'a real job', now, now, 'queued', 'cron', null, null)
    // The two things an envelope still owns: a bound workspace and its fire history.
    db.prepare(`INSERT INTO workspaces (id, name, org, path, source_schedule_id, created_at, updated_at)
      VALUES ('ws-1', 'ws1', 'xzf', '/tmp/ws1', 'env-1', ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, created_at)
      VALUES ('se-1', 'env-1', 'completed', 'scheduled', ?, '+00:00', 'UTC', ?)`).run(now, now)

    applySchema(db)

    // origin_type is gone, so "which rows survived" is the whole assertion.
    const left = (db.prepare("SELECT id FROM schedules ORDER BY id").all() as { id: string }[]).map(r => r.id)
    expect(left).toEqual(['real-cron'])
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedule_executions").get()).toEqual({ n: 0 })
    // The one fact still worth keeping moved instead of being destroyed.
    expect((db.prepare("SELECT task_id FROM workspaces WHERE id='ws-1'").get() as { task_id: string })
      .task_id).toBe('task-1')
  })

  it("re-running applySchema over an already-migrated DB is a no-op", () => {
    db = createTestDb()
    applySchema(db)
    expect(() => applySchema(db)).not.toThrow()
    const cols = scheduleCols(db)
    for (const col of ENVELOPE_COLS) expect(cols).not.toContain(col)
  })
})

// ── v48: billing NEW-r2 —— 快照账 → 规则账 ────────────────────────────────
describe("Schema v48 — billing 规则账翻转（弃快照列 + 价格窗口 + 模型名归一化）", () => {
  let db: Database.Database
  afterEach(() => { db?.close() })

  const colsOf = (name: string) =>
    (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(c => c.name)

  /** 把当前 DB 接骨回 pre-v48 形状（模拟 PR 分支上跑过旧代码的开发库）。 */
  function graftPreV48Shape() {
    db.exec(`
      ALTER TABLE llm_calls ADD COLUMN cost_usd REAL;
      ALTER TABLE llm_calls ADD COLUMN cost_native REAL;
      ALTER TABLE llm_calls ADD COLUMN cost_currency TEXT;
      ALTER TABLE llm_calls ADD COLUMN price_status TEXT;
    `)
    db.exec("DROP INDEX idx_ntu_composite")
    db.exec("ALTER TABLE node_token_usages ADD COLUMN cost_usd REAL")
    db.exec(`CREATE INDEX idx_ntu_composite ON node_token_usages(node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)`)
    // 价格表回旧形（model_id UNIQUE、无窗口列）+ 造撞车：foo 与 foo[1M] 各一条兜底价
    db.exec("DROP TABLE billing_price_config")
    db.exec(`
      CREATE TABLE billing_price_config (
        id TEXT PRIMARY KEY, vendor TEXT NOT NULL, model_id TEXT NOT NULL UNIQUE,
        input_unit_price REAL NOT NULL, output_unit_price REAL NOT NULL,
        cache_write_unit_price REAL NOT NULL, cache_read_unit_price REAL NOT NULL,
        currency TEXT NOT NULL CHECK (currency IN ('USD','CNY')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `)
    const ins = db.prepare(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price,
      output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, created_at, updated_at)
      VALUES (?, 'v', ?, 1, 2, 3, 4, 'USD', 't0', ?)`)
    ins.run('p-old-keep', 'foo', 't9')       // updated_at 最新 → 并撞时保留
    ins.run('p-old-drop', 'foo[1M]', 't5')   // 归一化后与上撞车，updated_at 更旧 → 删
  }

  function seedCall(id: string, model: string, ts: number) {
    db.prepare(`INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index,
      model, timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path)
      VALUES (?, NULL, NULL, 1, 0, ?, ?, 1, 1000000, 100000, 0, 0, 'unknown')`).run(id, model, ts)
  }

  it("① fresh DB: 无 cost 快照列，价格表带窗口，视图存在", () => {
    db = createTestDb()
    applySchema(db)
    for (const c of ["cost_usd", "cost_native", "cost_currency", "price_status"]) {
      expect(colsOf("llm_calls"), `llm_calls.${c} 不应存在`).not.toContain(c)
    }
    expect(colsOf("node_token_usages")).not.toContain("cost_usd")
    expect(colsOf("billing_price_config")).toEqual(expect.arrayContaining(["valid_from", "valid_to"]))
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='llm_calls_costed'").get()).toBeTruthy()
  })

  it("② 接骨 DB: 迁移删快照列、价格表窗口化、旧价行平移为兜底价", () => {
    db = createTestDb()
    applySchema(db)
    graftPreV48Shape()
    expect(colsOf("llm_calls")).toContain("cost_usd") // pre-condition

    applySchema(db)

    for (const c of ["cost_usd", "cost_native", "cost_currency", "price_status"]) expect(colsOf("llm_calls")).not.toContain(c)
    expect(colsOf("node_token_usages")).not.toContain("cost_usd")
    expect(colsOf("billing_price_config")).toEqual(expect.arrayContaining(["valid_from", "valid_to"]))
    const kept = db.prepare("SELECT * FROM billing_price_config WHERE id = 'p-old-keep'").get() as { model_id: string; valid_from: number | null; valid_to: number | null }
    expect(kept.valid_from).toBeNull(); expect(kept.valid_to).toBeNull() // 存量价 → 全时段兜底
    // 复合索引已按无 cost 形状重建
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ntu_composite'").get()).toBeTruthy()
  })

  it("③ 模型名归一化洗历史行 + 兜底价并撞（保留 updated_at 最新）", () => {
    db = createTestDb()
    applySchema(db)
    graftPreV48Shape()
    seedCall('c1', 'foo[1M]', 1000)
    seedCall('c2', 'foo[1M]][1M]', 2000)
    seedCall('c3', 'bar[1M]', 3000)

    applySchema(db)

    const models = (db.prepare("SELECT DISTINCT model FROM llm_calls ORDER BY model").all() as { model: string }[]).map(r => r.model)
    expect(models).toEqual(["bar", "foo"])
    // foo[1M] 与 foo 两条兜底价并撞只剩一条（updated_at 最新 = p-old-keep）
    const fooRows = db.prepare("SELECT id FROM billing_price_config WHERE model_id='foo'").all() as { id: string }[]
    expect(fooRows.map(r => r.id)).toEqual(["p-old-keep"])
    // 归一化后历史账行立即按兜底价出钱（视图派生）：1M×1 + 100k×2 = 1.2 USD
    const cost = db.prepare("SELECT cost_usd FROM llm_calls_costed WHERE id='c2'").get() as { cost_usd: number }
    expect(cost.cost_usd).toBeCloseTo(1.2, 9)
    // 幂等：再跑一遍零变化
    expect(() => applySchema(db)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) n FROM llm_calls_costed").get() as { n: number }).n).toBe(3)
  })

  it("④ 无价格表的极老库不炸（fresh 前置跳过）", () => {
    db = createTestDb()
    expect(() => applySchema(db)).not.toThrow() // createTestDb 空库上直接跑
  })
})
