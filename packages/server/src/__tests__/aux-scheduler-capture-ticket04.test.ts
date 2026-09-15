import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"

// —— 模块级 fake：providers 统一流 + db 单例指向测试内存库 ——
const h = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  stream: null as null | (() => AsyncGenerator<unknown>),
  calls: 0,
}))

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>()
  return { ...actual, getDb: () => h.db }
})

vi.mock("@octopus/providers", () => ({
  getProvider: () => ({
    sendQuery: () => { h.calls++; return h.stream!() },
  }),
}))

// SchedulerAdapter 要求 initMemoryService() 先行（生产由 server 启动完成）—— 测试桩
vi.mock("../services/agent/memory-service", () => ({
  getMemoryService: () => ({
    readRecentWorkMemory: () => "",
    appendWorkMemory: () => {},
  }),
}))

import { captureAuxCall } from "../services/agent/aux-usage-capture"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { AgentExecutor } from "../services/scheduler/executors/agent-executor"
import { SchedulerAdapter } from "../services/agent/scheduler-adapter"
import { ArchiveAnalysisService } from "../services/archive/archive-analysis-service"
import { ExperienceMerger } from "../services/archive/experience-merger"
import { ArchiveService } from "../services/archive/archive-service"
import { LLM_CALL_SOURCE } from "@octopus/shared"

const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 }
const MODEL = "claude-sonnet-4-5-20250827"

function* defaultStream() {
  yield { type: "text_delta", content: "hello" }
  yield { type: "result", usage: USAGE, modelUsages: [{ model: MODEL, ...USAGE }], costUsd: 0.01 }
}

beforeEach(() => {
  h.db = new Database(":memory:")
  applySchema(h.db)
  h.db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'T', '/tmp/t', 'o1', datetime('now'), datetime('now'))").run()
  h.stream = defaultStream as never
})

afterEach(() => h.db.close())

const rows = () => h.db.prepare("SELECT id, source, trace_id, workspace_id, input_tokens, output_tokens, cost_usd FROM llm_calls ORDER BY id").all() as Array<Record<string, unknown>>
const ledger = () => h.db.prepare("SELECT id, source, trace_id, session_id, input_tokens, output_tokens, cost_usd FROM node_token_usages ORDER BY id").all() as Array<Record<string, unknown>>

describe("captureAuxCall（helper）", () => {
  it("明细+账本各一行，账本=Σ明细，source/trace 落值；重放零双计", () => {
    captureAuxCall(h.db, { source: LLM_CALL_SOURCE.aux_memory, traceId: "t-1", usage: USAGE, model: MODEL, costUsd: 0.02, workspaceId: "ws-1", org: "o1" })
    expect(rows()).toHaveLength(1)
    expect(ledger()).toHaveLength(1)
    const d = rows()[0], l = ledger()[0]
    expect(d.source).toBe("aux_memory")
    expect(l.source).toBe("aux_memory")
    expect(d.trace_id).toBe("t-1")
    expect(l.trace_id).toBe("t-1")
    expect([l.input_tokens, l.output_tokens, l.cost_usd]).toEqual([d.input_tokens, d.output_tokens, d.cost_usd])
    // 重放（同 trace）—— 明细 OR IGNORE + 账本存在性跳过 → 不双计
    captureAuxCall(h.db, { source: LLM_CALL_SOURCE.aux_memory, traceId: "t-1", usage: USAGE, model: MODEL, costUsd: 0.02, workspaceId: "ws-1", org: "o1" })
    expect(rows()).toHaveLength(1)
    expect(ledger()).toHaveLength(1)
  })

  it("modelUsages 多模型 → 每 model 明细+账本各一行，账本 Σ = 明细 Σ", () => {
    const u2 = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 }
    captureAuxCall(h.db, { source: LLM_CALL_SOURCE.scheduler, traceId: "r-1", modelUsages: [{ model: MODEL, ...USAGE }, { model: "m2", ...u2 }] })
    expect(rows()).toHaveLength(2)
    expect(ledger()).toHaveLength(2)
    const sum = (rs: Array<Record<string, unknown>>) => rs.reduce((a, r) => a + (r.input_tokens as number), 0)
    expect(sum(ledger())).toBe(sum(rows()))
  })

  it("无 usage（SDK 死流）→ 不落行（不编数）", () => {
    captureAuxCall(h.db, { source: LLM_CALL_SOURCE.aux_memory, traceId: "t-0", usage: null })
    expect(rows()).toHaveLength(0)
    expect(ledger()).toHaveLength(0)
  })

  it("db 取用抛错 → 只 stderr，不抛出", () => {
    expect(() => captureAuxCall(() => { throw new Error("no db") }, { source: LLM_CALL_SOURCE.aux_suggest, traceId: "t-x", usage: USAGE, model: MODEL })).not.toThrow()
  })
})

