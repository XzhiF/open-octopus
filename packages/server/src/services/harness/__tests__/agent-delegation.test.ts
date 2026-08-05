// packages/server/src/services/harness/__tests__/agent-delegation.test.ts
//
// Unit tests for the AgentDelegationService (Layer 3).
// Tests delegation prompt construction, response parsing, timeout handling,
// token recording, and SSE event emission.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  AgentDelegationService,
  buildDelegationPrompt,
  parseDelegationResponse,
  type DelegationContext,
  type DelegationResult,
} from "../agent-delegation"
import type { DiagnosisReport } from "@octopus/shared"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
  return {
    id: "report-1",
    timestamp: Date.now(),
    detector: "stupid_retry",
    severity: "warning",
    executionId: "exec-1",
    nodeId: "bash-build",
    nodeType: "bash",
    pattern: "stupid_retry",
    evidence: [
      { attempt: 1, errorHash: "abc123", errorMessage: "Cannot find module 'xyz'" },
      { attempt: 2, errorHash: "abc123", errorMessage: "Cannot find module 'xyz'" },
    ],
    context: { retryCount: 2, nodeDurationMs: 5000, workflowProgress: 0.5 },
    ...overrides,
  }
}

function makeContext(overrides: Partial<DelegationContext> = {}): DelegationContext {
  return {
    recentEvents: [
      { type: "node_start", nodeId: "bash-build" },
      { type: "node_end", nodeId: "bash-build", status: "failed" },
    ],
    varpoolSnapshot: { working_dir: "/project", node_version: "18" },
    nodeConfig: { id: "bash-build", type: "bash", script: "npm run build" },
    workflowContent: "name: test\nnodes:\n  - id: bash-build\n    type: bash\n    script: npm run build",
    ...overrides,
  }
}

// ─── Prompt Construction ────────────────────────────────────────────────────

describe("buildDelegationPrompt", () => {
  it("includes detector, severity, nodeId, nodeType, and pattern", () => {
    const report = makeReport()
    const context = makeContext()
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("stupid_retry")
    expect(prompt).toContain("warning")
    expect(prompt).toContain("bash-build")
    expect(prompt).toContain("bash")
  })

  it("includes evidence as bullet points", () => {
    const report = makeReport()
    const context = makeContext()
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("Cannot find module")
    expect(prompt).toContain("abc123")
  })

  it("includes execution context (retryCount, nodeDurationMs, workflowProgress)", () => {
    const report = makeReport()
    const context = makeContext()
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("2")  // retryCount
    expect(prompt).toContain("5000")  // nodeDurationMs
    expect(prompt).toContain("50")  // workflowProgress as percentage
  })

  it("includes recent events summary", () => {
    const report = makeReport()
    const context = makeContext({
      recentEvents: [
        { type: "node_start", nodeId: "bash-build" },
        { type: "node_end", nodeId: "bash-build", status: "failed" },
      ],
    })
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("node_start")
    expect(prompt).toContain("node_end")
  })

  it("includes varpool snapshot", () => {
    const report = makeReport()
    const context = makeContext({
      varpoolSnapshot: { working_dir: "/project", api_key: "secret123" },
    })
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("working_dir")
    expect(prompt).toContain("/project")
  })

  it("includes the four intervention types in instructions", () => {
    const report = makeReport()
    const context = makeContext()
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("inject")
    expect(prompt).toContain("varpool")
    expect(prompt).toContain("definition")
    expect(prompt).toContain("takeover")
  })

  it("limits recent events to last 20", () => {
    const manyEvents = Array.from({ length: 30 }, (_, i) => ({
      type: "event",
      index: i,
    }))
    const report = makeReport()
    const context = makeContext({ recentEvents: manyEvents })
    const prompt = buildDelegationPrompt(report, context)

    // Should contain event 29 (last) but not event 0 (first, trimmed)
    expect(prompt).toContain("29")
    expect(prompt).not.toContain('"index": 0')
  })
})

// ─── Response Parsing ───────────────────────────────────────────────────────

