// packages/server/src/db/dao/__tests__/execution-link-dao.test.ts
//
// 2026-11-03 消耗口径：验收规划执行 task_id=NULL，归属靠 execution_links。
// 存量行没有 link —— backfill 从未被覆盖的 input_values 里反查任务回填，幂等。
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { ExecutionLinkDAO } from "../execution-link-dao"

const NOW = "2026-11-03T05:00:00.000Z"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
    VALUES ('ws-1', 'ws', 'org', '/tmp/ws', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, created_at, updated_at)
    VALUES ('s-main', 'org', '主对话', NULL, 'main', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES ('t-1', 'org', '任务', 'running', 's-main', '{"format":"v4"}', ?, ?, 'ws-1')
  `).run(NOW, NOW)
  return db
}

function insertAcceptanceExec(
  db: Database.Database,
  id: string,
  opts: { triggeredBy?: string; inputValues?: string } = {},
): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status,
      triggered_by, input_values, created_at, updated_at)
    VALUES (?, 'ws-1', '0', 'built-in/acceptance-plan', 'acceptance-plan', 'completed', ?, ?, ?, ?)
  `).run(id, opts.triggeredBy ?? "acceptance-plan", opts.inputValues ?? "{}", NOW, NOW)
}

describe("ExecutionLinkDAO", () => {
  let db: Database.Database
  let dao: ExecutionLinkDAO

  beforeEach(() => {
    db = newDb()
    dao = new ExecutionLinkDAO(db)
  })

  it("backfill: 从 input_values 反查任务/坐标，登记 task_aux；重复跑不重复插入", () => {
    insertAcceptanceExec(db, "e-plan", {
      inputValues: JSON.stringify({ task_id: "t-1", phase_index: "1", round_index: "2" }),
    })
    expect(dao.backfillAcceptancePlanLinks()).toBe(1)
    expect(dao.backfillAcceptancePlanLinks()).toBe(0)

    expect(dao.findByExecution("e-plan")).toMatchObject({
      execution_id: "e-plan",
      session_id: "s-main",
      task_id: "t-1",
      kind: "task_aux",
      phase_index: 1,
      round_index: 2,
    })
    expect(dao.listTaskUsageExecutions("t-1").map((e) => e.id)).toEqual(["e-plan"])
    expect(dao.executionIdsByTask(["t-1"]).get("t-1")).toEqual(["e-plan"])
  })

  it("backfill 跳过非验收规划行与坏 JSON；已登记的 link 不被覆盖", () => {
    insertAcceptanceExec(db, "e-other", { triggeredBy: "manual" })
    insertAcceptanceExec(db, "e-bad", { inputValues: "{not-json" })
    insertAcceptanceExec(db, "e-plan", {
      inputValues: JSON.stringify({ task_id: "t-1", phase_index: "1", round_index: "1" }),
    })
    dao.link({
      executionId: "e-plan",
      sessionId: "s-main",
      taskId: "t-1",
      kind: "task_aux",
      phaseIndex: 1,
      roundIndex: 9,
    })

    expect(dao.backfillAcceptancePlanLinks()).toBe(0)
    expect(dao.findByExecution("e-other")).toBeUndefined()
    expect(dao.findByExecution("e-bad")).toBeUndefined()
    // INSERT OR IGNORE：已有行的 round_index 保留（9），不被回填覆盖。
    expect(dao.findByExecution("e-plan")?.round_index).toBe(9)
  })

  it("link 是 upsert：同一执行重复登记只更新归属", () => {
    insertAcceptanceExec(db, "e-plan")
    dao.link({ executionId: "e-plan", sessionId: "s-main", taskId: "t-1", kind: "task_aux" })
    dao.link({ executionId: "e-plan", sessionId: "s-main", taskId: "t-1", kind: "task_aux", phaseIndex: 2, roundIndex: 3 })
    const rows = db.prepare("SELECT * FROM execution_links WHERE execution_id = 'e-plan'").all()
    expect(rows).toHaveLength(1)
    expect(dao.findByExecution("e-plan")).toMatchObject({ phase_index: 2, round_index: 3 })
  })
})
