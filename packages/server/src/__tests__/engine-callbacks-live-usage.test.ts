// packages/server/src/__tests__/engine-callbacks-live-usage.test.ts
//
// F1（2026-09-21「token 时隐时现」）：EngineCallbacks 的 turn_usage 实时累计投影。
// 契约：① turn_usage 写入（含子流 scoped nodeId —— 桥在引擎层已完成，这里只是
// 同一入口）；② 非 turn_usage 不写；③ node_start 重试归零；④ node_end 删除
// （DB modelUsages 接管）；⑤ onComplete 整表作废。GET /executions/:id 经
// service.getLiveUsage 消费，快照即自愈、刷新不清零。
import { describe, it, expect, vi } from "vitest"
import { EngineCallbacks } from "../services/execution/EngineCallbacks"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { EnginePool } from "../services/execution/EnginePool"
import type { ObservabilityService } from "../services/observability"
import type { ServiceContext } from "../services/execution/types"

function makeMocks() {
  const sseEmit = vi.fn()
  const dao = {
    findById: vi.fn().mockReturnValue({
      id: "exec-1", status: "running", budget_snapshot: null,
      started_at: "2026-09-21T00:00:00.000Z", instance_id: "inst-1",
      branch: "main", workflow_ref: "test.yaml",
    }),
    updateNodeExecution: vi.fn(),
    updateExecution: vi.fn(),
    updateExecutionProgress: vi.fn(),
    deleteAgentEventsByNode: vi.fn(),
    insertAgentEvent: vi.fn(),
    updateNodeRetryInfo: vi.fn(),
    insertNodeExecutionOrIgnore: vi.fn(),
    replaceMergedEvents: vi.fn(),
  } as unknown as ExecutionDAO
  const tokenUsageDao = {
    recordNodeUsage: vi.fn(),
    aggregateByExecution: vi.fn().mockReturnValue({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totals: { tokens: 0, cost: { usd: 0, complete: true }, cacheHitRate: null },
      totalLlmTurns: 0, errorCount: 0,
    }),
  } as unknown as TokenUsageDAO
  const enginePool = {
    get: vi.fn(() => ({ engine: { getGlobalSessionId: vi.fn(() => "gsid-1") }, abortController: { abort: vi.fn() } })),
    cancel: vi.fn(),
  } as unknown as EnginePool
  const observability = {
    resetNodeBuffer: vi.fn(), resetDegraded: vi.fn(), flushNode: vi.fn(),
    persistLLMCalls: vi.fn(), bufferEvent: vi.fn(),
  } as unknown as ObservabilityService
  const ctx = {
    db: {} as any, sse: { emit: sseEmit } as any, workflowService: {} as any,
    builtInWorkflowService: {} as any, org: "test-org", workspacePath: "/tmp/test", workspaceDbId: "ws-db-1",
  } as ServiceContext
  return { dao, tokenUsageDao, enginePool, observability, ctx, sseEmit, syncStateJson: vi.fn() }
}

function build(mocks: ReturnType<typeof makeMocks>) {
  const builder = new EngineCallbacks({
    ctx: mocks.ctx, dao: mocks.dao, tokenUsageDao: mocks.tokenUsageDao,
    enginePool: mocks.enginePool, observability: mocks.observability,
    workspaceId: "ws-1", org: "test-org", workspaceDbId: "ws-db-1",
    externalCallbacks: new Map(), syncStateJson: mocks.syncStateJson,
  })
  return { builder, cb: builder.buildCallbacks("exec-1") }
}

const CUM = { inputTokens: 10, outputTokens: 42, cacheReadTokens: 100, cacheCreationTokens: 5 }

describe("EngineCallbacks — F1 liveUsage 实时累计投影", () => {
  it("turn_usage → cumulative 落表（含 scoped 子节点 id 直穿）", () => {
    const { builder, cb } = build(makeMocks())
    cb.onAgentEvent("n1", { type: "turn_usage", turn: 3, delta: { outputTokens: 7 }, cumulative: CUM } as any)
    cb.onAgentEvent("ticket-dag:ticket-01", { type: "turn_usage", turn: 1, delta: {}, cumulative: { ...CUM, outputTokens: 9 } } as any)
    const m = builder.liveUsageFor("exec-1")
    expect(m?.get("n1")?.usage).toEqual(CUM)
    expect(m?.get("n1")?.turn).toBe(3)
    expect(m?.get("ticket-dag:ticket-01")?.usage.outputTokens).toBe(9)
  })

  it("非 turn_usage 事件不写表", () => {
    const { builder, cb } = build(makeMocks())
    cb.onAgentEvent("n1", { type: "text_delta", content: "hi" } as any)
    expect(builder.liveUsageFor("exec-1")?.get("n1")).toBeUndefined()
  })

  it("node_start（重试/重跑）→ 该节点归零", () => {
    const { builder, cb } = build(makeMocks())
    cb.onAgentEvent("n1", { type: "turn_usage", turn: 2, delta: {}, cumulative: CUM } as any)
    cb.onNodeStart("n1", "agent")
    expect(builder.liveUsageFor("exec-1")?.get("n1")).toBeUndefined()
  })

  it("node_end → 投影退场（recordNodeUsage 已是权威）", () => {
    const { builder, cb } = build(makeMocks())
    cb.onAgentEvent("n1", { type: "turn_usage", turn: 2, delta: {}, cumulative: CUM } as any)
    cb.onNodeEnd("n1", "completed", 1000, { status: "completed", durationMs: 1000, outputs: {}, logLines: [] })
    expect(builder.liveUsageFor("exec-1")?.get("n1")).toBeUndefined()
  })

  it("onComplete → 整张执行表作废", () => {
    const { builder, cb } = build(makeMocks())
    cb.onAgentEvent("n1", { type: "turn_usage", turn: 2, delta: {}, cumulative: CUM } as any)
    cb.onAgentEvent("n2", { type: "turn_usage", turn: 1, delta: {}, cumulative: CUM } as any)
    cb.onComplete("completed")
    expect(builder.liveUsageFor("exec-1")).toBeUndefined()
  })
})