describe("parseDelegationResponse", () => {
  it("parses valid JSON response with inject intervention", () => {
    const rawText = JSON.stringify({
      interventionType: "inject",
      data: { message: "Try installing dependencies first" },
      reasoning: "The error indicates missing module",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("inject")
    expect(result.interventionData).toEqual({ message: "Try installing dependencies first" })
    expect(result.reasoning).toContain("missing module")
  })

  it("parses valid JSON response with varpool intervention", () => {
    const rawText = JSON.stringify({
      interventionType: "varpool",
      data: { key: "build_target", value: "production" },
      reasoning: "Wrong build target",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("varpool")
  })

  it("parses valid JSON response with definition intervention", () => {
    const rawText = JSON.stringify({
      interventionType: "definition",
      data: { field: "script", value: "npm install && npm run build" },
      reasoning: "Need to install first",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("definition")
  })

  it("parses valid JSON response with takeover intervention", () => {
    const rawText = JSON.stringify({
      interventionType: "takeover",
      data: { script: "npm install xyz && npm run build" },
      reasoning: "Complex script fix needed",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("takeover")
  })

  it("extracts JSON from markdown code block", () => {
    const rawText = `Here's my analysis:
\`\`\`json
{
  "interventionType": "inject",
  "data": { "message": "fix it" },
  "reasoning": "simple fix"
}
\`\`\`
`
    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("inject")
  })

  it("extracts JSON from surrounding text", () => {
    const rawText = `Based on my analysis, here is the intervention:
{"interventionType": "varpool", "data": {"key": "x", "value": "y"}, "reasoning": "wrong value"}
This should fix the issue.`

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("varpool")
  })

  it("returns failure for invalid JSON", () => {
    const rawText = "This is not JSON at all"

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("parse")
  })

  it("returns failure for missing interventionType", () => {
    const rawText = JSON.stringify({
      data: { message: "fix" },
      reasoning: "missing type",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
  })

  it("returns failure for invalid interventionType", () => {
    const rawText = JSON.stringify({
      interventionType: "invalid_type",
      data: { message: "fix" },
      reasoning: "wrong type",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
  })
})

// ─── AgentDelegationService.delegate ────────────────────────────────────────

describe("AgentDelegationService — delegate", () => {
  let service: AgentDelegationService
  let mockDao: any
  let mockSse: any
  let mockLLMCall: ReturnType<typeof vi.fn>
  let mockGetProvider: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDao = {
      insertEvent: vi.fn(),
      insertTokenUsage: vi.fn(),
      insertHarnessTokenUsage: vi.fn(),
      createNodeExecution: vi.fn(),
      updateNodeExecution: vi.fn(),
    }

    mockSse = {
      emit: vi.fn(),
    }

    mockLLMCall = vi.fn()
    mockGetProvider = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createService(opts?: { timeoutMs?: number }) {
    return new AgentDelegationService({
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
      llmCall: mockLLMCall,
      timeoutMs: opts?.timeoutMs,
    })
  }

  it("creates a virtual node_execution record for token tracking", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "inject",
        data: { message: "fix" },
        reasoning: "analysis",
      }),
      tokenUsage: { input: 100, output: 50, model: "claude-sonnet-4-20250514" },
    })

    const service = createService()
    await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(mockDao.insertEvent).toHaveBeenCalled()
    const eventCall = mockDao.insertEvent.mock.calls[0][0]
    expect(eventCall.event_type).toBe("delegation")
  })

  it("emits SSE harness_delegation start and complete events", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "inject",
        data: { message: "fix" },
        reasoning: "analysis",
      }),
      tokenUsage: { input: 100, output: 50, model: "claude-sonnet-4-20250514" },
    })

    const service = createService()
    await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    const emitCalls = mockSse.emit.mock.calls
    const delegationEvents = emitCalls.filter(
      (call: any) => call[1].event === "harness_delegation",
    )

    expect(delegationEvents.length).toBe(2) // start + complete
    expect(delegationEvents[0][1].data.status).toBe("start")
    expect(delegationEvents[1][1].data.status).toBe("complete")
  })

  it("records token usage with source='harness'", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "inject",
        data: { message: "fix" },
        reasoning: "analysis",
      }),
      tokenUsage: { input: 100, output: 50, model: "claude-sonnet-4-20250514" },
    })

    const service = createService()
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    // Token usage should be recorded via insertHarnessTokenUsage
    expect(mockDao.insertHarnessTokenUsage).toHaveBeenCalled()
    const tokenCall = mockDao.insertHarnessTokenUsage.mock.calls[0][0]
    expect(tokenCall.model).toBe("claude-sonnet-4-20250514")
    expect(tokenCall.inputTokens).toBe(100)
    expect(tokenCall.outputTokens).toBe(50)
  })

  it("handles timeout by aborting and returning failure", async () => {
    const report = makeReport()
    const context = makeContext()

    // Simulate a slow LLM call that exceeds timeout
    mockLLMCall.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("{}"), 10000)),
    )

    const service = createService({ timeoutMs: 50 })
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("timeout")
  })

  it("emits SSE harness_delegation fail event on failure", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockRejectedValue(new Error("API error"))

    const service = createService()
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(result.success).toBe(false)

    const emitCalls = mockSse.emit.mock.calls
    const delegationEvents = emitCalls.filter(
      (call: any) => call[1].event === "harness_delegation",
    )

    // Should have start + fail
    expect(delegationEvents.length).toBe(2)
    expect(delegationEvents[1][1].data.status).toBe("fail")
  })

  it("persists delegation event to harness_events table", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "inject",
        data: { message: "fix" },
        reasoning: "analysis",
      }),
    })

    const service = createService()
    await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(mockDao.insertEvent).toHaveBeenCalled()
    const event = mockDao.insertEvent.mock.calls[0][0]
    expect(event.execution_id).toBe("exec-1")
    expect(event.node_id).toBe("bash-build")
    expect(event.event_type).toBe("delegation")
  })

  it("returns correct DelegationResult on success", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "varpool",
        data: { key: "build_target", value: "production" },
        reasoning: "Wrong build target causing failures",
      }),
    })

    const service = createService()
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(result.success).toBe(true)
    expect(result.interventionType).toBe("varpool")
    expect(result.interventionData).toEqual({ key: "build_target", value: "production" })
    expect(result.reasoning).toContain("build target")
  })

  it("handles LLM returning unparseable response gracefully", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: "I cannot provide a structured response right now.",
    })

    const service = createService()
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("parse")
  })
})
