import { describe, it, expect, vi } from "vitest"
import { ObservabilityService } from "../services/observability"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { AgentEvent } from "@octopus/engine"

function makeDaoMock() {
  return {
    insertAgentEventBatch: vi.fn(),
    findById: vi.fn(),
    updateNodeExecution: vi.fn(),
    updateExecution: vi.fn(),
    insertAgentEvent: vi.fn(),
    deleteAgentEventsByNode: vi.fn(),
    updateNodeRetryInfo: vi.fn(),
    updateExecutionProgress: vi.fn(),
    updateNodeExecutionsByStatus: vi.fn(),
    insertNodeExecutionOrIgnore: vi.fn(),
    replaceMergedEvents: vi.fn(),
  } as unknown as ExecutionDAO
}

function makeTokenDaoMock() {
  return {
    recordNodeUsage: vi.fn(),
    insertBatch: vi.fn(),
    findByNodeExecutionId: vi.fn(() => []),
    aggregateByModel: vi.fn(() => []),
  } as any
}

function makeMeta() {
  return {
    executionId: "exec-1",
    nodeId: "node-a",
    org: "test-org",
    workspaceId: "ws-1",
    workflowRef: "test.yaml",
  }
}

describe("ObservabilityService.filterEvent — heartbeat events", () => {
  it("does NOT filter heartbeat events (they reach the DAO)", () => {
    const dao = makeDaoMock()
    const tokenDao = makeTokenDaoMock()
    const obs = new ObservabilityService(dao, tokenDao)

    const heartbeatEvent: AgentEvent = {
      type: "heartbeat",
      data: {
        step: 3,
        tokens_used: 1200,
        tokens_budget: 10000,
        artifacts: [],
        issues: [],
        confidence: 0.8,
        current_activity: "reading file",
      },
    } as AgentEvent

    obs.bufferEvent("node-exec-1", heartbeatEvent, makeMeta())
    obs.flushNode("node-exec-1")

    expect(dao.insertAgentEventBatch).toHaveBeenCalledTimes(1)
    const rows = (dao.insertAgentEventBatch as any).mock.calls[0][0]
    expect(rows.length).toBe(1)
    expect(rows[0].event_type).toBe("heartbeat")
    // Content should contain JSON-serialized heartbeat data
    const content = JSON.parse(rows[0].content)
    expect(content.step).toBe(3)
    expect(content.tokens_used).toBe(1200)
    expect(content.current_activity).toBe("reading file")
  })

  it("does NOT filter harness_directive events (they reach the DAO)", () => {
    const dao = makeDaoMock()
    const tokenDao = makeTokenDaoMock()
    const obs = new ObservabilityService(dao, tokenDao)

    const directiveEvent: AgentEvent = {
      type: "harness_directive",
      data: {
        type: "abort",
        reason: "budget exceeded",
        issued_by: "harness",
        timestamp: 1000,
      },
    } as AgentEvent

    obs.bufferEvent("node-exec-2", directiveEvent, makeMeta())
    obs.flushNode("node-exec-2")

    expect(dao.insertAgentEventBatch).toHaveBeenCalledTimes(1)
    const rows = (dao.insertAgentEventBatch as any).mock.calls[0][0]
    expect(rows.length).toBe(1)
    expect(rows[0].event_type).toBe("harness_directive")
    const content = JSON.parse(rows[0].content)
    expect(content.type).toBe("abort")
    expect(content.reason).toBe("budget exceeded")
  })

  it("does NOT filter heartbeat_stall events (they reach the DAO)", () => {
    const dao = makeDaoMock()
    const tokenDao = makeTokenDaoMock()
    const obs = new ObservabilityService(dao, tokenDao)

    const stallEvent: AgentEvent = {
      type: "heartbeat_stall",
      data: { nodeId: "node-a" },
    } as AgentEvent

    obs.bufferEvent("node-exec-3", stallEvent, makeMeta())
    obs.flushNode("node-exec-3")

    expect(dao.insertAgentEventBatch).toHaveBeenCalledTimes(1)
    const rows = (dao.insertAgentEventBatch as any).mock.calls[0][0]
    expect(rows.length).toBe(1)
    expect(rows[0].event_type).toBe("heartbeat_stall")
    const content = JSON.parse(rows[0].content)
    expect(content.nodeId).toBe("node-a")
  })

  it("still filters normal events (thinking, tool_start, etc.) as before", () => {
    const dao = makeDaoMock()
    const tokenDao = makeTokenDaoMock()
    const obs = new ObservabilityService(dao, tokenDao)

    const thinkingEvent: AgentEvent = {
      type: "thinking",
      content: "Let me analyze this...",
      timestamp: Date.now(),
    }

    obs.bufferEvent("node-exec-4", thinkingEvent, makeMeta())
    obs.flushNode("node-exec-4")

    expect(dao.insertAgentEventBatch).toHaveBeenCalledTimes(1)
    const rows = (dao.insertAgentEventBatch as any).mock.calls[0][0]
    expect(rows.length).toBe(1)
    expect(rows[0].event_type).toBe("thinking")
  })
})
