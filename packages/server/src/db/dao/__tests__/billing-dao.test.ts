// 01 · 计费数据层单测（billing NEW-r2：快照账 → 规则账）
// Seam A: PG schema — 新库全量建表（llm_calls 无 cost 快照列 + llm_calls_costed 视图）
//         + v48 老 SQLite 库迁移（弃列 / 价格表窗口化 / 模型名归一 —— 该例仍走
//           better-sqlite3 自带 applySchema，纯模块测试不碰 fixture）。
// Seam B: BillingDAO — 规则表 CRUD（窗口校验四类拒绝码）/ getPriceAtModel 命中序 /
//         listPrices 排序 / previewCost 试算 / settings get-set。
// 期望值全部手写在测试里（独立真相源，非从实现推导）。
//
// P1 B4 票2B-1：BillingDAO 已迁 postgres.js（BasePgDAO）—— 本文件切到 PG 随机测试库
// （harness-dao.test.ts 同款姿势，每例一座）。Schema 断言从 sqlite_master/PRAGMA 投影到
// PG 目录表（pg_tables / information_schema），约束断言吃 PG 报错原文
// （ux_price_catchall / check constraint）—— 语义逐条对应，条数不变。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { applyPgSchema } from "../../pg/migrate"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"
import {
  BillingDAO,
  BillingPriceValidationError,
  type BillingPriceErrorCode,
  type BillingPriceRow,
} from "../billing-dao"

let pg: PgFixture
let dao: BillingDAO

beforeEach(async () => {
  pg = await setupPgSchema()
  dao = new BillingDAO(pg.sql)
})

afterEach(async () => {
  await pg.close()
})

