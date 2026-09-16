import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { captureNodeUsage, openUsageDb, resolveCliDbPath } from "../utils/usage-writer"
import { __setPricingOverlayForTest, __resetPricingOverlayForTest, LLM_CALL_SOURCE, type ModelUsage } from "@octopus/shared"
import type { LLMCallRecord } from "@octopus/providers"

/**
 * all-sources-2 票02（直写路径，KD4=01 定案）—— CLI 捕获 unit：
 * fake tracker 序列 → source='cli' 明细 + 账本行；账本=Σ明细（四字段+cost）；
 * trace_id=run 标识贯通；重放幂等；零用量零行（模拟 mock 模式的等价负断言）。
 */
let db: Database.Database
let dir: string

const DDL = `
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY, node_execution_id TEXT, execution_id TEXT,
  turn_index INTEGER NOT NULL, call_index INTEGER NOT NULL, message_id TEXT,
  model TEXT, stop_reason TEXT, timestamp INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  ttft_ms INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, org TEXT, workspace_id TEXT, workflow_ref TEXT, node_id TEXT,
  session_id TEXT, instance_id TEXT, source TEXT, trace_id TEXT, span_id TEXT
);
CREATE TABLE node_token_usages (
  id TEXT PRIMARY KEY, node_execution_id TEXT, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, source TEXT DEFAULT 'node',
  created_at TEXT NOT NULL, session_id TEXT, trace_id TEXT
);`

const RUN = { runId: "run-1", org: "test-org", workflowRef: "t.yaml", nodeId: "n1" }

function call(over: Partial<LLMCallRecord>): LLMCallRecord {
  return {
    turnIndex: 1, messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: 1700, durationMs: 100,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10,
    model: "qwen3.8-flash", ...over,
  } as LLMCallRecord
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-usage-"))
  db = new Database(join(dir, "test.db"))
  db.exec(DDL)
  // qwen3.8-flash 有价（input 1 / output 2 / cacheRead 0.1 / cacheCreate 0.5 每 M）
  __setPricingOverlayForTest({ "qwen3.8-flash": { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 } })
})

afterEach(() => {
  __resetPricingOverlayForTest()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("直写捕获：明细 + 账本", () => {
  it("明细行 source='cli'，trace_id=run 标识，span_id=messageId", () => {
    captureNodeUsage(db, RUN, [call({ messageId: "m-a" })], [{ model: "qwen3.8-flash", inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 }])
    const row = db.prepare("SELECT * FROM llm_calls").get() as Record<string, unknown>
    expect(row.source).toBe(LLM_CALL_SOURCE.cli)
    expect(row.trace_id).toBe("run-1")
    expect(row.span_id).toBe("m-a")
    expect(row.execution_id).toBe("run-1")
    expect(row.node_execution_id).toBeNull() // host 列成本不编数：CLI run 无 node_executions 行
    expect(row.node_id).toBe("n1")
    expect(row.org).toBe("test-org")
    expect(row.workflow_ref).toBe("t.yaml")
  })

  it("账本=Σ明细（US3）：四字段与 cost 逐一对上；账本行 source='cli' + trace_id", () => {
    const calls = [call({ messageId: "m-1" }), call({ messageId: "m-2", inputTokens: 200, outputTokens: 80, cacheReadTokens: 5, cacheCreationTokens: 2 })]
    const mu: ModelUsage = { model: "qwen3.8-flash", inputTokens: 300, outputTokens: 130, cacheReadTokens: 25, cacheCreationTokens: 12 }
    captureNodeUsage(db, RUN, calls, [mu])
    const detail = db.prepare("SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc, SUM(cost_usd) cost FROM llm_calls").get() as Record<string, number>
    const ledger = db.prepare("SELECT * FROM node_token_usages").get() as Record<string, number | string>
    expect(ledger.id).toBe("cli:run-1:n1:qwen3.8-flash")
    expect(ledger.source).toBe(LLM_CALL_SOURCE.cli)
    expect(ledger.trace_id).toBe("run-1")
    expect([ledger.input_tokens, ledger.output_tokens, ledger.cache_read_tokens, ledger.cache_creation_tokens])
      .toEqual([detail.i, detail.o, detail.cr, detail.cc])
    // estimateCost 线性 → Σ明细估算 === 账本估算（同 model 同价）
    expect(Number(ledger.cost_usd)).toBeCloseTo(detail.cost, 12)
  })

  it("无 modelUsages（异常路径）→ 折叠明细进账本", () => {
    captureNodeUsage(db, RUN, [call({}), call({ model: "other-x" })])
    const rows = db.prepare("SELECT model, source, trace_id FROM node_token_usages ORDER BY model").all() as Array<Record<string, string>>
    expect(rows.map(r => r.model)).toEqual(["other-x", "qwen3.8-flash"])
    expect(rows.every(r => r.source === "cli" && r.trace_id === "run-1")).toBe(true)
  })

  it("SDK 给价 → 原样；未给 → 价表估算；未知模型 → cost NULL（三态，不焊 0）", () => {
    captureNodeUsage(db, RUN, [call({ costUsd: 0.42, messageId: "m-sdk" })])
    captureNodeUsage(db, { ...RUN, nodeId: "n2" }, [call({ model: "unknown-m", messageId: "m-unk" })])
    const sdk = db.prepare("SELECT cost_usd FROM llm_calls WHERE message_id='m-sdk'").get() as { cost_usd: number }
    expect(sdk.cost_usd).toBe(0.42)
    const priced = db.prepare("SELECT cost_usd FROM llm_calls WHERE message_id='m-unk'").get() as { cost_usd: number | null }
    expect(priced.cost_usd).toBeNull()
  })
})

describe("幂等（重放不双计）", () => {
  it("同一次捕获重放两次 → 明细/账本行数与数值不变", () => {
    const calls = [call({ messageId: "m-rep" })]
    const mu: ModelUsage[] = [{ model: "qwen3.8-flash", inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 }]
    captureNodeUsage(db, RUN, calls, mu)
    const snap = () => db.prepare("SELECT * FROM llm_calls").all().length + "|" + JSON.stringify(db.prepare("SELECT input_tokens, output_tokens, cost_usd FROM node_token_usages").all())
    const before = snap()
    captureNodeUsage(db, RUN, calls, mu)
    expect(snap()).toBe(before)
  })
})

describe("负断言：零真实调用 → 零行", () => {
  it("空 calls + 空 modelUsages（模拟 mock 模式）→ 两表皆空", () => {
    captureNodeUsage(db, RUN, [], [])
    captureNodeUsage(db, RUN, [])
    expect((db.prepare("SELECT COUNT(*) c FROM llm_calls").get() as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) c FROM node_token_usages").get() as { c: number }).c).toBe(0)
  })
})

describe("openUsageDb 降级", () => {
  it("库文件不存在 → null；无 llm_calls 表 → null；齐备 → 可写句柄", () => {
    expect(openUsageDb(join(dir, "missing.db"))).toBeNull()
    const bare = new Database(join(dir, "bare.db"))
    bare.exec("CREATE TABLE x (id TEXT)")
    bare.close()
    expect(openUsageDb(join(dir, "bare.db"))).toBeNull()
    const good = openUsageDb(join(dir, "test.db")) // beforeEach 已建表
    expect(good).not.toBeNull()
    expect(typeof resolveCliDbPath()).toBe("string")
    good?.close()
  })

  it("捕获抛错不冒泡（观测不阻断执行）", () => {
    db.exec("DROP TABLE llm_calls") // 写失败注入
    expect(() => captureNodeUsage(db, RUN, [call({})])).not.toThrow()
  })
})
