import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"

/**
 * C3 刀② + billing NEW-r2 —— UsageLedger 唯一写入口 recordNodeUsage 的行为钉：
 * UPSERT 累加（**只累 token**）/ source 判别 / 模型名归一化。
 * NEW-r2：node_token_usages 的 cost_usd 快照列已删 —— 本表是纯 token 账，
 * 节点/执行费用从 llm_calls 查询时派生（见 billing-wiring / 视图）。
 * costUsd 入参仅为调用方兼容保留（@deprecated），传什么都不许影响落库。
 */
let db: Database.Database
let dao: TokenUsageDAO

const usage = (i: number, o: number, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc })
const now = () => new Date().toISOString()

function writeRow(id: string, over: Partial<Parameters<TokenUsageDAO['recordNodeUsage']>[0]> = {}) {
  dao.recordNodeUsage({
    id, nodeExecutionId: "ne-1", model: "claude-sonnet-4-5-20250827",
    usage: usage(100, 50), source: 'node', createdAt: now(), ...over,
  })
}
function readRow(id: string) {
  return db.prepare("SELECT * FROM node_token_usages WHERE id = ?").get(id) as Record<string, unknown>
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  // FK 链：workspaces → executions → node_executions（ne-1）
  const t = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/w','o',?,?)").run(t, t)
  db.prepare("INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at) VALUES ('e-1','ws-1','0','t.yaml','T','completed',?,?,?,?,?)").run(t, t, 'o', t, t)
  db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('ne-1','e-1','n1','agent','completed',0,1,?,?)").run(t, t)
  dao = new TokenUsageDAO(db)
})
afterEach(() => {
  db.close()
})

describe("NEW-r2 表形状 —— ntu 是纯 token 账", () => {
  it("PRAGMA：node_token_usages 无 cost_usd 列", () => {
    const cols = db.prepare("PRAGMA table_info(node_token_usages)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).not.toContain("cost_usd")
    expect(cols.map(c => c.name).sort()).toEqual([
      "cache_creation_tokens", "cache_read_tokens", "created_at", "id", "input_tokens",
      "model", "node_execution_id", "output_tokens", "source",
    ])
  })

  it("落库行 = 事实列，无钱；costUsd 入参被彻底忽略（deprecated 兼容参）", () => {
    writeRow("p1", { costUsd: 42.5, usage: usage(10, 5) })
    expect(readRow("p1")).toEqual({
      id: "p1", node_execution_id: "ne-1", model: "claude-sonnet-4-5-20250827",
      input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0,
      source: "node", created_at: expect.any(String),
    })
  })

  it("model 落库前归一化（normalizeModelId，与 llm_calls 同一规范名空间）", () => {
    writeRow("p2", { model: "qwen3.8-flash[1M]" })
    expect(readRow("p2").model).toBe("qwen3.8-flash")
    writeRow("p3", { model: "x[1M]][1M]" })
    expect(readRow("p3").model).toBe("x")
  })
})

describe("recordNodeUsage — UPSERT 累加（只累 token）", () => {
  it("同 id 重跑：四字段累加", () => {
    writeRow("r5")
    writeRow("r5", { usage: usage(30, 10, 4, 2) })
    const r = readRow("r5") as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
    expect(r.input_tokens).toBe(130)
    expect(r.output_tokens).toBe(60)
    expect(r.cache_read_tokens).toBe(4)
    expect(r.cache_creation_tokens).toBe(2)
  })

  it("多次累加（三轮）token 线性增长，行仍一条", () => {
    writeRow("r6")
    writeRow("r6")
    writeRow("r6")
    const r = readRow("r6") as { input_tokens: number; output_tokens: number }
    expect(r.input_tokens).toBe(300)
    expect(r.output_tokens).toBe(150)
    expect((db.prepare("SELECT COUNT(*) c FROM node_token_usages WHERE id='r6'").get() as { c: number }).c).toBe(1)
  })
})

describe("recordNodeUsage — source 判别（C3/Q8-5，仅诊断用）", () => {
  it("三条路径各写各的 source", () => {
    writeRow("s-node")
    writeRow("s-inter", { source: 'interaction' })
    writeRow("s-harn", { source: 'harness' })
    expect(readRow("s-node")).toMatchObject({ source: "node" })
    expect(readRow("s-inter")).toMatchObject({ source: "interaction" })
    expect(readRow("s-harn")).toMatchObject({ source: "harness" })
  })
})
