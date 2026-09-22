import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import {
  recordLlmCall, composeLlmCallRow, recordProviderResultUsage,
  type LlmCallLedgerInput,
} from "../services/llm-call-ledger"
import type { LlmCallSourcePath } from "@octopus/shared"

/**
 * billing-coverage-2 票01 + billing NEW-r2 —— 共用落账 helper（单一函数，所有路径经它写
 * llm_calls）。NEW-r2 翻转：行 = **纯事实**（token + 归属 + 来源），钱不落账本；
 * 费用一律查询时经 llm_calls_costed 视图派生（算价断言在 billing-wiring / 各路由测试）。
 * 本文件钉：行形状、source_path 枚举防线、normalizeModelId 双端之落账端、
 * recordProviderResultUsage 各分支（每 modelUsage 一行 / 全零不记 / 兜底行 / 旁路吞异常）。
 */
let db: Database.Database
let dao: TokenUsageDAO

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new TokenUsageDAO(db)
})

afterEach(() => {
  db.close()
})

function fullInput(over: Partial<LlmCallLedgerInput> = {}): LlmCallLedgerInput {
  return {
    id: "call-1",
    sourcePath: "clone_chat",
    nodeExecutionId: null,
    executionId: null,
    turnIndex: 2,
    callIndex: 1,
    model: "claude-sonnet-4-5-20250827",
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 },
    timestamp: 1700000000000,
    durationMs: 420,
    messageId: "m1",
    stopReason: "end_turn",
    ttftMs: 90,
    org: "test-org",
    workspaceId: "ws-1",
    workflowRef: null,
    nodeId: "n1",
    sessionId: "sess-9",
    instanceId: "inst-1",
    ...over,
  }
}

function row(id: string) {
  return db.prepare("SELECT * FROM llm_calls WHERE id = ?").get(id) as Record<string, unknown>
}

const FACT_COLS = [
  "id", "node_execution_id", "execution_id", "turn_index", "call_index", "message_id",
  "model", "stop_reason", "timestamp", "duration_ms", "ttft_ms",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
  "org", "workspace_id", "workflow_ref", "node_id", "session_id", "instance_id", "source_path",
]

describe("共用落账 helper —— recordLlmCall 行形状 = 纯事实", () => {
  it("四类 token + 归属维度 + 来源如实落库；无任何 cost 列", () => {
    recordLlmCall(fullInput(), dao)
    const r = row("call-1")
    expect(r).toMatchObject({
      source_path: "clone_chat",
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      model: "claude-sonnet-4-5-20250827",
      turn_index: 2, call_index: 1,
      message_id: "m1", stop_reason: "end_turn", timestamp: 1700000000000,
      duration_ms: 420, ttft_ms: 90, org: "test-org", workspace_id: "ws-1",
      node_id: "n1", session_id: "sess-9", instance_id: "inst-1",
    })
    expect(Object.keys(r).sort()).toEqual([...FACT_COLS].sort()) // 行形状封闭：不得长出快照列
  })

  it("归属缺失如实 NULL（KD17），可选字段缺省补 NULL", () => {
    recordLlmCall(fullInput({ nodeExecutionId: null, executionId: null, messageId: undefined, stopReason: undefined, ttftMs: undefined }), dao)
    expect(row("call-1")).toMatchObject({
      node_execution_id: null, execution_id: null, message_id: null, stop_reason: null, ttft_ms: null,
    })
  })

  it("composeLlmCallRow 纯函数与 recordLlmCall 落库同形（批量路径复用同一组行逻辑）", () => {
    const composed = composeLlmCallRow(fullInput())
    recordLlmCall(fullInput(), dao)
    expect(row("call-1")).toEqual({ ...composed })
  })
})

describe("模型名归一化（normalizeModelId，Q9 落账端）", () => {
  it("`qwen3.8-flash[1M]` → `qwen3.8-flash`；叠加残渣到不动点 `x[1M]][1M]` → `x`", () => {
    recordLlmCall(fullInput({ id: "n1", model: "qwen3.8-flash[1M]" }), dao)
    expect(row("n1").model).toBe("qwen3.8-flash")
    recordLlmCall(fullInput({ id: "n2", model: "x[1M]][1M]" }), dao)
    expect(row("n2").model).toBe("x")
  })

  it("中段括号不动（`a[beta]-v2` 原样）；null model 原样 NULL", () => {
    recordLlmCall(fullInput({ id: "n3", model: "a[beta]-v2" }), dao)
    expect(row("n3").model).toBe("a[beta]-v2")
    recordLlmCall(fullInput({ id: "n4", model: null }), dao)
    expect(row("n4").model).toBeNull()
  })
})

