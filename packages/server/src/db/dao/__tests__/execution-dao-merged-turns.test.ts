import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { ExecutionDAO } from "../execution-dao"

// P 写侧：replaceMergedEvents 用 llm_calls 时间窗给合并块盖正确 turn_index。
// 旧逻辑 `e.turnIndex ?? 1` 对任意多回合一律落 1（合并块不带 turnIndex）。

const EXE = "exec-1"
const NODE = "tool-test"
const NE = `${EXE}-${NODE}`

function seedCall(turn: number, ts: number) {
  return `INSERT INTO llm_calls (id,node_execution_id,execution_id,turn_index,call_index,timestamp,duration_ms,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens)
          VALUES ('c${turn}','${NE}','${EXE}',${turn},0,${ts},100,6,50,0,0)`
}
// 合并块形态（mergeAgentEvents 产物）：只有 event/startedAt/toolName，无 turnIndex。
const merged = [
  { event: "start", startedAt: "1000", timestamp: "1000" },
  { event: "thinking_block", startedAt: "1000" },
  { event: "tool_call", startedAt: "1100", toolName: "Bash" },
  { event: "agent_event", startedAt: "1200" },
  { event: "thinking_block", startedAt: "2000" },
  { event: "tool_call", startedAt: "2100", toolName: "Read" },
  { event: "thinking_block", startedAt: "3000" },
  { event: "text_block", startedAt: "3200" },
  { event: "end", startedAt: "4000", timestamp: "4000" },
]

describe("replaceMergedEvents — llm_calls 窗口盖轮次", () => {
  let db: Database.Database
  let dao: ExecutionDAO
  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    const t = new Date().toISOString()
    db.prepare("INSERT INTO workspaces (id,name,path,org,created_at,updated_at) VALUES ('ws','W','/p','o',?,?)").run(t, t)
    db.prepare("INSERT INTO executions (id,workspace_id,parent_id,workflow_ref,workflow_name,status,org,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(EXE, "ws", "0", "w.yaml", "w", "completed", "o", t, t)
    db.prepare("INSERT INTO node_executions (id,execution_id,node_id,node_type,status,started_at) VALUES (?,?,?,?,?,?)").run(NE, EXE, NODE, "agent", "completed", t)
    // 3 个真实回合
    db.prepare(seedCall(1, 1000)).run()
    db.prepare(seedCall(2, 2000)).run()
    db.prepare(seedCall(3, 3000)).run()
    dao = new ExecutionDAO(db)
  })

  it("合并块落库后 turn_index 按回合推进（非恒 1）", () => {
    dao.replaceMergedEvents(EXE, NODE, merged)
    const rows = db.prepare(`SELECT event_type, turn_index FROM agent_events WHERE node_execution_id=? ORDER BY event_order`).all(NE) as Array<{ event_type: string; turn_index: number }>
    const byType = (et: string) => rows.filter(r => r.event_type === et).map(r => r.turn_index)
    expect(byType("thinking_block")).toEqual([1, 2, 3])   // 三个 thinking 块分别归 1/2/3 回合
    expect(byType("tool_call")).toEqual([1, 2])           // 工具块顺延其回合
    expect(byType("text_block")).toEqual([3])             // 末回合输出
    expect(new Set(rows.map(r => r.turn_index))).toEqual(new Set([1, 2, 3]))
  })

  it("无 llm_calls（非 agent 节点）→ 回退 turn_index=1，行为不变", () => {
    db.prepare(`DELETE FROM llm_calls WHERE node_execution_id='${NE}'`).run()
    dao.replaceMergedEvents(EXE, NODE, merged)
    const distinct = (db.prepare(`SELECT COUNT(DISTINCT turn_index) c FROM agent_events WHERE node_execution_id=?`).get(NE) as { c: number }).c
    expect(distinct).toBe(1)
  })

  it("harness_* 事件不被覆盖删除", () => {
    db.prepare(`INSERT INTO agent_events (node_execution_id,event_order,turn_index,event_type,timestamp,content,content_length) VALUES (?,999,0,'harness_timeout_cascade',?,'x',1)`).run(NE, 500)
    dao.replaceMergedEvents(EXE, NODE, merged)
    const harness = (db.prepare(`SELECT COUNT(*) c FROM agent_events WHERE node_execution_id=? AND event_type='harness_timeout_cascade'`).get(NE) as { c: number }).c
    expect(harness).toBe(1)
  })
})