async function colsOf(table: string): Promise<string[]> {
  const rows = await pg.sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table} ORDER BY ordinal_position`
  return rows.map(r => r.column_name)
}

/** PG 表存在性（= 旧 sqlite_master 断言的同语义投影）。 */
async function tableExists(name: string): Promise<boolean> {
  const rows = await pg.sql`SELECT 1 FROM pg_tables WHERE tablename = ${name}`
  return rows.length === 1
}

async function viewExists(name: string): Promise<boolean> {
  const rows = await pg.sql`SELECT 1 FROM information_schema.views WHERE table_name = ${name}`
  return rows.length === 1
}

/** 手写一条合法兜底价输入（E2E_TEST_ 前缀，测试结束随随机库销毁）。 */
function priceInput(overrides: Partial<BillingPriceRow> = {}) {
  return {
    vendor: "e2e-vendor",
    model_id: "E2E_TEST_MODEL_A",
    input_unit_price: 3.5,
    output_unit_price: 17.5,
    cache_write_unit_price: 4.2,
    cache_read_unit_price: 0.35,
    currency: "CNY" as const,
    ...overrides,
  }
}

/** 断言 reject 且 code 精确匹配。 */
async function expectPriceCode(fn: () => Promise<unknown>, code: BillingPriceErrorCode) {
  let err: unknown = null
  try { await fn() } catch (e) { err = e }
  expect(err, `expected throw with code ${code}`).toBeInstanceOf(BillingPriceValidationError)
  expect((err as BillingPriceValidationError).code).toBe(code)
}

// ── Seam A: schema ─────────────────────────────────────────────────

describePg("billing schema (applyPgSchema)", () => {
  it("fresh DB: billing_price_config has window columns; model_id is NOT unique", async () => {
    expect(await tableExists("billing_price_config")).toBe(true)
    expect(await colsOf("billing_price_config")).toEqual([
      "id", "vendor", "model_id",
      "input_unit_price", "output_unit_price", "cache_write_unit_price", "cache_read_unit_price",
      "currency", "valid_from", "valid_to", "created_at", "updated_at",
    ])
    // model_id 不 UNIQUE：同模型两条互不重叠的时间段行直插都成功
    const ins = (id: string, from: number, to: number) => pg.sql.unsafe(`
      INSERT INTO billing_price_config
        (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, "e2e-vendor", "E2E_TEST_MODEL_A", 1, 1, 0, 0, "USD", from, to, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z"])
    await ins("w1", 1000, 2000)
    await expect(ins("w2", 2000, 3000)).resolves.toBeDefined()
  })

  it("fresh DB: 兜底价（双 NULL）每模型至多一条 —— 部分唯一索引 ux_price_catchall 实际生效", async () => {
    const ins = (id: string, inP: number, outP: number) => pg.sql.unsafe(`
      INSERT INTO billing_price_config
        (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
      VALUES ($1, 'v', 'E2E_TEST_MODEL_A', $2, $3, 0, 0, 'USD', NULL, NULL, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
      [id, inP, outP])
    await ins("c1", 1, 1)
    await expect(ins("c2", 2, 2)).rejects.toThrow(/ux_price_catchall/)
  })

  it("fresh DB: billing_price_config currency CHECK admits only USD|CNY", async () => {
    await expect(dao.createPrice(priceInput({ model_id: "E2E_TEST_BAD_CURRENCY", currency: "EUR" as never })))
      .rejects.toThrow(/CHECK/i)
  })

  it("fresh DB: llm_calls has NO cost snapshot columns; llm_calls_costed view derives cost_usd + vendor", async () => {
    const cols = await colsOf("llm_calls")
    for (const c of ["cost_usd", "cost_native", "cost_currency", "price_status"]) {
      expect(cols, `llm_calls.${c} must be gone`).not.toContain(c)
    }
    // 视图存在且 = llm_calls 全列 + 派生 cost_usd + vendor
    expect(await viewExists("llm_calls_costed")).toBe(true)
    const viewCols = await colsOf("llm_calls_costed")
    expect(viewCols).toEqual([...cols, "cost_usd", "vendor"])
  })

  it("applyPgSchema is idempotent — running twice keeps tables/view intact", async () => {
    await dao.createPrice(priceInput())
    await applyPgSchema(pg.sql)
    await applyPgSchema(pg.sql)
    expect(await tableExists("billing_price_config")).toBe(true)
    expect(await tableExists("billing_setting")).toBe(true)
    expect(await viewExists("llm_calls_costed")).toBe(true)
    expect(await dao.listPrices()).toHaveLength(1) // 表数据不随重建视图丢失
  })

  it("old DB migrates via v48: cost cols dropped, price row becomes catch-all, names normalized, history back-costed", () => {
    // 手工搭一个 v47 之前的老形状（node_execution_id NOT NULL 触发 rebuild、cost 快照列、
    // 价格表无窗口列、模型名带 [1m] 残渣），模拟升级现场。SQLite-only：v48 迁移器住在
    // applySchema（真库升级路径），PG 侧 schema.sql 即新形状，无老库平移问题。
    const old = new Database()
    old.exec("PRAGMA foreign_keys = OFF")
    old.exec(`
      CREATE TABLE llm_calls (
        id TEXT PRIMARY KEY,
        node_execution_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL DEFAULT 1,
        call_index INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 1,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        workspace_id TEXT,
        workflow_ref TEXT
      )`)
    old.prepare(`INSERT INTO llm_calls (id, node_execution_id, execution_id, model, timestamp, input_tokens, cost_usd)
      VALUES ('legacy-1', 'ne-x', 'e-x', 'legacy-model[1m]', 1700000000000, 1000, 0.42)`).run()
    old.exec(`
      CREATE TABLE billing_price_config (
        id TEXT PRIMARY KEY,
        vendor TEXT NOT NULL,
        model_id TEXT NOT NULL UNIQUE,
        input_unit_price REAL NOT NULL,
        output_unit_price REAL NOT NULL,
        cache_write_unit_price REAL NOT NULL,
        cache_read_unit_price REAL NOT NULL,
        currency TEXT NOT NULL CHECK (currency IN ('USD','CNY')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
    old.prepare(`INSERT INTO billing_price_config
      (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, created_at, updated_at)
      VALUES ('p-legacy', 'v', 'legacy-model', 100, 0, 0, 0, 'USD', ?, ?)`).run("2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z")

    applySchema(old)

    // llm_calls：cost 快照列已弃，事实行保留，模型名归一
    const cols = (old.prepare("PRAGMA table_info(llm_calls)").all() as { name: string }[]).map(c => c.name)
    expect(cols).not.toContain("cost_usd")
    const fact = old.prepare("SELECT * FROM llm_calls WHERE id = 'legacy-1'").get() as Record<string, unknown>
    expect(fact.model).toBe("legacy-model") // [1m] 残渣已剥
    expect(fact.input_tokens).toBe(1000)
    // 价格表：窗口列已加，存量行平移为兜底价（双 NULL），model_id 同为规范名
    const price = old.prepare("SELECT * FROM billing_price_config WHERE id = 'p-legacy'").get() as Record<string, unknown>
    expect(price.model_id).toBe("legacy-model")
    expect(price.valid_from).toBeNull()
    expect(price.valid_to).toBeNull()
    // 语义翻转现场：旧快照 0.42 弃掉，历史行立即按兜底价回算 = 1000×100/1M = 0.1
    const costed = old.prepare("SELECT cost_usd, vendor FROM llm_calls_costed WHERE id = 'legacy-1'").get() as { cost_usd: number | null; vendor: string | null }
    expect(costed.cost_usd).toBeCloseTo(0.1, 10)
    expect(costed.vendor).toBe("v")
    old.close()
  })
})

// ── Seam B: BillingDAO price rules ─────────────────────────────────

describePg("BillingDAO — price CRUD（规则表）", () => {
  it("createPrice catch-all → row round-trips every field loss-free; window defaults to NULL", async () => {
    const created = await dao.createPrice(priceInput())
    const read = (await dao.getPrice(created.id))!
    expect(read).not.toBeNull()
    expect(read.id).toBe(created.id)
    expect(read.vendor).toBe("e2e-vendor")
    expect(read.model_id).toBe("E2E_TEST_MODEL_A")
    expect(read.input_unit_price).toBe(3.5)
    expect(read.output_unit_price).toBe(17.5)
    expect(read.cache_write_unit_price).toBe(4.2)
    expect(read.cache_read_unit_price).toBe(0.35)
    expect(read.currency).toBe("CNY")
    expect(read.valid_from).toBeNull()
    expect(read.valid_to).toBeNull()
    expect(typeof read.created_at).toBe("string")
    expect(typeof read.updated_at).toBe("string")
    // double precision 存回来的仍然是这些精确值（手算：无精度丢失）
    expect(read.input_unit_price + read.output_unit_price).toBe(21)
  })

  it("createPrice with window → valid_from/valid_to stored as given", async () => {
    const created = await dao.createPrice(priceInput({ model_id: "E2E_TEST_WIN", valid_from: 1000, valid_to: 2000 }))
    expect(created.valid_from).toBe(1000)
    expect(created.valid_to).toBe(2000)
    const read = (await dao.getPrice(created.id))!
    expect(read.valid_from).toBe(1000)
    expect(read.valid_to).toBe(2000)
    // 单端有界也合法（半开区间另一侧 = ±∞）
    const open = await dao.createPrice(priceInput({ model_id: "E2E_TEST_WIN_OPEN", valid_from: 5000, valid_to: null }))
    expect(open.valid_from).toBe(5000)
    expect(open.valid_to).toBeNull()
  })

  it("createPrice normalizes model_id (剥尾部 [..] 与孤立 ] 残渣); 归一后为空 → PRICE_MODEL_INVALID", async () => {
    const created = await dao.createPrice(priceInput({ model_id: "E2E_TEST_NORM[1m]" }))
    expect(created.model_id).toBe("E2E_TEST_NORM")
    expect((await dao.getPrice(created.id))!.model_id).toBe("E2E_TEST_NORM") // 落库即规范名
    const debris = await dao.createPrice(priceInput({ model_id: "E2E_TEST_NORM2]  " }))
    expect(debris.model_id).toBe("E2E_TEST_NORM2")
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "[1m]" })), "PRICE_MODEL_INVALID")
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: " ]" })), "PRICE_MODEL_INVALID")
  })

  it("窗口校验: from >= to → PRICE_WINDOW_ORDER; 同模型第二条兜底价 → PRICE_CATCHALL_DUPLICATE; 重叠 → PRICE_WINDOW_OVERLAP", async () => {
    // 倒序与空区间
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_W1", valid_from: 2000, valid_to: 1000 })), "PRICE_WINDOW_ORDER")
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_W1", valid_from: 1000, valid_to: 1000 })), "PRICE_WINDOW_ORDER")
    // 兜底价重复
    await dao.createPrice(priceInput({ model_id: "E2E_TEST_W1" }))
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_W1", input_unit_price: 9 })), "PRICE_CATCHALL_DUPLICATE")
    // 时间段行重叠拒绝、贴边允许
    await dao.createPrice(priceInput({ model_id: "E2E_TEST_W2", valid_from: 1000, valid_to: 2000 }))
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_W2", valid_from: 1500, valid_to: 2500 })), "PRICE_WINDOW_OVERLAP")
    await expectPriceCode(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_W2", valid_from: 1200, valid_to: 1500 })), "PRICE_WINDOW_OVERLAP") // 被包含也算重叠
    await expect(dao.createPrice(priceInput({ model_id: "E2E_TEST_W2", valid_from: 2000, valid_to: 3000 }))).resolves.toBeDefined() // from == 既有 to → 贴边不重叠
    // 兜底价与窗口行天然共存（双向）
    await expect(dao.createPrice(priceInput({ model_id: "E2E_TEST_W2" }))).resolves.toBeDefined()
    await expect(dao.createPrice(priceInput({ model_id: "E2E_TEST_W3", valid_from: 100, valid_to: 200 }))).resolves.toBeDefined()
    await expect(dao.createPrice(priceInput({ model_id: "E2E_TEST_W3" }))).resolves.toBeDefined()
  })

  it("updatePrice: 改价/改窗口、null=拆界、updated_at bump、created_at 不变、不存在 → null", async () => {
    const created = await dao.createPrice(priceInput({ model_id: "E2E_TEST_UPD", valid_from: 1000, valid_to: 2000 }))
    const updated = (await dao.updatePrice(created.id, { input_unit_price: 9.9, currency: "USD", valid_to: null }))!
    expect(updated).not.toBeNull()
    expect(updated.input_unit_price).toBe(9.9)
    expect(updated.output_unit_price).toBe(17.5) // 未传的字段不动
    expect(updated.currency).toBe("USD")
    expect(updated.valid_from).toBe(1000) // 未传 = 不动
    expect(updated.valid_to).toBeNull()   // 显式 null = 拆界
    expect(updated.created_at).toBe(created.created_at)
    expect(updated.updated_at >= created.updated_at).toBe(true)
    expect(await dao.updatePrice("E2E_TEST_MISSING_ID", { input_unit_price: 1 })).toBeNull()
    // 拆成兜底时同样受每模型至多一条约束：先配一条真兜底（与窗口行共存），再把窗口行拆界撞车
    await dao.createPrice(priceInput({ model_id: "E2E_TEST_UPD" }))
    await expectPriceCode(() => dao.updatePrice(updated.id, { valid_from: null }), "PRICE_CATCHALL_DUPLICATE")
    // 改窗口时重新校验（排除自身）：改成与另一行重叠 → 拒绝；维持自身原窗口 → 允许
    const second = (await dao.createPrice(priceInput({ model_id: "E2E_TEST_UPD2", valid_from: 1000, valid_to: 2000 })))!
    await dao.createPrice(priceInput({ model_id: "E2E_TEST_UPD2", id: second.id + "-b", valid_from: 3000, valid_to: 4000 }))
    await expectPriceCode(() => dao.updatePrice(second.id, { valid_to: 3500 }), "PRICE_WINDOW_OVERLAP")
    await expect(dao.updatePrice(second.id, { valid_from: 1000, valid_to: 2000 })).resolves.toBeDefined()
  })

  it("updatePrice changes model_id (normalized); 撞目标模型既有兜底 → PRICE_CATCHALL_DUPLICATE", async () => {
    const a = await dao.createPrice(priceInput({ model_id: "E2E_TEST_REN_A" }))
    await dao.createPrice(priceInput({ model_id: "E2E_TEST_REN_B" }))
    await expectPriceCode(() => dao.updatePrice(a.id, { model_id: "E2E_TEST_REN_B[1m]" }), "PRICE_CATCHALL_DUPLICATE")
    const moved = (await dao.updatePrice(a.id, { model_id: "E2E_TEST_REN_C" }))!
    expect(moved.model_id).toBe("E2E_TEST_REN_C")
    expect((await dao.getPrice(a.id))!.model_id).toBe("E2E_TEST_REN_C")
  })

  it("deletePrice removes the row; second delete returns false; 删后同模型可重新配兜底", async () => {
    const created = await dao.createPrice(priceInput())
    expect(await dao.deletePrice(created.id)).toBe(true)
    expect(await dao.getPrice(created.id)).toBeNull()
    expect(await dao.deletePrice(created.id)).toBe(false)
    await expect(dao.createPrice(priceInput())).resolves.toBeDefined()
  })

  it("listPrices: model_id ASC → 兜底在前 → valid_from 升序（NULL from 最前）→ id ASC", async () => {
    await dao.createPrice(priceInput({ id: "z-late", model_id: "E2E_TEST_SORT_A", valid_from: 200, valid_to: 300 }))
    await dao.createPrice(priceInput({ id: "a-early", model_id: "E2E_TEST_SORT_A", valid_from: 100, valid_to: 200 }))
    await dao.createPrice(priceInput({ id: "catch-a", model_id: "E2E_TEST_SORT_A" }))
    await dao.createPrice(priceInput({ id: "open-to", model_id: "E2E_TEST_SORT_B", valid_from: null, valid_to: 77 }))
    await dao.createPrice(priceInput({ id: "open-from", model_id: "E2E_TEST_SORT_B", valid_from: 77, valid_to: null }))
    const ids = (await dao.listPrices()).map(r => r.id)
    expect(ids).toEqual(["catch-a", "a-early", "z-late", "open-to", "open-from"])
    expect((await dao.listPrices())[0].model_id).toBe("E2E_TEST_SORT_A")
  })
})

