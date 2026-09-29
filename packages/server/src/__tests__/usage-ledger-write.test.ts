// P1 B4 票2B-1：TokenUsageDAO 已迁 postgres.js —— ntu 唯一写入口行为钉切 PG 随机库
// （harness-dao 姿势）。created_at 的 timestamptz(Date) 出口经 iso 归一回旧字符串契约
// （= DAO 出口同投影）；COUNT bigint-string → ::int。用例语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

/**
 * C3 刀② + billing NEW-r2 —— UsageLedger 唯一写入口 recordNodeUsage 的行为钉：
 * UPSERT 累加（**只累 token**）/ source 判别 / 模型名归一化。
 * NEW-r2：node_token_usages 的 cost_usd 快照列已删 —— 本表是纯 token 账，
 * 节点/执行费用从 llm_calls 查询时派生（见 billing-wiring / 视图）。
 * costUsd 入参仅为调用方兼容保留（@deprecated），传什么都不许影响落库。
 */
let pg: PgFixture
let dao: TokenUsageDAO

const usage = (i: number, o: number, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc })
const now = () => new Date().toISOString()

async function writeRow(id: string, over: Partial<Parameters<TokenUsageDAO['recordNodeUsage']>[0]> = {}) {
  await dao.recordNodeUsage({
    id, nodeExecutionId: "ne-1", model: "claude-sonnet-4-5-20250827",
    usage: usage(100, 50), source: 'node', createdAt: now(), ...over,
  })
}
async function readRow(id: string): Promise<Record<string, unknown>> {
  const rows = await pg.sql`SELECT * FROM node_token_usages WHERE id = ${id}`
  const r = { ...(rows[0] as Record<string, unknown>) }
  if (r.created_at instanceof Date) r.created_at = r.created_at.toISOString()
  return r
}

beforeEach(async () => {
  pg = await setupPgSchema()
  // FK 链：workspaces → executions → node_executions（ne-1）
  const t = new Date().toISOString()
  await pg.sql.unsafe("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1','WS','/tmp/w','o',$1,$2)", [t, t])
  await pg.sql.unsafe("INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at) VALUES ('e-1','ws-1','0','t.yaml','T','completed',$1,$2,'o',$3,$4)", [t, t, t, t])
  await pg.sql.unsafe("INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at) VALUES ('ne-1','e-1','n1','agent','completed',0,1,$1,$2)", [t, t])
  dao = new TokenUsageDAO(pg.sql)
})
afterEach(async () => {
  await pg.close()
})

describePg("NEW-r2 表形状 —— ntu 是纯 token 账", () => {
  it("PRAGMA：node_token_usages 无 cost_usd 列", async () => {
    const cols = await pg.sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'node_token_usages'`
    const names = cols.map(c => c.column_name)
    expect(names).not.toContain("cost_usd")
    expect([...names].sort()).toEqual([
      "cache_creation_tokens", "cache_read_tokens", "created_at", "id", "input_tokens",
      "model", "node_execution_id", "output_tokens", "source",
    ])
  })

  it("落库行 = 事实列，无钱；costUsd 入参被彻底忽略（deprecated 兼容参）", async () => {
    await writeRow("p1", { costUsd: 42.5, usage: usage(10, 5) })
    expect(await readRow("p1")).toEqual({
      id: "p1", node_execution_id: "ne-1", model: "claude-sonnet-4-5-20250827",
      input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0,
      source: "node", created_at: expect.any(String),
    })
  })

  it("model 落库前归一化（normalizeModelId，与 llm_calls 同一规范名空间）", async () => {
    await writeRow("p2", { model: "qwen3.8-flash[1M]" })
    expect((await readRow("p2")).model).toBe("qwen3.8-flash")
    await writeRow("p3", { model: "x[1M]][1M]" })
    expect((await readRow("p3")).model).toBe("x")
  })
})

describePg("recordNodeUsage — UPSERT 累加（只累 token）", () => {
  it("同 id 重跑：四字段累加", async () => {
    await writeRow("r5")
    await writeRow("r5", { usage: usage(30, 10, 4, 2) })
    const r = await readRow("r5") as { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
    expect(r.input_tokens).toBe(130)
    expect(r.output_tokens).toBe(60)
    expect(r.cache_read_tokens).toBe(4)
    expect(r.cache_creation_tokens).toBe(2)
  })

  it("多次累加（三轮）token 线性增长，行仍一条", async () => {
    await writeRow("r6")
    await writeRow("r6")
    await writeRow("r6")
    const r = await readRow("r6") as { input_tokens: number; output_tokens: number }
    expect(r.input_tokens).toBe(300)
    expect(r.output_tokens).toBe(150)
    expect(Number((await pg.sql`SELECT COUNT(*) c FROM node_token_usages WHERE id='r6'`)[0].c)).toBe(1)
  })
})

describePg("recordNodeUsage — source 判别（C3/Q8-5，仅诊断用）", () => {
  it("三条路径各写各的 source", async () => {
    await writeRow("s-node")
    await writeRow("s-inter", { source: 'interaction' })
    await writeRow("s-harn", { source: 'harness' })
    expect(await readRow("s-node")).toMatchObject({ source: "node" })
    expect(await readRow("s-inter")).toMatchObject({ source: "interaction" })
    expect(await readRow("s-harn")).toMatchObject({ source: "harness" })
  })
})