describe("source_path 枚举防线（AC2 / KD20）", () => {
  it("七枚举值全部可写（合法域）", () => {
    const all: LlmCallSourcePath[] = ["workflow", "interaction", "harness", "clone_chat", "global_chat", "session_compress", "unknown"]
    all.forEach((p, i) => recordLlmCall(fullInput({ id: `call-enum-${i}`, sourcePath: p }), dao))
    const got = (db.prepare(
      "SELECT source_path FROM llm_calls WHERE id LIKE 'call-enum-%' ORDER BY CAST(substr(id, 11) AS INTEGER)",
    ).all() as Array<{ source_path: string }>).map(r => r.source_path)
    expect(got).toEqual(all)
  })

  it("非法 source_path → 直接抛（不落库，防线在 helper 不在 DAO）", () => {
    expect(() => recordLlmCall(fullInput({ sourcePath: "bogus_path" as LlmCallSourcePath }), dao)).toThrow(/source_path/)
    expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
  })
})

describe("recordProviderResultUsage —— result chunk 入账各分支", () => {
  const base = {
    sourcePath: "clone_chat" as LlmCallSourcePath,
    nodeExecutionId: null, executionId: null, sessionId: "s-1",
    startedAtMs: Date.now() - 500,
  }

  it("多 modelUsages → 每行一条（模型粒度），call_index 递增，stop_reason=end_turn", () => {
    recordProviderResultUsage({
      ...base,
      modelUsages: [
        { model: "model-a", inputTokens: 100, outputTokens: 10 },
        { model: "model-b", inputTokens: 200, outputTokens: 20, cacheReadTokens: 5 },
      ],
      usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 5, cacheCreationTokens: 0 },
    }, dao)
    const rows = db.prepare("SELECT * FROM llm_calls ORDER BY call_index").all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.model)).toEqual(["model-a", "model-b"])
    expect(rows.map(r => r.call_index)).toEqual([0, 1])
    expect(rows.every(r => r.stop_reason === "end_turn" && r.turn_index === 1)).toBe(true)
    expect(rows[1]).toMatchObject({ input_tokens: 200, output_tokens: 20, cache_read_tokens: 5, cache_creation_tokens: 0 })
    expect(Number(rows[0].duration_ms)).toBeGreaterThanOrEqual(500) // startedAtMs 差值口径
  })

  it("modelUsages 中全零条目被过滤（无真值不记），非零条目照常入账", () => {
    recordProviderResultUsage({
      ...base,
      modelUsages: [
        { model: "zero-m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        { model: "real-m", inputTokens: 1, outputTokens: 1 },
      ],
    }, dao)
    const rows = db.prepare("SELECT model FROM llm_calls").all() as Array<{ model: string }>
    expect(rows).toEqual([{ model: "real-m" }])
  })

  it("modelUsages 全零且 usage 也全零 → 一行不记（绝不造数）", () => {
    recordProviderResultUsage({
      ...base,
      modelUsages: [{ model: "zero-m", inputTokens: 0 }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }, dao)
    expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
  })

  it("缺 modelUsages → usage+fallbackModel 兜底一行；model 也归一化", () => {
    recordProviderResultUsage({
      ...base,
      usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 3, cacheCreationTokens: 2 },
      fallbackModel: "qwen3.8-flash[1M]",
    }, dao)
    const rows = db.prepare("SELECT * FROM llm_calls").all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: "qwen3.8-flash", input_tokens: 40, output_tokens: 8, cache_read_tokens: 3, cache_creation_tokens: 2 })
  })

  it("usage 与 modelUsages 都缺 → 不记（无真值）", () => {
    recordProviderResultUsage(base, dao)
    expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
  })

  it("纯旁路：非法 sourcePath 在 helper 内被吞（log 不抛），不断聊天主流水", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => recordProviderResultUsage({
        ...base, sourcePath: "bogus" as LlmCallSourcePath,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }, dao)).not.toThrow()
      expect(db.prepare("SELECT COUNT(*) c FROM llm_calls").get()).toEqual({ c: 0 })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