// ── Seam B: 命中匹配 ───────────────────────────────────────────────

describePg("BillingDAO — getPriceAtModel（窗口优先 + valid_from 最大）", () => {
  it("命中窗口取 valid_from 最大 → 兜底价 → 无 = null；与视图匹配序一致", async () => {
    const catchall = await dao.createPrice(priceInput({ id: "m1-catch", model_id: "E2E_TEST_MATCH", currency: "USD" }))
    const w1 = await dao.createPrice(priceInput({ id: "m1-w1", model_id: "E2E_TEST_MATCH", currency: "USD", valid_from: 1000, valid_to: 5000 }))
    // w2 [2000,4000) 与 w1 重叠 —— 正常写入会被第一道闸拒绝，这里直插模拟手改库现场，
    // 验证 SQL 命中去重（第二道闸）：至多取一行、valid_from 大者优先。
    await pg.sql.unsafe(`INSERT INTO billing_price_config
      (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
      VALUES ('m1-w2', 'e2e-vendor', 'E2E_TEST_MATCH', 99, 0, 0, 0, 'USD', 2000, 4000, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`)
    // ts 落在 w1 ∩ w2 → 窗口优先 + valid_from 最大 → w2（input 99），而不是兜底 3.5
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 3000))!.id).toBe("m1-w2")
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 3000))!.input_unit_price).toBe(99)
    // 只在 w1 内 → w1
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 1500))!.id).toBe(w1.id)
    // 窗口外 → 兜底
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 6000))!.id).toBe(catchall.id)
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 999))!.id).toBe(catchall.id)
    // to 边界 = 开区间：ts == 5000 不命中 w1
    expect((await dao.getPriceAtModel("E2E_TEST_MATCH", 5000))!.id).toBe(catchall.id)
    // 无兜底且窗口外 → null
    await dao.createPrice(priceInput({ id: "n-w", model_id: "E2E_TEST_NOCATCH", valid_from: 1000, valid_to: 2000 }))
    expect(await dao.getPriceAtModel("E2E_TEST_NOCATCH", 500)).toBeNull()
    expect((await dao.getPriceAtModel("E2E_TEST_NOCATCH", 1000))!.id).toBe("n-w")
    expect(await dao.getPriceAtModel("E2E_TEST_NO_SUCH_MODEL", 1000)).toBeNull()
  })
})

