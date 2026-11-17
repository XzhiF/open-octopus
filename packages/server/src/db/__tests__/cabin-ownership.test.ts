// 舱归属写一次（2026-11-17）：工作区 / 任务 / 会话 / 执行。
//
// 规则：出生在哪个舱就永远属于哪个舱。
//   NULL → 值       允许（认领 / 历史回填）
//   值  → 别的值     ABORT
//   值  → NULL       ABORT
// 这是账本纪律（与 cabin_job_events append-only 同源），所以用 DB trigger 兜底，
// 不依赖每个调用方自觉。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../schema"

let db: Database.Database
const NOW = "2026-11-17T10:00:00.000Z"

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  // executions 的 workspace FK 需要一个宿主行。
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('ws-1', 'ws-1', '/tmp/ws-1', ?, ?)",
  ).run(NOW, NOW)
})

afterEach(() => db.close())

function seedWorkspace(id: string, cabinId: string | null): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, cabin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id, `/tmp/${id}`, cabinId, NOW, NOW)
}

function seedTask(id: string, cabinId: string | null): void {
  db.prepare(
    "INSERT INTO tasks (id, repo_group, name, status, task_spec, cabin_id, created_at, updated_at) VALUES (?, 'repo', ?, 'running', '{}', ?, ?, ?)",
  ).run(id, id, cabinId, NOW, NOW)
}

function seedSession(id: string, cabinId: string | null): void {
  db.prepare(
    "INSERT INTO sessions (id, title, session_type, cabin_id, created_at, updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
  ).run(id, id, cabinId, NOW, NOW)
}

function seedExecution(id: string, cabinId: string | null): void {
  db.prepare(
    "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, cabin_id, created_at, updated_at) VALUES (?, 'ws-1', 'wf', 'WF', ?, ?, ?)",
  ).run(id, cabinId, NOW, NOW)
}

describe.each([
  ["workspaces", seedWorkspace],
  ["tasks", seedTask],
  ["sessions", seedSession],
  ["executions", seedExecution],
] as const)("%s.cabin_id write-once", (table, seed) => {
  it("NULL → 舱 允许（认领）", () => {
    seed("row-1", null)
    expect(() => db.prepare(`UPDATE ${table} SET cabin_id = ? WHERE id = ?`).run("c-1", "row-1")).not.toThrow()
    const row = db.prepare(`SELECT cabin_id FROM ${table} WHERE id = ?`).get("row-1") as { cabin_id: string }
    expect(row.cabin_id).toBe("c-1")
  })

  it("舱 → 别的舱 拒绝", () => {
    seed("row-2", "c-1")
    expect(() => db.prepare(`UPDATE ${table} SET cabin_id = ? WHERE id = ?`).run("c-2", "row-2"))
      .toThrow(/write-once/)
  })

  it("舱 → NULL 拒绝", () => {
    seed("row-3", "c-1")
    expect(() => db.prepare(`UPDATE ${table} SET cabin_id = NULL WHERE id = ?`).run("row-3"))
      .toThrow(/write-once/)
  })

  it("同值重写不拦（幂等写入 / 标题更新同一句里重带 cabin_id）", () => {
    seed("row-4", "c-1")
    expect(() => db.prepare(`UPDATE ${table} SET cabin_id = ? WHERE id = ?`).run("c-1", "row-4")).not.toThrow()
  })
})

describe("executions.cabin_id 新列", () => {
  it("插入时落库、读出可见、默认 NULL", () => {
    seedExecution("exec-cabin", "c-9")
    seedExecution("exec-none", null)
    const rows = db.prepare("SELECT id, cabin_id FROM executions ORDER BY id").all() as Array<{ id: string; cabin_id: string | null }>
    expect(rows).toEqual([
      { id: "exec-cabin", cabin_id: "c-9" },
      { id: "exec-none", cabin_id: null },
    ])
  })
})
