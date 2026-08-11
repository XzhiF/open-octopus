// packages/server/src/services/harness/__tests__/agent-delegation.test.ts
//
// Unit tests for the AgentDelegationService (Layer 3).
// Tests delegation prompt construction, response parsing (new + old format),
// backward-compat mapping, agent session runner, timeout handling,
// token recording, and SSE event emission.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  AgentDelegationService,
  buildDelegationPrompt,
  parseDelegationResponse,
  isValidDecisionType,
  mapInterventionTypeToDecision,
  mapDecisionToInterventionType,
  type DelegationContext,
  type AgentSessionRunner,
} from "../agent-delegation"
import type { DiagnosisReport, DelegationResult } from "@octopus/shared"

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

// ─── isValidDecisionType ────────────────────────────────────────────────────

describe("isValidDecisionType", () => {
  it("returns true for all 5 valid decision types", () => {
    expect(isValidDecisionType("fix_and_retry")).toBe(true)
    expect(isValidDecisionType("guide_and_retry")).toBe(true)
    expect(isValidDecisionType("reconfigure_and_retry")).toBe(true)
    expect(isValidDecisionType("agent_takeover")).toBe(true)
    expect(isValidDecisionType("block_node")).toBe(true)
  })

  it("returns false for invalid decision types", () => {
    expect(isValidDecisionType("invalid")).toBe(false)
    expect(isValidDecisionType("inject")).toBe(false)
    expect(isValidDecisionType("")).toBe(false)
    expect(isValidDecisionType("varpool")).toBe(false)
  })
})

// ─── Backward Compatibility Mapping ─────────────────────────────────────────

describe("mapInterventionTypeToDecision", () => {
  it("maps inject → guide_and_retry", () => {
    expect(mapInterventionTypeToDecision("inject")).toBe("guide_and_retry")
  })

  it("maps varpool → fix_and_retry", () => {
    expect(mapInterventionTypeToDecision("varpool")).toBe("fix_and_retry")
  })

  it("maps definition → fix_and_retry", () => {
    expect(mapInterventionTypeToDecision("definition")).toBe("fix_and_retry")
  })

  it("maps takeover → agent_takeover", () => {
    expect(mapInterventionTypeToDecision("takeover")).toBe("agent_takeover")
  })

  it("returns null for unknown intervention types", () => {
    expect(mapInterventionTypeToDecision("unknown")).toBe(null)
    expect(mapInterventionTypeToDecision("")).toBe(null)
  })
})

