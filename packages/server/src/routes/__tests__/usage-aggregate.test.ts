// usage-admin-3 票01 —— GET /api/usage/aggregate。
// Verification Method：①植入多源多 model 已知行 → dim=source 响应与同条件手算 GROUP BY
// 逐值相等（四字段、命中率=cacheRead/(input+cacheRead)）②TopN 21 组 → 20+others
// ③参数校验 / 时间窗 / org 过滤各一条。API 级 + DB 交叉，零浏览器。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { createUsageRoutes } from "../usage"
import type { LlmCallRow } from "../../db/types"

let db: Database.Database
let dao: TokenUsageDAO
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new TokenUsageDAO(db)
  app = new Hono()
  app.route("/api/usage", createUsageRoutes(dao))
})

afterEach(() => {
  db.close()
})

function row(over: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    node_execution_id: null,
    execution_id: null,
    turn_index: 1,
    call_index: 0,
    message_id: null,
    model: "claude-test",
    stop_reason: null,
    timestamp: 1700,
    duration_ms: 100,
    ttft_ms: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: null,
    org: "test-org",
    workspace_id: "ws-1",
    workflow_ref: null,
    node_id: null,
    session_id: null,
    instance_id: null,
    source: "chat",
    trace_id: null,
    span_id: null,
    ...over,
  }
}

type AggRow = Record<string, unknown>

