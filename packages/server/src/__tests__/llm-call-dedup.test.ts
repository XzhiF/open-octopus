// packages/server/src/__tests__/llm-call-dedup.test.ts
//
// 写侧兜底去重 (2026-09-21 「∑145.4M 膨胀」事故): 并行票共享会话时代，同一条 LLM
// 消息被多个在跑节点各自缓冲各自 flush → llm_calls 一行变三行，∑/请求数/成本全线
// 膨胀（phase-2 实测 547 行 vs 320 真消息）。insertLlmCallBatch 按
// (execution_id, message_id) 批内 + 跨批去重；null message_id 不去重；
// 跨 execution 同消息（理论上不存在）互不影响。
import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { LlmCallRow } from "../db/types"

let db: Database.Database
let dao: TokenUsageDAO

/** FK 链种子：workspaces → executions → node_executions。 */
function seed(execId: string, neIds: string[]): void {
  const t = new Date().toISOString()
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/w','o',?,?)").run(t, t)
  const insExec = db.prepare("INSERT OR IGNORE INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, org, created_at, updated_at) VALUES (?,'ws-1','0','t.yaml','T','running',?,'o',?,?)")
  insExec.run(execId, t, t, t)
  const insNe = db.prepare("INSERT OR IGNORE INTO node_executions (id, execution_id, node_id, node_type, status, retry_count) VALUES (?,?,'n','agent','running',0)")
  for (const id of neIds) insNe.run(id, execId)
}

function row(over: Partial<LlmCallRow> & { message_id?: string | null }): LlmCallRow {
  return {
    id: crypto.randomUUID(),
    node_execution_id: "e-1-n1",
    execution_id: "e-1",
    turn_index: 1,
    call_index: 0,
    model: "qwen3.8-flash",
    stop_reason: "tool_use",
    timestamp: Date.now(),
    duration_ms: 1000,
    ttft_ms: 100,
    input_tokens: 1,
    output_tokens: 42,
    cache_read_tokens: 100000,
    cache_creation_tokens: 10,
    cost_usd: 0.01,
    org: "o",
    workspace_id: "ws-1",
    workflow_ref: "wf",
    node_id: "n1",
    session_id: "s-1",
    instance_id: "i-1",
    ...over,
  } as LlmCallRow
}

const count = () =>
  (db.prepare("SELECT COUNT(*) c FROM llm_calls").get() as { c: number }).c

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  seed("e-1", ["e-1-n1", "e-1-t02", "e-1-t04", "e-1-t05"])
  seed("e-2", ["e-2-n1"])
  dao = new TokenUsageDAO(db)
})

describe("insertLlmCallBatch — 按 (execution_id, message_id) 去重", () => {
  it("批内重复：一条消息挂三个并行节点 → 只落一行", () => {
    dao.insertLlmCallBatch([
      row({ message_id: "msg-A", node_execution_id: "e-1-t02", node_id: "t02" }),
      row({ message_id: "msg-A", node_execution_id: "e-1-t04", node_id: "t04" }),
      row({ message_id: "msg-A", node_execution_id: "e-1-t05", node_id: "t05" }),
    ])
    expect(count()).toBe(1)
    // 首见行胜出（归属第一个 flush 到的节点）
    const kept = db.prepare("SELECT node_id FROM llm_calls").get() as { node_id: string }
    expect(kept.node_id).toBe("t02")
  })

  it("跨批重复：第二节点稍后 flush 同消息 → 跳过", () => {
    dao.insertLlmCallBatch([row({ message_id: "msg-B" })])
    dao.insertLlmCallBatch([row({ message_id: "msg-B", node_execution_id: "e-1-t04" })])
    expect(count()).toBe(1)
  })

  it("null message_id 不参与去重（逐条保留）", () => {
    dao.insertLlmCallBatch([
      row({ message_id: null }),
      row({ message_id: null }),
    ])
    expect(count()).toBe(2)
  })

  it("跨 execution 互不影响：同消息不同 execution 各留一行", () => {
    dao.insertLlmCallBatch([
      row({ message_id: "msg-C", execution_id: "e-1" }),
      row({ message_id: "msg-C", execution_id: "e-2", node_execution_id: "e-2-n1" }),
    ])
    expect(count()).toBe(2)
  })

  it("混合批：重复 + 新增 + null → 只落应有的", () => {
    dao.insertLlmCallBatch([row({ message_id: "msg-D" })])
    dao.insertLlmCallBatch([
      row({ message_id: "msg-D", node_execution_id: "e-1-t04" }), // 重复 → 跳
      row({ message_id: "msg-E" }),                                 // 新 → 留
      row({ message_id: null }),                                    // null → 留
    ])
    expect(count()).toBe(3)
  })
})
