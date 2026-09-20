// 01 · 计费数据层单测（billing-core-1 ticket 01）
// Seam A: applySchema — 新库全量建表 + 老库增量迁移(ensureColumn 幂等)
// Seam B: BillingDAO — 价格 CRUD / 按 model_id 取价 / settings get-set
// 期望值全部手写在测试里（独立真相源，非从实现推导）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../schema"
import { BillingDAO, type BillingPriceRow } from "../billing-dao"

let db: Database.Database
let dbPath: string
let dao: BillingDAO

function freshDb(): Database.Database {
  const p = path.join(os.tmpdir(), `test-billing-dao-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const d = new Database(p)
  d.pragma("foreign_keys = ON")
  applySchema(d)
  return d
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-billing-dao-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new BillingDAO(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function colsOf(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

/** 手写一条合法价格输入（E2E_TEST_ 前缀，测试结束随临时库销毁）。 */
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

// ── Seam A: schema ─────────────────────────────────────────────────

describe("billing schema (applySchema)", () => {
  it("fresh DB: billing_price_config has all columns with model_id UNIQUE", () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_price_config'").all()).toHaveLength(1)
    expect(colsOf(db, "billing_price_config")).toEqual([
      "id", "vendor", "model_id",
      "input_unit_price", "output_unit_price", "cache_write_unit_price", "cache_read_unit_price",
      "currency", "created_at", "updated_at",
    ])
    // UNIQUE 约束实际生效（直插两行重复 model_id，第二行必须抛）
    const ins = db.prepare(`
      INSERT INTO billing_price_config
        (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const a = priceInput()
    ins.run("p1", a.vendor, a.model_id, a.input_unit_price, a.output_unit_price, a.cache_write_unit_price, a.cache_read_unit_price, a.currency, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z")
    expect(() =>
      ins.run("p2", a.vendor, a.model_id, a.input_unit_price, a.output_unit_price, a.cache_write_unit_price, a.cache_read_unit_price, a.currency, "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z"),
    ).toThrow(/UNIQUE/i)
  })

  it("fresh DB: billing_price_config currency CHECK admits only USD|CNY", () => {
    expect(() => dao.createPrice(priceInput({ model_id: "E2E_TEST_BAD_CURRENCY", currency: "EUR" as never }))).toThrow(/CHECK/i)
  })

  it("fresh DB: llm_calls gains cost_native / cost_currency / price_status", () => {
    const cols = colsOf(db, "llm_calls")
    for (const c of ["cost_native", "cost_currency", "price_status"]) {
      expect(cols, `llm_calls.${c}`).toContain(c)
    }
    // 类型断言：cost_native 是 REAL
    const native = (db.prepare("PRAGMA table_info(llm_calls)").all() as { name: string; type: string }[]).find(c => c.name === "cost_native")!
    expect(native.type).toBe("REAL")
  })

  it("applySchema is idempotent — running twice keeps the new columns intact", () => {
    applySchema(db)
    applySchema(db)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_price_config'").all()).toHaveLength(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_setting'").all()).toHaveLength(1)
    const cols = colsOf(db, "llm_calls")
    expect(cols.filter(c => c === "cost_native" || c === "cost_currency" || c === "price_status")).toHaveLength(3)
  })

  it("old DB (llm_calls without the 3 columns) migrates in place; old rows get NULL, no backfill", () => {
    // 手工搭一个 v44 之前的老形状 llm_calls，模拟升级现场
    const old = new Database()
    old.exec("PRAGMA foreign_keys = OFF")
    old.exec(`
      CREATE TABLE llm_calls (
        id TEXT PRIMARY KEY,
        node_execution_id TEXT,
        execution_id TEXT,
        model TEXT,
        timestamp INTEGER NOT NULL,
        cost_usd REAL,
        workspace_id TEXT,
        workflow_ref TEXT
      )`)
    old.prepare("INSERT INTO llm_calls (id, model, timestamp, cost_usd) VALUES (?, ?, ?, ?)").run("legacy-1", "claude-x", 1700000000000, 0.42)

    applySchema(old)

    const cols = colsOf(old, "llm_calls")
    for (const c of ["cost_native", "cost_currency", "price_status"]) {
      expect(cols, `llm_calls.${c}`).toContain(c)
    }
    const row = old.prepare("SELECT * FROM llm_calls WHERE id = 'legacy-1'").get() as Record<string, unknown>
    expect(row.cost_usd).toBe(0.42) // 老数据原样保留
    expect(row.cost_native).toBeNull() // 不回填
    expect(row.cost_currency).toBeNull()
    expect(row.price_status).toBeNull()
    old.close()
  })
})

// ── Seam B: BillingDAO prices ──────────────────────────────────────

