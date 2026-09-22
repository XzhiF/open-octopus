import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { applySchema } from "../../../db/schema"
import { AgentSessionDAO } from "../../../db/dao"
import { TokenUsageDAO } from "../../../db/dao/token-usage-dao"
import { BillingDAO } from "../../../db/dao/billing-dao"
import {
  SessionCompressService,
  type CompressionLlmCall,
  type CompressionLlmResult,
} from "../session-compress-service"

/**
 * billing-coverage-2 票04 + billing NEW-r2 —— session 压缩入账（US3 / KD24）。
 * 压缩调用的 result chunk 真值经票01 共用 helper 入账：source_path='session_compress'，
 * 归属被压缩会话（session_id + org 如实，node/execution 不可得 → NULL）。
 * NEW-r2：llm_calls 行 = 纯事实，钱不落账本 —— cost 一律查 llm_calls_costed 视图派生
 * （兜底价配在 beforeEach → 回算全部历史）。
 * tokenEstimate 只留阈值/预算判断（needsCompression / fitsWithinBudget），永不进账。
 * 失败路径不落半行；无 LLM seam 时保持原确定性摘要行为（不回退票前语义 = 无行）。
 *
 * 视图 cost 手算：量 in=1234/out=99/cr=7/cc=3，USD {2,10,2.5,0.5}：
 *   1234×2 + 99×10 + 3×2.5 + 7×0.5 = 2468+990+7.5+3.5 = 3469 → /1e6 = 0.003469。
 */
const LLM_USAGE = { inputTokens: 1234, outputTokens: 99, cacheReadTokens: 7, cacheCreationTokens: 3 }

let db: Database.Database
let dao: AgentSessionDAO
let tokenDao: TokenUsageDAO
const ORG = "t04-org"

function seedSession(messageCount: number): string {
  const sid = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, ?, 'E2E_TEST_t04', 'main', 1, 0, ?, ?)
  `).run(sid, ORG, now, now)
  const ins = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (let i = 0; i < messageCount; i++) {
    ins.run(`m-${sid}-${i}`, sid, i % 2 === 0 ? "user" : "assistant", `第${i}条消息，内容是给 add billing 的实现细节说明，完成压缩验证。已记录在案。`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:0${i % 9}.000Z`)
  }
  return sid
}

function service(llm?: CompressionLlmCall): SessionCompressService {
  return new SessionCompressService(ORG, dao, { threshold_messages: 5, retain_recent: 2 }, {
    llm, tokenDao,
  })
}

function ledgerRows(sid: string) {
  return db.prepare(
    "SELECT * FROM llm_calls WHERE source_path = 'session_compress' AND session_id = ?",
  ).all(sid) as Array<Record<string, unknown>>
}

/** NEW-r2：钱不落账本 —— 按行 id 查视图派生 cost_usd（无价 → NULL，不焊 0）。 */
function viewCost(id: unknown): number | null {
  const r = db.prepare("SELECT cost_usd FROM llm_calls_costed WHERE id = ?").get(String(id)) as { cost_usd: number | null } | undefined
  if (!r) throw new Error(`视图行缺失: id=${String(id)}`)
  return r.cost_usd
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new AgentSessionDAO(db)
  tokenDao = new TokenUsageDAO(db)
  new BillingDAO(db).createPrice({
    id: "OC-t04", vendor: "e2e", model_id: "E2E_TEST_comp",
    input_unit_price: 2, output_unit_price: 10, cache_write_unit_price: 2.5, cache_read_unit_price: 0.5,
    currency: "USD",
  })
})

describe("v47 迁移：老库 llm_calls（NOT NULL 归属列）blue-green rebuild", () => {
  it("重建后列可空、数据保全、NULL 归属可插、二次 applySchema 幂等", () => {
    const old = new Database(":memory:")
    old.exec(`
      CREATE TABLE llm_calls (
        id TEXT PRIMARY KEY,
        node_execution_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        call_index INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        org TEXT,
        session_id TEXT
      )
    `)
    old.prepare(`INSERT INTO llm_calls VALUES ('x1', 'ne1', 'ex1', 1, 0, 1, 1, 'o', 's1')`).run()

    applySchema(old)

    const cols = old.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string; notnull: number }>
    expect(cols.find(c => c.name === "node_execution_id")?.notnull).toBe(0)
    expect(cols.find(c => c.name === "execution_id")?.notnull).toBe(0)
    // 原行逐值保全（rebuild 拷贝不丢账）
    expect(old.prepare("SELECT * FROM llm_calls WHERE id = 'x1'").get()).toMatchObject({
      node_execution_id: "ne1", execution_id: "ex1", turn_index: 1, org: "o", session_id: "s1",
    })
    // NULL 归属（session 级）自此可插
    old.prepare(`
      INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, source_path, session_id)
      VALUES ('x2', NULL, NULL, 0, 0, 2, 2, 'session_compress', 's1')
    `).run()

    applySchema(old) // 幂等：二次跑不再 rebuild、不复制行
    expect((old.prepare("SELECT COUNT(*) c FROM llm_calls").get() as { c: number }).c).toBe(2)
    old.close()
  })
})

