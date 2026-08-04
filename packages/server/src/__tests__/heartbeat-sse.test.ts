import { describe, it, expect, vi, beforeEach } from "vitest"
import { EngineCallbacks } from "../services/execution/EngineCallbacks"
import type { SSEService } from "../services/sse"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { EnginePool } from "../services/execution/EnginePool"
import type { ObservabilityService } from "../services/observability"

// Minimal mocks
function makeSseMock(): SSEService {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(),
    emitToAll: vi.fn(),
    getMissedEvents: vi.fn(() => []),
    clearBuffer: vi.fn(),
  } as unknown as SSEService
}

function makeDaoMock(): ExecutionDAO {
  return {
    findById: vi.fn(() => ({ workflow_ref: "wf-1" })),
    updateNodeExecution: vi.fn(),
    updateExecution: vi.fn(),
    insertAgentEvent: vi.fn(),
    deleteAgentEventsByNode: vi.fn(),
    updateNodeRetryInfo: vi.fn(),
    updateExecutionProgress: vi.fn(),
    updateNodeExecutionsByStatus: vi.fn(),
    insertNodeExecutionOrIgnore: vi.fn(),
    replaceMergedEvents: vi.fn(),
    insertNodeTokenUsage: vi.fn(),
  } as unknown as ExecutionDAO
}

function makeDeps(overrides: Record<string, any> = {}) {
  const sse = makeSseMock()
  const dao = makeDaoMock()
  return {
    ctx: {
      db: {},
      sse,
      workflowService: {},
      builtInWorkflowService: {},
      org: "test-org",
      workspacePath: "/tmp/ws",
      workspaceDbId: "ws-db-1",
    },
    dao,
    enginePool: { get: vi.fn(() => null) } as unknown as EnginePool,
    observability: {
      bufferEvent: vi.fn(),
      resetDegraded: vi.fn(),
      flushNode: vi.fn(),
      persistLLMCalls: vi.fn(),
    } as unknown as ObservabilityService,
    workspaceId: "ws-sse-id",
    org: "test-org",
    workspaceDbId: "ws-db-1",
    externalCallbacks: new Map(),
    syncStateJson: vi.fn(),
    ...overrides,
    // expose mocks for assertions
    __sse: sse,
    __dao: dao,
  }
}

describe("EngineCallbacks — heartbeat observation", () => {
  it("emits SSE agent_heartbeat when onAgentEvent receives heartbeat type", () => {
    const deps = makeDeps()
    const builder = new EngineCallbacks(deps as any)
    const cb = builder.buildCallbacks("exec-1")

    cb.onAgentEvent!("node-a", {
      type: "heartbeat",
      data: {
        step: 3,
        tokens_used: 1200,
        tokens_budget: 10000,
        artifacts: [],
        issues: [],
        confidence: -1,
        current_activity: "reading file",
      },
    })

    const emit = deps.__sse.emit as any
    // Should emit both agent_event (existing) and agent_heartbeat
    const calls = emit.mock.calls.map((c: any[]) => c[1].event)
    expect(calls).toContain("agent_heartbeat")
    const hbCall = emit.mock.calls.find((c: any[]) => c[1].event === "agent_heartbeat")
    expect(hbCall[1].data).toMatchObject({
      executionId: "exec-1",
      nodeId: "node-a",
      heartbeat: expect.objectContaining({ step: 3, tokens_used: 1200 }),
    })
  })

  it("emits SSE heartbeat_stall when onAgentEvent receives heartbeat_stall type", () => {
    const deps = makeDeps()
    const builder = new EngineCallbacks(deps as any)
    const cb = builder.buildCallbacks("exec-2")

    cb.onAgentEvent!("node-b", { type: "heartbeat_stall", data: { nodeId: "node-b" } })

    const emit = deps.__sse.emit as any
    const calls = emit.mock.calls.map((c: any[]) => c[1].event)
    expect(calls).toContain("heartbeat_stall")
    const stallCall = emit.mock.calls.find((c: any[]) => c[1].event === "heartbeat_stall")
    expect(stallCall[1].data).toMatchObject({
      executionId: "exec-2",
      nodeId: "node-b",
    })
  })

  it("emits SSE harness_directive when onAgentEvent receives harness_directive type", () => {
    const deps = makeDeps()
    const builder = new EngineCallbacks(deps as any)
    const cb = builder.buildCallbacks("exec-3")

    cb.onAgentEvent!("node-c", {
      type: "harness_directive",
      data: {
        type: "abort",
        reason: "budget exceeded",
        issued_by: "harness",
        timestamp: 1000,
      },
    })

    const emit = deps.__sse.emit as any
    const calls = emit.mock.calls.map((c: any[]) => c[1].event)
    expect(calls).toContain("harness_directive")
    const dirCall = emit.mock.calls.find((c: any[]) => c[1].event === "harness_directive")
    expect(dirCall[1].data).toMatchObject({
      executionId: "exec-3",
      nodeId: "node-c",
      directive: expect.objectContaining({ type: "abort" }),
    })
  })
})