// ── Seam B: 试算器 ─────────────────────────────────────────────────

describePg("BillingDAO — previewCost", () => {
  it("USD 价行：手算四类 token × 单价 / 1M；字段齐；price_id/vendor 指向命中行", async () => {
    const p = await dao.createPrice(priceInput({
      id: "pv-usd", model_id: "E2E_TEST_PV1", currency: "USD",
      input_unit_price: 2, output_unit_price: 4, cache_write_unit_price: 6, cache_read_unit_price: 8, vendor: "pv-vendor",
    }))
    const r = await dao.previewCost("E2E_TEST_PV1", 123, { inputTokens: 500000, outputTokens: 250000, cacheCreationTokens: 500000, cacheReadTokens: 125000 })
    // (500000*2 + 250000*4 + 500000*6 + 125000*8) / 1M = (1 + 1 + 3 + 1) = 6
    expect(r.cost_usd).toBeCloseTo(6, 10)
    expect(r.cost_native).toBeCloseTo(6, 10)
    expect(r.cost_currency).toBe("USD")
    expect(r.vendor).toBe("pv-vendor")
    expect(r.price_id).toBe(p.id)
    expect(r.price_status).toBe("priced")
    expect(r.model).toBe("E2E_TEST_PV1")
    expect(r.timestamp).toBe(123)
  })

  it("CNY 价行按当前 usd_to_cny 折算 USD；改汇率立即影响试算", async () => {
    await dao.createPrice(priceInput({ id: "pv-cny", model_id: "E2E_TEST_PV2", currency: "CNY", input_unit_price: 100, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0 }))
    const r = await dao.previewCost("E2E_TEST_PV2", 0, { inputTokens: 10000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(r.cost_native).toBeCloseTo(1, 10)  // 10000×100/1M = 1 CNY
    expect(r.cost_usd).toBeCloseTo(1 / 7, 10) // 默认汇率 7.0
    expect(r.cost_currency).toBe("CNY")
    await dao.setSetting("usd_to_cny", "8")
    const r2 = await dao.previewCost("E2E_TEST_PV2", 0, { inputTokens: 10000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(r2.cost_usd).toBeCloseTo(1 / 8, 10) // 规则账语义：改汇率全局重算
    await pg.sql`DELETE FROM billing_setting WHERE key = 'usd_to_cny'`
  })

  it("命中窗口优先于兜底价（与视图同一匹配序）；窗口外回落到兜底", async () => {
    await dao.createPrice(priceInput({ id: "pv-c", model_id: "E2E_TEST_PV3", currency: "USD", input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0 }))
    await dao.createPrice(priceInput({ id: "pv-w", model_id: "E2E_TEST_PV3", currency: "USD", input_unit_price: 2000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0, valid_from: 1000, valid_to: 2000 }))
    const usage = { inputTokens: 500, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
    const inW = await dao.previewCost("E2E_TEST_PV3", 1500, usage)
    expect(inW.cost_usd).toBeCloseTo(1, 10)   // 500×2000/1M
    expect(inW.price_id).toBe("pv-w")
    const outW = await dao.previewCost("E2E_TEST_PV3", 2500, usage)
    expect(outW.cost_usd).toBeCloseTo(0.5, 10) // 500×1000/1M
    expect(outW.price_id).toBe("pv-c")
  })

  it("无价模型 / NULL 模型 → unpriced 全 NULL；model 入参归一后命中", async () => {
    await dao.createPrice(priceInput({ id: "pv-n", model_id: "E2E_TEST_PV4", currency: "USD", input_unit_price: 1000, output_unit_price: 0, cache_write_unit_price: 0, cache_read_unit_price: 0 }))
    const hit = await dao.previewCost("E2E_TEST_PV4[1m]", 0, { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(hit.cost_usd).toBeCloseTo(1, 10)
    const miss = await dao.previewCost("E2E_TEST_NOPE", 0, { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(miss.price_status).toBe("unpriced")
    expect(miss.cost_usd).toBeNull()
    expect(miss.cost_native).toBeNull()
    expect(miss.cost_currency).toBeNull()
    expect(miss.vendor).toBeNull()
    expect(miss.price_id).toBeNull()
    const nullModel = await dao.previewCost(null, 0, { inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
    expect(nullModel.price_status).toBe("unpriced")
  })
})

// ── Seam B: BillingDAO settings ────────────────────────────────────

describePg("BillingDAO — settings", () => {
  it("unset settings fall back to built-in defaults (usd_to_cny=7.0, display_currency=CNY)", async () => {
    expect(await dao.getSetting("usd_to_cny")).toBe("7.0")
    expect(await dao.getSetting("display_currency")).toBe("CNY")
    expect(await dao.getUsdToCny()).toBe(7.0)
    expect(await dao.getDisplayCurrency()).toBe("CNY")
  })

  it("setSetting upserts; getSetting reads back the new value; second set overwrites", async () => {
    await dao.setSetting("usd_to_cny", "6.5")
    expect(await dao.getSetting("usd_to_cny")).toBe("6.5")
    expect(await dao.getUsdToCny()).toBeCloseTo(6.5, 10)
    await dao.setSetting("usd_to_cny", "7.2") // UPSERT，不是双行
    expect(await dao.getSetting("usd_to_cny")).toBe("7.2")
    const [{ n }] = await pg.sql`SELECT COUNT(*)::int AS n FROM billing_setting WHERE key = 'usd_to_cny'`
    expect(n).toBe(1)
  })

  it("getAllSettings returns the effective key/value map including defaults", async () => {
    await dao.setSetting("display_currency", "USD")
    const all = await dao.getAllSettings()
    expect(all).toEqual({ usd_to_cny: "7.0", display_currency: "USD" })
  })
})