describe("session 压缩入账（票04/KD24/US3）", () => {
  it("LLM seam 成功 → 恰一条 session_compress 行，token=厂商真值，cost 手算一致，归属会话如实", async () => {
    const sid = seedSession(8)
    const llm: CompressionLlmCall = async () =>
      ({ text: "【LLM 摘要】压缩了早期话题。", model: "E2E_TEST_comp", usage: LLM_USAGE } satisfies CompressionLlmResult)

    const result = await service(llm).compressSession(sid)

    expect(result.compressed_count).toBe(6)
    const rows = ledgerRows(sid)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r).toMatchObject({
      source_path: "session_compress",
      session_id: sid,
      org: ORG,
      node_execution_id: null, execution_id: null, // 归属可得性如实（无执行链路的压缩）
      model: "E2E_TEST_comp",
      input_tokens: 1234, output_tokens: 99, cache_read_tokens: 7, cache_creation_tokens: 3,
    })
    expect(r).not.toHaveProperty("cost_usd") // NEW-r2：行 = 纯事实，无快照列
    // LLM 摘要进正文（非估算路径）
    expect(result.summary_content).toContain("LLM 摘要")
    // 钱 = 视图派生；兜底价命中 → 手算 3469/1e6
    expect(viewCost(r.id)).toBeCloseTo(0.003469, 12)
  })

  it("入账值 = chunk 真值 ≠ tokenEstimate（证明非抄估算，AC2）", async () => {
    const sid = seedSession(8)
    const llm: CompressionLlmCall = async () =>
      ({ text: "s", model: "E2E_TEST_comp", usage: LLM_USAGE } satisfies CompressionLlmResult)
    await service(llm).compressSession(sid)
    const r = ledgerRows(sid)[0]
    expect(r.input_tokens).toBe(1234) // 厂商真值逐字段相等（来源 = 注入 seam 的 chunk usage）
    expect(r.output_tokens).toBe(99)
    const estimate = service().getCompressedContext(sid).total_tokens_estimate // 估算仍在预算口径
    expect(estimate).toBeGreaterThan(0)
    expect([1234, 99, 1234 + 99 + 7 + 3]).not.toContain(estimate) // 换数据也不巧合
  })

  it("LLM seam 抛错 → 不落半行，压缩走确定性摘要回退（AC3）", async () => {
    const sid = seedSession(8)
    const llm: CompressionLlmCall = async () => { throw new Error("provider down") }
    const result = await service(llm).compressSession(sid)
    expect(result.compressed_count).toBe(6)
    expect(ledgerRows(sid)).toHaveLength(0)
    expect(result.summary_content).toContain("会话摘要") // 回退到既有 extraction 摘要
  })

  it("LLM seam 返回 null / 缺 usage → 不落半行，回退摘要", async () => {
    const s1 = seedSession(8)
    await service(async () => null).compressSession(s1)
    expect(ledgerRows(s1)).toHaveLength(0)

    const s2 = seedSession(8)
    await service(async () => ({ text: "t", model: null, usage: undefined }) as unknown as CompressionLlmResult).compressSession(s2)
    expect(ledgerRows(s2)).toHaveLength(0)
  })

  it("未配价模型 → 行仍入账，视图 cost NULL（NEW-r2：unpriced 不焊 0、不估算）", async () => {
    const sid = seedSession(8)
    const llm: CompressionLlmCall = async () =>
      ({ text: "s", model: "E2E_TEST_noprice-t04", usage: LLM_USAGE } satisfies CompressionLlmResult)
    await service(llm).compressSession(sid)
    const rows = ledgerRows(sid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: "E2E_TEST_noprice-t04",
      input_tokens: 1234,
    })
    expect(viewCost(rows[0].id)).toBeNull()
  })

  it("消息数不足以压缩 → 零调用零行（不造数）", async () => {
    const sid = seedSession(2)
    let called = 0
    const llm: CompressionLlmCall = async () => { called++; return { text: "s", model: "E2E_TEST_comp", usage: LLM_USAGE } }
    const result = await service(llm).compressSession(sid)
    expect(result.compressed_count).toBe(0)
    expect(called).toBe(0)
    expect(ledgerRows(sid)).toHaveLength(0)
  })

  it("无 seam（构造兼容）→ 行为与改造前等价：确定性摘要，无 llm_calls 行", async () => {
    const sid = seedSession(8)
    const svc = new SessionCompressService(ORG, dao, { threshold_messages: 5, retain_recent: 2 })
    const result = await svc.compressSession(sid)
    expect(result.compressed_count).toBe(6)
    expect(result.summary_content).toContain("会话摘要")
    expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
  })
})
