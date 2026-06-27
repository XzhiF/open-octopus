import { describe, it, expect, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema, SCHEMA_VERSION } from "../db/schema"

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  return db
}

describe("DB Schema", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  it("creates all 32 tables", () => {
    db = createTestDb()
    applySchema(db)
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name"
    ).all() as { name: string }[]
    const names = rows.map(r => r.name).sort()
    expect(names).toEqual([
      // Core tables (20)
      "agent_events", "branch_executions", "chat_messages", "chat_sessions",
      "clones", "evolution_log", "execution_archive", "execution_summaries", "executions",
      "experience_index", "experiences",
      "llm_calls", "messages", "node_edges", "node_executions", "node_token_usages",
      "optimization_suggestions", "orgs", "pipeline_state", "reports", "safety_events",
      "schedule_audit_logs", "schedule_executions", "schedule_workspaces",
      "scheduled_job_executions", "scheduler_audit_logs", "scheduler_state", "schedules",
      "sessions", "workspace_archive", "workspaces",
    ])
  })

  it("creates all indexes (core + agent)", () => {
    db = createTestDb()
    applySchema(db)
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[]
    // 38 core + 23 agent + 17 archive indexes = 78
    expect(rows.length).toBe(78)
  })

  it("workspaces table has correct columns", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining([
      "id", "name", "org", "status", "path", "created_at", "updated_at",
      "source", "source_schedule_id",
    ]))
  })

  it("executions table has all spec columns", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(executions)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining([
      "id", "workspace_id", "parent_id", "child_index",
      "workflow_ref", "workflow_name", "name", "status", "gate_status",
      "rollback", "rollback_on_error", "input_values", "var_pool",
      "progress", "triggered_by", "node_type", "branch",
      "start_commit_id", "end_commit_id",
      "instance_id", "global_session_id", "retry_count", "pending_hooks",
      "approval_metadata", "resume_attempts", "pipeline_config",
      "chain_retry_count", "preset_inputs",
      "org", "created_at", "updated_at",
    ]))
  })

  it("enforces foreign keys on node_executions", () => {
    db = createTestDb()
    applySchema(db)
    expect(() => {
      db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, ?, ?, ?)")
        .run("ne-1", "nonexistent", "pull", "bash", "pending")
    }).toThrow()
  })

  it("sets schema version via user_version PRAGMA", () => {
    db = createTestDb()
    applySchema(db)
    const rows = db.pragma("user_version") as Array<{ user_version: number }>
    expect(rows[0].user_version).toBe(SCHEMA_VERSION)
  })

  it("is idempotent", () => {
    db = createTestDb()
    applySchema(db)
    applySchema(db)
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    expect(rows.length).toBeGreaterThan(0)
    const versionRows = db.pragma("user_version") as Array<{ user_version: number }>
    expect(versionRows[0].user_version).toBe(SCHEMA_VERSION)
  })

  it("creates orgs table with correct columns", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(orgs)").all() as { name: string; pk: number }[]
    const names = cols.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(["id", "name", "path", "created_at"]))
  })

  it("seeds xzf org on first migration", () => {
    db = createTestDb()
    applySchema(db)
    const row = db.prepare("SELECT * FROM orgs WHERE name = ?").get("xzf") as { name: string; path: string } | undefined
    expect(row).toBeDefined()
    expect(row!.path).toContain("xzf")
  })

  it("org name is unique", () => {
    db = createTestDb()
    applySchema(db)
    expect(() => {
      db.prepare("INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?)").run("xzf", "/tmp", new Date().toISOString())
    }).toThrow()
  })

  it("id is auto-increment", () => {
    db = createTestDb()
    applySchema(db)
    const row = db.prepare("SELECT id FROM orgs WHERE name = 'xzf'").get() as { id: number }
    expect(row.id).toBeGreaterThan(0)
  })

  it("chat_sessions has provider and provider_session_id columns (v4)", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining(["provider", "provider_session_id"]))
  })

  it("executions.parent_id is NOT NULL DEFAULT '0'", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(executions)").all() as { name: string; notnull: number; dflt_value: string | null }[]
    const parentIdCol = cols.find(c => c.name === "parent_id")
    expect(parentIdCol).toBeDefined()
    expect(parentIdCol!.notnull).toBe(1)
    expect(parentIdCol!.dflt_value).toBe("'0'")
  })

  it("executions has node_type/branch/start_commit_id/end_commit_id columns", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(executions)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining([
      "node_type", "branch", "start_commit_id", "end_commit_id", "name",
    ]))
  })
})

describe("Schema v17 — Pipeline support", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  it("adds retry_count and last_retry_at to node_executions", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(node_executions)").all() as Array<{ name: string }>
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain("retry_count")
    expect(colNames).toContain("last_retry_at")
  })

  it("adds resume_attempts and pipeline_config to executions", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain("resume_attempts")
    expect(colNames).toContain("pipeline_config")
  })

  it("does not create checkpoints table (filesystem storage)", () => {
    db = createTestDb()
    applySchema(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'").all()
    expect(tables).toHaveLength(0)
  })

  it("does not create checkpoint index (filesystem storage)", () => {
    db = createTestDb()
    applySchema(db)
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_checkpoints_execution'").all()
    expect(indexes).toHaveLength(0)
  })

  it("default values are correct", () => {
    db = createTestDb()
    applySchema(db)
    const wsId = "ws-test"
    db.prepare("INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(wsId, "test", "test", "/tmp", "2024-01-01", "2024-01-01")
    const execId = "exec-test"
    db.prepare("INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(execId, wsId, "test.yaml", "test", "pending", "test", "2024-01-01", "2024-01-01")
    const row = db.prepare("SELECT resume_attempts, pipeline_config FROM executions WHERE id = ?").get(execId) as { resume_attempts: number; pipeline_config: string }
    expect(row.resume_attempts).toBe(0)
    expect(row.pipeline_config).toBe("{}")
  })

  it("execution_summaries table has correct columns and indexes", () => {
    db = createTestDb()
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(execution_summaries)").all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(expect.arrayContaining([
      "id", "execution_id", "workflow_ref", "workspace_id",
      "summary", "status", "duration_ms", "failed_nodes", "created_at",
    ]))
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='execution_summaries'"
    ).all() as { name: string }[]
    const idxNames = indexes.map(i => i.name)
    expect(idxNames).toContain("idx_summaries_workflow")
    expect(idxNames).toContain("idx_summaries_created")
  })
})
