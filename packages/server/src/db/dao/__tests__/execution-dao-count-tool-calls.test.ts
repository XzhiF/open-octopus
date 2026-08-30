import { describe, it, expect, beforeEach } from "vitest"
// @ts-expect-error 存量 TS7016（同 execution-dao-merged-turns.test.ts，tsc 配置未含该 types）→ Db 退化别名
import Database from "better-sqlite3"
type Db = any
import { applySchema } from "../../schema"
import { ExecutionDAO } from "../execution-dao"

// countToolCalls：DISTINCT tool_call_id —— raw 三行/一次调用、merged 两行/一次调用 都只计一次。

const EXE = "exec-1"
const NE = "exec-1-tool-test"

function insertEvent(db: Db, order: number, type: string, id: string | null, nodeId = NE) {
  db.prepare(`INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp, tool_call_id, tool_name)
              VALUES (?, ?, 1, ?, '2026-08-30T00:00:00Z', ?, 'Bash')`).run(nodeId, order, type, id)
}

describe("ExecutionDAO.countToolCalls", () => {
  let db: Db
  let dao: ExecutionDAO
  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    const t = new Date().toISOString()
    db.prepare("INSERT INTO workspaces (id,name,path,org,created_at,updated_at) VALUES ('ws','W','/p','o',?,?)").run(t, t)
    db.prepare("INSERT INTO executions (id,workspace_id,parent_id,workflow_ref,workflow_name,status,org,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(EXE, "ws", "0", "w.yaml", "w", "completed", "o", t, t)
    db.prepare("INSERT INTO node_executions (id,execution_id,node_id,node_type,status,started_at) VALUES (?,?,?,?,?,?)").run(NE, EXE, "tool-test", "agent", "completed", t)
    db.prepare("INSERT INTO node_executions (id,execution_id,node_id,node_type,status,started_at) VALUES (?,?,?,?,?,?)").run("exec-1-other", EXE, "other", "agent", "completed", t)
    dao = new ExecutionDAO(db)
  })

  it("raw 三行 + merged 两行 × 同 id → 各算一次；无 id 行不计", () => {
    insertEvent(db, 0, "tool_start", "t1")
    insertEvent(db, 1, "tool_input", "t1")
    insertEvent(db, 2, "tool_result", "t1")
    insertEvent(db, 3, "tool_call", "t2")
    insertEvent(db, 4, "tool_call", "t2")
    insertEvent(db, 5, "tool_result", null)
    expect(dao.countToolCalls(EXE)).toBe(2)
  })

  it("nodeId 过滤只数该节点", () => {
    insertEvent(db, 0, "tool_call", "t1")
    insertEvent(db, 1, "tool_call", "t9", "exec-1-other")
    expect(dao.countToolCalls(EXE, "tool-test")).toBe(1)
    expect(dao.countToolCalls(EXE)).toBe(2)
  })

  it("空 → 0", () => {
    expect(dao.countToolCalls(EXE)).toBe(0)
  })
})