describe("挂点 1+2: scheduler（AgentExecutor / SchedulerAdapter，均不走 chat()）", () => {
  it("AgentExecutor.runOnce 真触发 → llm_calls + 账本各一行 source=scheduler，trace=schedule run", async () => {
    const runDAO = { markExecutionRunning: vi.fn(), setAgentResult: vi.fn(), setExecutionResult: vi.fn() } as never
    const execDAO = { getDb: () => h.db, findWorkspacePath: () => "/tmp/t" } as never
    const provider = { sendQuery: () => h.stream!() } as never
    const executor = new AgentExecutor(runDAO, execDAO, provider)
    const job = {
      id: "j-1", org: "o1", workspace_id: "ws-1",
      config: { type: "agent", schema_version: "1.0", prompt: "hi", model: "default", timeout_seconds: 5 },
    } as never
    const res = await executor.execute(job, "sched-run-9")
    expect(res.success).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(ledger()).toHaveLength(1)
    expect(rows()[0].source).toBe("scheduler")
    expect(rows()[0].trace_id).toBe("sched-run-9")
    expect(ledger()[0].source).toBe("scheduler")
  })

  it("SchedulerAdapter.executeJob 真触发 → source=scheduler 落库", async () => {
    h.calls = 0
    const adapter = new SchedulerAdapter("o1")
    vi.spyOn(adapter as never as { writeReport(p: string, c: string): void }, "writeReport").mockImplementation(() => {})
    const result = await adapter.executeJob({
      name: "nightly", cron: "0 3 * * * ", prompt: "do",
      memory_strategy: { read_recent_days: 1, read_last_report: false, write_report_path: "x/{date}.md" },
      notify_strategy: { on_success: false, on_failure: false, channels: [] },
      created_at: "", updated_at: "",
    } as never)
    if (result.status !== "success") console.log("ADAPTER-ERR:", result.error)
    expect(result.status).toBe("success")
    expect(h.calls, "mocked provider 应被 executeJob 真调用（否则走了降级路径）").toBeGreaterThan(0)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("scheduler")
    expect(ledger()).toHaveLength(1)
    expect((rows()[0].trace_id as string).length).toBeGreaterThan(8)
  })
})

describe("挂点 3: aux_memory（archive 分身 LLM 三处）", () => {
  it("ArchiveAnalysisService.callArchiveLLM → aux_memory + workspace/trace 归因", async () => {
    const svc = new ArchiveAnalysisService("o1")
    const raw = await (svc as never as {
      callArchiveLLM(p: string, s: string, w: string, t: string): Promise<string>
    }).callArchiveLLM("prompt", "sys", "ws-1", "archive-analysis:ws-1:tr-1")
    expect(raw).toBe("hello")
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("aux_memory")
    expect(rows()[0].trace_id).toBe("archive-analysis:ws-1:tr-1")
    expect(rows()[0].workspace_id).toBe("ws-1")
    expect(ledger()).toHaveLength(1)
  })

  it("ExperienceMerger.callMergeAgent → aux_memory + org 归因", async () => {
    const raw = await (new ExperienceMerger() as never as {
      callMergeAgent(p: string, o: string, t: string): Promise<string | null>
    }).callMergeAgent("prompt", "o1", "merge:o1:tr-2")
    expect(raw).toBe("hello")
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("aux_memory")
    expect((rows()[0].trace_id as string).startsWith("merge:o1:tr-2")).toBe(true)
    expect(ledger()).toHaveLength(1)
  })

  it("ArchiveService.extractExperiences（workspace 有上下文）→ aux_memory 落库", async () => {
    await (ArchiveService.prototype as never as {
      extractExperiences(this: unknown, w: string, o: string, e: string[]): Promise<number>
    }).extractExperiences.call({ db: h.db }, "ws-1", "o1", [])
    // 流给的不是合法 JSON 数组 → 提取 0 条，但 usage 捕获发生在流终局（不受解析失败影响）
    expect(rows()).toHaveLength(1)
    expect(rows()[0].source).toBe("aux_memory")
    expect(rows()[0].workspace_id).toBe("ws-1")
    expect((rows()[0].trace_id as string).startsWith("archive:ws-1:")).toBe(true)
    expect(ledger()).toHaveLength(1)
  })
})

describe("账本入口对称（KD3）", () => {
  it("recordNodeUsage 接受 scheduler/aux_* 词表（唯一入口不另开口子）", () => {
    const dao = new TokenUsageDAO(h.db)
    expect(() => dao.recordNodeUsage({
      id: "scheduler:probe:m", nodeExecutionId: null, model: "m", usage: USAGE,
      source: LLM_CALL_SOURCE.aux_compress, createdAt: new Date().toISOString(), traceId: "probe",
    })).not.toThrow()
  })
})
