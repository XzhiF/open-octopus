// 02 · BillingService 单测（billing-core-1 ticket 02）
// Seam: BillingService.matchPrice / compute —— 算钱的唯一入口（spec 单一 seam）。
// 期望值全部手算写在测试里（独立真相源）：
//   · 100000×3/1e6=0.3; 200000×15/1e6=3; 300000×3.75/1e6=1.125; 400000×0.3/1e6=0.12 → 4.545
//   · 1M×{3,15,3.75,0.3}/1e6 = 3+15+3.75+0.3 = 22.05
//   · 1M×{21,105,26,2}/1e6 = 21+105+26+2 = 154；154/7 = 22；154/14 = 11
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { BillingDAO } from "../../db/dao/billing-dao"
import { BillingService, type TokenCostUsage } from "../billing"

let db: Database.Database
let dao: BillingDAO
let svc: BillingService

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new BillingDAO(db)
  svc = new BillingService(dao)
})

afterEach(() => {
  db.close()
})

function priceFixture(id: string, modelId: string, prices: [number, number, number, number], currency: "USD" | "CNY") {
  return dao.createPrice({
    id, vendor: "e2e-vendor", model_id: modelId,
    input_unit_price: prices[0], output_unit_price: prices[1],
    cache_write_unit_price: prices[2], cache_read_unit_price: prices[3],
    currency,
  })
}

describe("BillingService.matchPrice (KD9 精确匹配)", () => {
  it("hits only on exact model_id", () => {
    priceFixture("P-1", "E2E_TEST_gpt-x", [3, 15, 3.75, 0.3], "USD")
    expect(svc.matchPrice("E2E_TEST_gpt-x")?.id).toBe("P-1")
    expect(svc.matchPrice("E2E_TEST_gpt")).toBeNull() // 前缀不算匹配
    expect(svc.matchPrice("E2E_TEST_GPT-X")).toBeNull() // 大小写敏感（精确匹配）
    expect(svc.matchPrice("no-such-model")).toBeNull()
  })

  it("null / '' model → null, no throw (AC4)", () => {
    expect(svc.matchPrice(null)).toBeNull()
    expect(() => svc.matchPrice(null)).not.toThrow()
    expect(() => svc.matchPrice("")).not.toThrow()
    expect(svc.matchPrice("")).toBeNull()
  })
})

