import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"

/**
 * C3 刀② + billing-core-1 票04 —— UsageLedger 唯一写入口 recordNodeUsage 的行为钉：
 * UPSERT 累加 / cost 三态（未知保 NULL，绝不焊 0）/ source 判别。
 * 票04 换源：cost 唯一来源 = BillingService（billing_price_config 配价，KD2/KD4）；
 * SDK 上报价与 shared 价表估算均不再进账。期望值手算：
 *   claude-sonnet-4-5-20250827 配 USD {3,15,3.75,0.3} → usage(100,50): (300+750)/1e6=0.00105；
 *   usage(30,10): (90+150)/1e6=0.00024 → 累加 0.00129；usage(1000,500): (3000+7500)/1e6=0.0105。
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
function priceUsd(modelId: string, p: [number, number, number, number]) {
  new BillingDAO(db).createPrice({
    id: `OW-${modelId}`, vendor: "e2e", model_id: modelId,
    input_unit_price: p[0], output_unit_price: p[1], cache_write_unit_price: p[2], cache_read_unit_price: p[3],
    currency: "USD",
  })
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

describe("recordNodeUsage — cost 来源唯一 = billing_price_config（票04/KD2/KD4）", () => {
  it("配价模型 → 按公式落账；SDK given costUsd 不作账（KD2）", () => {
    priceUsd("claude-sonnet-4-5-20250827", [3, 15, 3.75, 0.3])
    writeRow("r1", { costUsd: 0.042 })
    expect(readRow("r1").cost_usd).toBeCloseTo(0.00105, 12) // (300+750)/1e6，0.042 被忽略
  })

  it("未配价模型 → NULL（价表 miss；shared 内置档兜底已下线，绝不再估算）", () => {
    writeRow("r2", { model: "claude-sonnet-4-20250514", usage: usage(1000, 500) })
    expect(readRow("r2").cost_usd).toBeNull()
  })

  it("未配价且无 given → NULL（不焊 0）", () => {
    writeRow("r2b", { model: "qwen3.7-max", usage: usage(1000, 500) })
    expect(readRow("r2b").cost_usd).toBeNull()
  })

  it("billing_price_config 配价即生效：qwen3.8-flash USD {1,2,0.1,0.5}，1M input → 1.0", () => {
    priceUsd("qwen3.8-flash[1m]", [1, 2, 0.5, 0.1]) // cache_write=0.5、cache_read=0.1
    writeRow("r4", { model: "qwen3.8-flash[1m]", usage: usage(1_000_000, 0) })
    expect(readRow("r4").cost_usd).toBe(1) // 1e6×1/1e6 = 1，cr/cc=0
  })
})

describe("recordNodeUsage — UPSERT 累加与焊接修复", () => {
  it("同 id 重跑：四字段累加，cost 按各自时刻配置累加（0.00105+0.00024=0.00129）", () => {
    priceUsd("claude-sonnet-4-5-20250827", [3, 15, 3.75, 0.3])
    writeRow("r5")
    writeRow("r5", { usage: usage(30, 10) })
    const r = readRow("r5")
    expect(r.input_tokens).toBe(130)
    expect(r.output_tokens).toBe(60)
    expect(r.cost_usd).toBeCloseTo(0.00129, 12)
  })

  it("双 NULL 累加保持 NULL（未配价段绝不焊 0）", () => {
    writeRow("r6", { model: "qwen3.7-max" })
    writeRow("r6", { model: "qwen3.7-max", costUsd: null }) // given 已不作账
    writeRow("r6", { model: "qwen3.7-max" })
    const r = readRow("r6")
    expect(r.cost_usd).toBeNull()
    expect(r.input_tokens).toBe(300) // token 照常累加，只有 cost 保持未知
  })

  it("NULL 行后来配价 → 从已知部分继续累加（此前未定价段的低估由 complete 标志表达）", () => {
    writeRow("r7", { model: "qwen3.7-max" }) // 未配价 → cost NULL
    priceUsd("qwen3.7-max", [50, 0, 0, 0]) // in 单价 50/1M
    writeRow("r7", { model: "qwen3.7-max" }) // usage(100,50) → 100×50/1e6 = 0.005
    expect(readRow("r7").cost_usd).toBeCloseTo(0.005, 12) // NULL + 0.005
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