describe("BillingDAO — price CRUD", () => {
  it("createPrice → row round-trips every field loss-free", () => {
    const created = dao.createPrice(priceInput())
    const read = dao.getPrice(created.id)!
    expect(read).not.toBeNull()
    expect(read.id).toBe(created.id)
    expect(read.vendor).toBe("e2e-vendor")
    expect(read.model_id).toBe("E2E_TEST_MODEL_A")
    expect(read.input_unit_price).toBe(3.5)
    expect(read.output_unit_price).toBe(17.5)
    expect(read.cache_write_unit_price).toBe(4.2)
    expect(read.cache_read_unit_price).toBe(0.35)
    expect(read.currency).toBe("CNY")
    expect(typeof read.created_at).toBe("string")
    expect(typeof read.updated_at).toBe("string")
    // SQLite REAL 存回来的仍然是这些精确值（手算：无精度丢失）
    expect(read.input_unit_price + read.output_unit_price).toBe(21)
  })

  it("getPriceByModel: exact model_id match, null for unknown", () => {
    dao.createPrice(priceInput())
    const hit = dao.getPriceByModel("E2E_TEST_MODEL_A")!
    expect(hit).not.toBeNull()
    expect(hit.model_id).toBe("E2E_TEST_MODEL_A")
    expect(hit.input_unit_price).toBe(3.5)
    expect(dao.getPriceByModel("E2E_TEST_NO_SUCH_MODEL")).toBeNull()
  })

  it("duplicate model_id throws UNIQUE on the second createPrice", () => {
    dao.createPrice(priceInput())
    expect(() => dao.createPrice(priceInput({ id: undefined }))).toThrow(/UNIQUE/i)
  })

  it("listPrices returns all rows", () => {
    dao.createPrice(priceInput())
    dao.createPrice(priceInput({ id: undefined, model_id: "E2E_TEST_MODEL_B", vendor: "e2e-vendor-2", input_unit_price: 1, output_unit_price: 2, cache_write_unit_price: 3, cache_read_unit_price: 4, currency: "USD" }))
    const rows = dao.listPrices()
    expect(rows).toHaveLength(2)
    const b = rows.find(r => r.model_id === "E2E_TEST_MODEL_B")!
    expect(b.currency).toBe("USD")
    expect(b.input_unit_price).toBe(1)
  })

  it("updatePrice changes unit prices + currency, bumps updated_at, keeps created_at", () => {
    const created = dao.createPrice(priceInput())
    const updated = dao.updatePrice(created.id, { input_unit_price: 9.9, currency: "USD" })!
    expect(updated).not.toBeNull()
    expect(updated.input_unit_price).toBe(9.9)
    expect(updated.output_unit_price).toBe(17.5) // 未传的字段不动
    expect(updated.currency).toBe("USD")
    expect(updated.created_at).toBe(created.created_at)
    expect(updated.updated_at >= created.updated_at).toBe(true)
    expect(dao.updatePrice("E2E_TEST_MISSING_ID", { input_unit_price: 1 })).toBeNull()
  })

  it("deletePrice removes the row; second delete returns false", () => {
    const created = dao.createPrice(priceInput())
    expect(dao.deletePrice(created.id)).toBe(true)
    expect(dao.getPrice(created.id)).toBeNull()
    expect(dao.deletePrice(created.id)).toBe(false)
    // 删了之后同 model_id 可以重新插入
    expect(() => dao.createPrice(priceInput())).not.toThrow()
  })
})

// ── Seam B: BillingDAO settings ────────────────────────────────────

describe("BillingDAO — settings", () => {
  it("unset settings fall back to built-in defaults (usd_to_cny=7.0, display_currency=CNY)", () => {
    expect(dao.getSetting("usd_to_cny")).toBe("7.0")
    expect(dao.getSetting("display_currency")).toBe("CNY")
    expect(dao.getUsdToCny()).toBe(7.0)
    expect(dao.getDisplayCurrency()).toBe("CNY")
  })

  it("setSetting upserts; getSetting reads back the new value; second set overwrites", () => {
    dao.setSetting("usd_to_cny", "6.5")
    expect(dao.getSetting("usd_to_cny")).toBe("6.5")
    expect(dao.getUsdToCny()).toBeCloseTo(6.5, 10)
    dao.setSetting("usd_to_cny", "7.2") // UPSERT，不是双行
    expect(dao.getSetting("usd_to_cny")).toBe("7.2")
    const raw = db.prepare("SELECT COUNT(*) AS n FROM billing_setting WHERE key = 'usd_to_cny'").get() as { n: number }
    expect(raw.n).toBe(1)
  })

  it("getAllSettings returns the effective key/value map including defaults", () => {
    dao.setSetting("display_currency", "USD")
    const all = dao.getAllSettings()
    expect(all).toEqual({ usd_to_cny: "7.0", display_currency: "USD" })
  })
})