describe("BillingService.compute (US3 公式 / KD4 未定价 / KD5 双列)", () => {
  it("ticket case 1: 全 0 token + 有价格 → priced, cost 三项全 0", () => {
    const usage: TokenCostUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const r = svc.compute(usage, priceFixture("P-0", "E2E_TEST_zero", [3, 15, 3.75, 0.3], "USD"))
    expect(r).toEqual({ cost_native: 0, cost_currency: "USD", cost_usd: 0, price_status: "priced" })
  })

  it("all four token kinds enter the formula independently (AC1)", () => {
    const usage: TokenCostUsage = { inputTokens: 100_000, outputTokens: 200_000, cacheCreationTokens: 300_000, cacheReadTokens: 400_000 }
    const r = svc.compute(usage, priceFixture("P-t", "E2E_TEST_terms", [3, 15, 3.75, 0.3], "USD"))
    // 0.3 + 3 + 1.125 + 0.12（cache_write=缓存写入、cache_read=缓存读取，各按各自单价）
    expect(r.cost_native).toBeCloseTo(4.545, 10)
    expect(r.cost_usd).toBeCloseTo(4.545, 10)
    expect(r.price_status).toBe("priced")
  })

  it("ticket case 2: 1M×(in,out,cw,cr), USD {3,15,3.75,0.3} → native=22.05, usd=22.05", () => {
    const usage: TokenCostUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }
    const r = svc.compute(usage, priceFixture("P-u", "E2E_TEST_usd", [3, 15, 3.75, 0.3], "USD"))
    expect(r.cost_native).toBeCloseTo(22.05, 10) // 3+15+3.75+0.3
    expect(r.cost_currency).toBe("USD")
    expect(r.cost_usd).toBeCloseTo(22.05, 10) // 原币 USD → 同值直存 (US3/KD5)
    expect(r.price_status).toBe("priced")
  })

  it("ticket case 3: 同量 CNY {21,105,26,2}, 汇率 7 → native=154, usd=22 (154/7)", () => {
    // 票面写 154.5/22.0714，按票给单价手算实为 21+105+26+2=154、154/7=22 —— 取公式为准（US3/KD6），差异已在票尾记档
    const usage: TokenCostUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }
    const r = svc.compute(usage, priceFixture("P-c", "E2E_TEST_cny", [21, 105, 26, 2], "CNY"))
    expect(r.cost_native).toBeCloseTo(154, 10)
    expect(r.cost_currency).toBe("CNY")
    expect(r.cost_usd).toBeCloseTo(22, 6) // 原币 CNY → 按记账时汇率归一 USD
  })

  it("ticket case 4: 未匹配价格 → 三元组全 NULL + unpriced (KD4 不估算)", () => {
    const usage: TokenCostUsage = { inputTokens: 500_000, outputTokens: 500_000, cacheCreationTokens: 0, cacheReadTokens: 0 }
    const r = svc.compute(usage, svc.matchPrice("E2E_TEST_no-such"))
    expect(r).toEqual({ cost_native: null, cost_currency: null, cost_usd: null, price_status: "unpriced" })
    // null/'' model 走同一 seam 也安全
    expect(svc.compute(usage, svc.matchPrice(null)).price_status).toBe("unpriced")
    expect(svc.compute(usage, svc.matchPrice("")).price_status).toBe("unpriced")
  })

  it("ticket case 5: 汇率实时读取 —— 改 setting 后 compute 归一值随动 (KD7)", () => {
    const usage: TokenCostUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }
    const cnyPrice = priceFixture("P-r", "E2E_TEST_rate", [21, 105, 26, 2], "CNY")
    const cny = svc.compute(usage, cnyPrice)
    expect(cny.cost_usd).toBeCloseTo(22, 6) // 默认汇率 7.0 → 154/7
    dao.setSetting("usd_to_cny", "14")
    const cny2 = svc.compute(usage, cnyPrice)
    expect(cny2.cost_native).toBeCloseTo(154, 10) // 原币金额不随汇率变
    expect(cny2.cost_usd).toBeCloseTo(11, 6) // 154/14
    // USD 路径不除汇率，也不随 setting 动
    const usd = svc.compute(usage, priceFixture("P-r2", "E2E_TEST_rate_usd", [3, 15, 3.75, 0.3], "USD"))
    expect(usd.cost_usd).toBeCloseTo(22.05, 10)
    // 新实例（无缓存）同样实时读取：154/6 = 25.666666666666668
    dao.setSetting("usd_to_cny", "6")
    const sameSvc = new BillingService(dao)
    expect(sameSvc.compute(usage, cnyPrice).cost_usd).toBeCloseTo(25.666666666666668, 10)
  })
})

describe("BillingService.computeForModel（票 04 接线的组合 seam）", () => {
  it("match + compute 一步到位：定价模型 priced、未知模型 unpriced", () => {
    priceFixture("P-m", "E2E_TEST_combo", [3, 15, 3.75, 0.3], "USD")
    const usage: TokenCostUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }
    expect(svc.computeForModel("E2E_TEST_combo", usage)).toEqual({
      cost_native: expect.closeTo(22.05, 10),
      cost_currency: "USD",
      cost_usd: expect.closeTo(22.05, 10),
      price_status: "priced",
    })
    expect(svc.computeForModel("E2E_TEST_absent", usage)).toEqual({
      cost_native: null, cost_currency: null, cost_usd: null, price_status: "unpriced",
    })
  })
})
