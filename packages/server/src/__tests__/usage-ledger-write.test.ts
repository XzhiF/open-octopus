import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { __setPricingOverlayForTest, __resetPricingOverlayForTest } from "@octopus/shared"

/**
 * C3 刀② —— UsageLedger 唯一写入口 recordNodeUsage 的行为钉：
 * UPSERT 累加 / cost 三态焊接修复（双 NULL 保 NULL，不再焊 0）/
 * 价表兜底对称 / source 判别。
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
  return db.prepare("SELECT * FROM node_token_usages WHERE id = ?").get(id) as {
    input_tokens: number; output_tokens: number; cost_usd: number | null; source: string
  }
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
  __setPricingOverlayForTest({ "qwen3.8-flash": { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 } })
})
afterEach(() => {
  __resetPricingOverlayForTest()
  db.close()
})

describe("recordNodeUsage — cost 三态（C3/Q3/Q4）", () => {
  it("SDK 给了价 → 原样写入", () => {
    writeRow("r1", { costUsd: 0.042 })
    expect(readRow("r1").cost_usd).toBe(0.042)
  })

  it("未定价模型且无 given → NULL（价表 miss，绝不焊 0 / 绝不 sonnet 假价）", () => {
    writeRow("r2", { model: "qwen3.7-max", usage: usage(1000, 500) })
    expect(readRow("r2").cost_usd).toBeNull()
  })

  it("Claude 档无 given → 价表估算兜底（与 llm_calls 写侧对称，终结不对称）", () => {
    // (1000*3 + 500*15)/1e6 = 0.0105
    writeRow("r3", { model: "claude-sonnet-4-20250514", usage: usage(1000, 500) })
    expect(readRow("r3").cost_usd).toBeCloseTo(0.0105, 12)
  })

  it("models.yaml 补价生效：qwen3.8-flash[1m] 按配置价估算", () => {
    writeRow("r4", { model: "qwen3.8-flash[1m]", usage: usage(1_000_000, 0) })
    expect(readRow("r4").cost_usd).toBe(1)
  })
})

describe("recordNodeUsage — UPSERT 累加与焊接修复", () => {
  it("同 id 重跑：四字段累加", () => {
    writeRow("r5", { costUsd: 0.01 })
    writeRow("r5", { usage: usage(30, 10), costUsd: 0.02 })
    const r = readRow("r5")
    expect(r.input_tokens).toBe(130)
    expect(r.output_tokens).toBe(60)
    expect(r.cost_usd).toBeCloseTo(0.03, 12)
  })

  it("双 NULL 累加保持 NULL（旧 COALESCE 焊接把未知变 0 的根除证明）", () => {
    writeRow("r6", { model: "qwen3.7-max" })
    writeRow("r6", { model: "qwen3.7-max", costUsd: null })
    writeRow("r6", { model: "qwen3.7-max" })
    const r = readRow("r6")
    expect(r.cost_usd).toBeNull()
    expect(r.input_tokens).toBe(300) // token 照常累加，只有 cost 保持未知
  })

  it("NULL 行后来有价 → 从已知部分继续累加（此前未定价段的低估由 complete 标志表达）", () => {
    writeRow("r7", { model: "qwen3.7-max" })            // cost NULL
    writeRow("r7", { model: "qwen3.7-max", costUsd: 0.05 }) // NULL+0.05 → 0.05
    expect(readRow("r7").cost_usd).toBeCloseTo(0.05, 12)
  })
})

describe("recordNodeUsage — source 判别（C3/Q8-5，仅诊断用）", () => {
  it("三条路径各写各的 source", () => {
    writeRow("s-node")
    writeRow("s-inter", { source: 'interaction' })
    writeRow("s-harn", { source: 'harness' })
    expect(readRow("s-node").source).toBe("node")
    expect(readRow("s-inter").source).toBe("interaction")
    expect(readRow("s-harn").source).toBe("harness")
  })
})