async function agg(qs: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`/api/usage/aggregate${qs}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function byKey(body: Record<string, unknown>): Map<string, AggRow> {
  return new Map((body.rows as AggRow[]).map(r => [r.key as string, r]))
}

describe("GET /api/usage/aggregate", () => {
  it("dim=source：植入多源多 model 行 → 与同条件手算 GROUP BY 逐值相等（四字段+命中率）", async () => {
    dao.insertLlmCallBatch([
      // chat 组：input 30 / cr 10 → 命中率 10/(30+10)=0.25；cost 部分定价 0.1+0.2
      row({ source: "chat", model: "m-a", input_tokens: 20, output_tokens: 5, cache_read_tokens: 7, cache_creation_tokens: 3, cost_usd: 0.1 }),
      row({ source: "chat", model: "m-b", input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_creation_tokens: 2, cost_usd: 0.2 }),
      // engine 组：全未定价 → costUsd null（不焊 0）；input 0/cr 0 → 命中率 null（不造假 0%）
      row({ source: "engine", model: "m-a", input_tokens: 0, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null }),
      // aux_suggest 组：全有价
      row({ source: "aux_suggest", input_tokens: 4, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, cost_usd: 0.05 }),
    ])

    const { status, body } = await agg("?dim=source")
    expect(status).toBe(200)
    const g = byKey(body)
    expect([...g.keys()].sort()).toEqual(["aux_suggest", "chat", "engine"])

    expect(g.get("chat")).toMatchObject({
      keyLabel: "chat", calls: 2,
      inputTokens: 30, outputTokens: 10, cacheReadTokens: 10, cacheCreationTokens: 5,
      totalTokens: 55, // 四字段具名和（shared totalTokens 口径）
      costUsd: 0.30000000000000004, costComplete: true,
      cacheHitRate: 10 / 40,
      currency: "USD",
    })
    expect(g.get("engine")).toMatchObject({
      calls: 1, costUsd: null, costComplete: false, cacheHitRate: null,
    })

    // DB 交叉：同条件 GROUP BY 逐值对照
    const sql = db.prepare(`
      SELECT source, COUNT(*) calls,
        SUM(input_tokens) ti, SUM(output_tokens) to2, SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc,
        SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens) tot,
        CASE WHEN COUNT(cost_usd)=0 THEN NULL ELSE SUM(cost_usd) END cost,
        CASE WHEN SUM(input_tokens+cache_read_tokens)>0 THEN CAST(SUM(cache_read_tokens) AS REAL)/SUM(input_tokens+cache_read_tokens) END hr
      FROM llm_calls GROUP BY source`).all() as Array<Record<string, unknown>>
    for (const s of sql) {
      const r = g.get(s.source as string)!
      expect([r.calls, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.totalTokens, r.costUsd, r.cacheHitRate])
        .toEqual([s.calls, s.ti, s.to2, s.cr, s.cc, s.tot, s.cost, s.hr])
    }
  })

  it("dim=day 本地日分组 / dim=model / dim=clone（title 回退 id）", async () => {
    db.prepare(`INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at)
      VALUES ('s-1', 'ws-1', '我的分身', '2026-01-01', '2026-01-01')`).run()
    dao.insertLlmCallBatch([
      row({ id: "d1", source: "chat", session_id: "s-1", timestamp: 1757000000000, input_tokens: 1, output_tokens: 1, cost_usd: 0.1 }),
      row({ id: "d2", source: "chat", session_id: "s-1", timestamp: 1757000000000 + 86400000, input_tokens: 2, output_tokens: 2, cost_usd: 0.2 }), // 次日
      row({ id: "d3", source: "engine", session_id: "s-2", model: "x", timestamp: 1757000000000, input_tokens: 3, output_tokens: 3 }), // 无 title → key 回退 id
    ])

    const days = byKey((await agg("?dim=day")).body)
    expect(days.size).toBe(2)
    for (const k of days.keys()) expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/) // 本地时区日

    const clones = byKey((await agg("?dim=clone")).body)
    expect(clones.get("s-1")!.keyLabel).toBe("我的分身")
    expect(clones.get("s-2")!.keyLabel).toBe("s-2") // 无 session 行/无 title → 回退 id
    expect((clones.get("s-1") as AggRow & { calls: number }).calls).toBe(2)

    const models = byKey((await agg("?dim=model")).body)
    expect(models.get("x")!.calls).toBe(1)
  })

  it("TopN：21 组 → 前 20（cost 降序）+ others 归并逐值正确", async () => {
    // 21 个 source 值不可行（词表 9 值），按 model 分 21 组；cost = i*0.01（i=1..21），
    // 其中最低 cost 组故意未定价混入 NULL 尾
    dao.insertLlmCallBatch(
      Array.from({ length: 21 }, (_, i) =>
        row({ id: `r${i}`, model: `m${i}`, input_tokens: 100, cache_read_tokens: 10, cost_usd: i < 20 ? (i + 1) * 0.01 : null })),
    )

    const { body } = await agg("?dim=model")
    const rows = body.rows as AggRow[]
    expect(rows.length).toBe(21) // 20 + others
    const last = rows[20]
    expect(last.key).toBe("others")
    expect(last.calls).toBe(1) // 仅第 21 组落入 others
    expect(last.totalTokens).toBe(110)
    expect(last.costUsd).toBe(null) // 唯一归并组未定价 → 三态保持 null
    expect(last.cacheHitRate).toBe(10 / 110)

    // cost 降序：NULL 排最后 → m20(未定价) 是唯一被挤出的组
    expect(rows[0].key).toBe("m19")
    expect(rows[19].key).toBe("m0")

    // others 归并交叉：21 组总量 = 各行 totalTokens 之和
    const total = (body.rows as Array<{ totalTokens: number }>).reduce((a, r) => a + r.totalTokens, 0)
    const direct = db.prepare("SELECT SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens) t FROM llm_calls").get() as { t: number }
    expect(total).toBe(direct.t)
  })

  describe("参数校验 / 过滤", () => {
    it("dim 缺失或非词表值 → 400；from/to 非整数 → 400", async () => {
      expect((await agg("")).status).toBe(400)
      expect((await agg("?dim=bogus")).status).toBe(400)
      expect((await agg("?dim=source&from=abc")).status).toBe(400)
      expect((await agg("?dim=source&to=1.5")).status).toBe(400)
    })

    it("from/to 时间窗过滤生效", async () => {
      dao.insertLlmCallBatch([
        row({ id: "lo", timestamp: 100, cost_usd: 1 }),
        row({ id: "hi", timestamp: 900, cost_usd: 2 }),
      ])
      const { body } = await agg("?dim=source&from=500")
      const r = byKey(body).get("chat")!
      expect(r.calls).toBe(1)
      expect(r.costUsd).toBe(2)
    })

    it("org / workspace_id 过滤生效", async () => {
      dao.insertLlmCallBatch([
        row({ id: "a", org: "o1", workspace_id: "w1", input_tokens: 1 }),
        row({ id: "b", org: "o2", workspace_id: "w2", input_tokens: 2 }),
      ])
      expect(byKey((await agg("?dim=source&org=o1")).body).get("chat")!.inputTokens).toBe(1)
      expect(byKey((await agg("?dim=source&workspace_id=w2")).body).get("chat")!.inputTokens).toBe(2)
      expect((await agg("?dim=source&org=nope")).body.rows).toEqual([])
    })
  })
})