describe("mapDecisionToInterventionType", () => {
  it("maps fix_and_retry → varpool", () => {
    expect(mapDecisionToInterventionType("fix_and_retry")).toBe("varpool")
  })

  it("maps guide_and_retry → inject", () => {
    expect(mapDecisionToInterventionType("guide_and_retry")).toBe("inject")
  })

  it("maps reconfigure_and_retry → definition", () => {
    expect(mapDecisionToInterventionType("reconfigure_and_retry")).toBe("definition")
  })

  it("maps agent_takeover → takeover", () => {
    expect(mapDecisionToInterventionType("agent_takeover")).toBe("takeover")
  })

  it("maps block_node → inject (closest old equivalent)", () => {
    expect(mapDecisionToInterventionType("block_node")).toBe("inject")
  })
})

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

  it("includes the 5 decision types in instructions", () => {
    const report = makeReport()
    const context = makeContext()
    const prompt = buildDelegationPrompt(report, context)

    expect(prompt).toContain("fix_and_retry")
    expect(prompt).toContain("guide_and_retry")
    expect(prompt).toContain("reconfigure_and_retry")
    expect(prompt).toContain("agent_takeover")
    expect(prompt).toContain("block_node")
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

// ─── Response Parsing — New Format ──────────────────────────────────────────

describe("parseDelegationResponse — new format (decision field)", () => {
  it("parses fix_and_retry with varPoolPatches", () => {
    const rawText = JSON.stringify({
      decision: "fix_and_retry",
      reasoning: "Missing dependency, patching varpool",
      varPoolPatches: { PRE_INSTALL: "apt-get install -y jq" },
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("fix_and_retry")
    expect(result.varPoolPatches).toEqual({ PRE_INSTALL: "apt-get install -y jq" })
    expect(result.reasoning).toContain("Missing dependency")
  })

  it("parses guide_and_retry with harnessHint", () => {
    const rawText = JSON.stringify({
      decision: "guide_and_retry",
      reasoning: "Agent needs guidance",
      harnessHint: "Try installing dependencies first",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("guide_and_retry")
    expect(result.harnessHint).toBe("Try installing dependencies first")
  })

  it("parses reconfigure_and_retry with modelOverride", () => {
    const rawText = JSON.stringify({
      decision: "reconfigure_and_retry",
      reasoning: "Model too weak for this task",
      modelOverride: "claude-opus-4-20250514",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("reconfigure_and_retry")
    expect(result.modelOverride).toBe("claude-opus-4-20250514")
  })

  it("parses agent_takeover with takeoverOutput", () => {
    const rawText = JSON.stringify({
      decision: "agent_takeover",
      reasoning: "Script too complex to fix",
      takeoverOutput: "Report generated successfully",
      takeoverExitCode: 0,
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("agent_takeover")
    expect(result.takeoverOutput).toBe("Report generated successfully")
    expect(result.takeoverExitCode).toBe(0)
  })

  it("parses block_node with blockReason and continueSubsequent", () => {
    const rawText = JSON.stringify({
      decision: "block_node",
      reasoning: "Dangerous operation detected",
      blockReason: "Kill targeting $HOST_PID",
      continueSubsequent: false,
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("block_node")
    expect(result.blockReason).toBe("Kill targeting $HOST_PID")
    expect(result.continueSubsequent).toBe(false)
  })

  it("extracts JSON from markdown code block", () => {
    const rawText = `Here's my analysis:
\`\`\`json
{
  "decision": "guide_and_retry",
  "reasoning": "simple fix",
  "harnessHint": "try this"
}
\`\`\`
`
    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("guide_and_retry")
  })

  it("extracts JSON from surrounding text", () => {
    const rawText = `Based on my analysis:
{"decision": "fix_and_retry", "reasoning": "wrong value", "varPoolPatches": {"key": "val"}}
This should fix it.`

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("fix_and_retry")
  })

  it("returns failure for invalid decision type", () => {
    const rawText = JSON.stringify({
      decision: "invalid_decision",
      reasoning: "wrong",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("invalid decision")
  })

  it("returns failure for missing decision field", () => {
    const rawText = JSON.stringify({
      reasoning: "no decision field",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("missing")
  })

  it("returns failure for non-JSON text", () => {
    const rawText = "This is not JSON at all"

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("parse")
  })

  it("returns failure for invalid JSON", () => {
    const rawText = "{ invalid json }"

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    // YAML fallback may parse loose JSON-like strings; the key assertion
    // is that it still fails because there's no valid decision field.
    expect(result.reasoning).toMatch(/invalid JSON|missing.*decision/)
  })
})

// ─── Response Parsing — Old Format (Backward Compat) ────────────────────────

describe("parseDelegationResponse — old format (interventionType)", () => {
  it("maps inject → guide_and_retry", () => {
    const rawText = JSON.stringify({
      interventionType: "inject",
      data: { message: "Try installing dependencies first" },
      reasoning: "The error indicates missing module",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("guide_and_retry")
    expect(result.harnessHint).toBe("Try installing dependencies first")
    expect(result.reasoning).toContain("missing module")
  })

  it("maps varpool → fix_and_retry with key/value data", () => {
    const rawText = JSON.stringify({
      interventionType: "varpool",
      data: { key: "build_target", value: "production" },
      reasoning: "Wrong build target",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("fix_and_retry")
    expect(result.varPoolPatches).toEqual({ build_target: "production" })
  })

  it("maps definition → fix_and_retry", () => {
    const rawText = JSON.stringify({
      interventionType: "definition",
      data: { field: "script", value: "npm install && npm run build" },
      reasoning: "Need to install first",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("fix_and_retry")
  })

  it("maps takeover → agent_takeover", () => {
    const rawText = JSON.stringify({
      interventionType: "takeover",
      data: { script: "npm install xyz && npm run build" },
      reasoning: "Complex script fix needed",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(true)
    expect(result.decision).toBe("agent_takeover")
    expect(result.takeoverOutput).toBe("npm install xyz && npm run build")
  })

  it("returns failure for invalid old interventionType", () => {
    const rawText = JSON.stringify({
      interventionType: "invalid_type",
      data: { message: "fix" },
      reasoning: "wrong type",
    })

    const result = parseDelegationResponse(rawText)

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("cannot map")
  })
})

// ─── AgentDelegationService.delegate ────────────────────────────────────────

describe("AgentDelegationService — delegate", () => {
  let mockDao: any
  let mockSse: any
  let mockLLMCall: ReturnType<typeof vi.fn>
  let mockAgentRunner: ReturnType<typeof vi.fn>

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
    mockAgentRunner = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createService(opts?: {
    timeoutMs?: number
    useAgentRunner?: boolean
  }) {
    return new AgentDelegationService({
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
      agentSessionRunner: opts?.useAgentRunner
        ? (mockAgentRunner as AgentSessionRunner)
        : undefined,
      llmCall: opts?.useAgentRunner ? undefined : mockLLMCall,
      timeoutMs: opts?.timeoutMs,
    })
  }

  // ── Agent Session Runner (AC1) ──────────────────────────────

  it("uses AgentSessionRunner when provided", async () => {
    const report = makeReport()
    const context = makeContext()

    mockAgentRunner.mockResolvedValue({
      text: JSON.stringify({
        decision: "guide_and_retry",
        reasoning: "analysis",
        harnessHint: "try this",
      }),
      tokenUsage: { input: 100, output: 50, model: "claude-sonnet-4-20250514" },
      sessionId: "session-123",
    })

    const service = createService({ useAgentRunner: true })
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(mockAgentRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        cloneName: "harness-agent",
        executionId: "exec-1",
        nodeId: "bash-build",
      }),
    )
    expect(result.success).toBe(true)
    expect(result.decision).toBe("guide_and_retry")
  })

  it("passes built prompt to AgentSessionRunner", async () => {
    const report = makeReport()
    const context = makeContext()

    mockAgentRunner.mockResolvedValue({
      text: JSON.stringify({
        decision: "fix_and_retry",
        reasoning: "analysis",
      }),
    })

    const service = createService({ useAgentRunner: true })
    await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    const callArgs = mockAgentRunner.mock.calls[0][0]
    expect(callArgs.prompt).toContain("stupid_retry")
    expect(callArgs.prompt).toContain("bash-build")
    expect(callArgs.prompt).toContain("fix_and_retry")
  })

  // ── Backward compat with llmCall ────────────────────────────

  it("falls back to llmCall when no AgentSessionRunner", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        decision: "guide_and_retry",
        reasoning: "analysis",
        harnessHint: "try this",
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

    expect(mockLLMCall).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  // ── Token recording (AC6) ──────────────────────────────────

  it("records token usage with source='harness'", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        decision: "guide_and_retry",
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

    expect(mockDao.insertHarnessTokenUsage).toHaveBeenCalled()
    const tokenCall = mockDao.insertHarnessTokenUsage.mock.calls[0][0]
    expect(tokenCall.model).toBe("claude-sonnet-4-20250514")
    expect(tokenCall.inputTokens).toBe(100)
    expect(tokenCall.outputTokens).toBe(50)
  })

  // ── Timeout protection (AC5) ───────────────────────────────

  it("handles timeout by aborting and returning failure", async () => {
    const report = makeReport()
    const context = makeContext()

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

  it("handles AgentSessionRunner timeout", async () => {
    const report = makeReport()
    const context = makeContext()

    mockAgentRunner.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ text: "{}" }), 10000)),
    )

    const service = createService({ useAgentRunner: true, timeoutMs: 50 })
    const result = await service.delegate({
      executionId: "exec-1",
      nodeId: "bash-build",
      report,
      context,
    })

    expect(result.success).toBe(false)
    expect(result.reasoning).toContain("timeout")
  })

  // ── SSE events ─────────────────────────────────────────────

  it("emits SSE harness_delegation start and complete events", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        decision: "guide_and_retry",
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

    expect(delegationEvents.length).toBe(2)
    expect(delegationEvents[1][1].data.status).toBe("fail")
  })

  // ── Persistence ────────────────────────────────────────────

  it("persists delegation event to harness_events table", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        decision: "fix_and_retry",
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

  // ── Result parsing in delegate flow ────────────────────────

  it("returns correct DelegationResult with new decision types", async () => {
    const report = makeReport()
    const context = makeContext()

    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        decision: "fix_and_retry",
        reasoning: "Wrong build target causing failures",
        varPoolPatches: { build_target: "production" },
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
    expect(result.decision).toBe("fix_and_retry")
    expect(result.varPoolPatches).toEqual({ build_target: "production" })
    expect(result.reasoning).toContain("build target")
  })

  it("handles backward-compat old interventionType in agent response", async () => {
    const report = makeReport()
    const context = makeContext()

    // Agent returns old format — should be mapped to new decision type
    mockLLMCall.mockResolvedValue({
      text: JSON.stringify({
        interventionType: "varpool",
        data: { key: "build_target", value: "production" },
        reasoning: "Wrong build target",
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
    expect(result.decision).toBe("fix_and_retry") // mapped from varpool
    expect(result.varPoolPatches).toEqual({ build_target: "production" })
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
