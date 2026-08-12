// packages/server/src/services/harness/__tests__/harness-experience-recording.test.ts
//
// Integration tests for harness experience recording (ticket 03).
// Tests that interventions are persisted to experiences table with correct
// scope-aware fields, and that clone daily memory is written.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HarnessController } from "../harness-controller"
import { HarnessAgentSession, type HarnessSessionContext } from "../harness-agent-session"
import type { HarnessDAO } from "../../../db/dao/harness-dao"
import type { SSEService } from "../../sse"
import type { HarnessConfigService } from "../config-service"
import type { EvolutionDAO } from "../../../db/dao/evolution-dao"
import type { DiagnosisReport, DelegationResult } from "@octopus/shared"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSessionContext(
  overrides: Partial<HarnessSessionContext> = {},
): HarnessSessionContext {
  return {
    workflowContent: "name: test\nnodes:\n  - id: build\n    type: bash",
    nodeList: [
      { id: "build", type: "bash" },
      { id: "test", type: "bash" },
    ],
    dependencyGraph: { build: [], test: ["build"] },
    varpoolSnapshot: { working_dir: "/project" },
    executionId: "exec-1",
    ...overrides,
  }
}

function makeReport(
  overrides: Partial<DiagnosisReport> = {},
): DiagnosisReport {
  return {
    id: "report-1",
    timestamp: Date.now(),
    detector: "deterministic_error",
    severity: "critical",
    executionId: "exec-1",
    nodeId: "build",
    nodeType: "bash",
    pattern: "syntax_error",
    evidence: [
      { attempt: 1, errorCode: "E001", errorMessage: "Syntax error" },
    ],
    context: { retryCount: 2, nodeDurationMs: 5000, workflowProgress: 0.5 },
    ...overrides,
  }
}

function makeDecision(
  overrides: Partial<DelegationResult> = {},
): DelegationResult {
  return {
    success: true,
    decision: "fix_and_retry",
    reasoning: "Fix syntax error by correcting the typo",
    varPoolPatches: {},
    ...overrides,
  }
}

function makeMocks() {
  const dao = {
    insertEvent: vi.fn(),
    findEvents: vi.fn().mockReturnValue([]),
    getDb: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    }),
  } as unknown as HarnessDAO

  const sse = {
    emit: vi.fn(),
  } as unknown as SSEService

  const configService = {
    loadMergedConfig: vi.fn().mockReturnValue({
      detectors: {},
      strategies: [],
      isolation: {
        process_group: false,
        port_protection: false,
        pid_protection: false,
        sandbox: "off",
        fs_whitelist: [],
      },
    }),
  } as unknown as HarnessConfigService

  const evolutionDao = {
    insertExperienceV2: vi.fn().mockReturnValue({ lastInsertRowid: 1 }),
  } as unknown as EvolutionDAO

  const memoryService = {
    recordDaily: vi.fn().mockReturnValue({ ok: true, date: "2026-08-11" }),
  }

  return { dao, sse, configService, evolutionDao, memoryService }
}

// ─── AC-1: onExecutionEnd iterates over session interventions ───────────────

describe("HarnessController — AC-1: experience recording on execution end", () => {
  let mocks: ReturnType<typeof makeMocks>

  beforeEach(() => {
    mocks = makeMocks()
    vi.clearAllMocks()
  })

  it("records experiences for all interventions when execution ends", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    // Start execution with session context
    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test\nnodes:\n  - id: build\n    type: bash",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
      varpoolSnapshot: {},
    })

    // Simulate interventions
    const session = controller.getSession("exec-1")
    expect(session).toBeDefined()

    const report1 = makeReport({ nodeId: "build", detector: "deterministic_error", pattern: "syntax_error" })
    const decision1 = makeDecision({ decision: "fix_and_retry" })
    session!.appendIntervention(report1, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision1)

    const report2 = makeReport({
      id: "report-2",
      nodeId: "test",
      detector: "timeout_cascade",
      pattern: "node_timeout",
      severity: "warning",
    })
    const decision2 = makeDecision({ decision: "agent_takeover", reasoning: "Take over due to timeout" })
    session!.appendIntervention(report2, { varpoolSnapshot: {} })
    session!.recordDecision("test", decision2)

    // End execution
    controller.onExecutionEnd("exec-1")

    // Verify experiences were recorded
    expect(mocks.evolutionDao.insertExperienceV2).toHaveBeenCalledTimes(2)

    // Check first experience
    const firstCall = mocks.evolutionDao.insertExperienceV2.mock.calls[0][0]
    expect(firstCall.scope).toBe("harness")
    expect(firstCall.scope_ref).toBe("deterministic_error")
    expect(firstCall.node_id).toBe("build")
    expect(firstCall.execution_id).toBe("exec-1")
    expect(firstCall.source_type).toBe("harness")
    expect(firstCall.outcome).toBe(JSON.stringify({ label: "pending" }))
    expect(firstCall.pattern_tags).toContain("fix_and_retry")
    expect(firstCall.pattern_tags).toContain("syntax_error")
    expect(firstCall.pattern_tags).toContain("bash")
    expect(firstCall.pattern_tags).toContain("critical")
    expect(firstCall.content).toContain("deterministic_error")
    expect(firstCall.content).toContain("syntax_error")
    expect(firstCall.content).toContain("fix_and_retry")

    // Check second experience
    const secondCall = mocks.evolutionDao.insertExperienceV2.mock.calls[1][0]
    expect(secondCall.scope).toBe("harness")
    expect(secondCall.scope_ref).toBe("timeout_cascade")
    expect(secondCall.node_id).toBe("test")
    expect(secondCall.pattern_tags).toContain("agent_takeover")
    expect(secondCall.pattern_tags).toContain("node_timeout")
  })

  it("writes clone daily memory when interventions occurred", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    const session = controller.getSession("exec-1")
    const report = makeReport()
    const decision = makeDecision()
    session!.appendIntervention(report, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision)

    controller.onExecutionEnd("exec-1")

    // Verify daily memory was written
    expect(mocks.memoryService.recordDaily).toHaveBeenCalledTimes(1)
    const [org, content, sessionId, cloneDir] = mocks.memoryService.recordDaily.mock.calls[0]
    expect(org).toBe("default")
    expect(content).toContain("build")
    expect(content).toContain("fix_and_retry")
    expect(sessionId).toBe("harness-exec-1")
    expect(cloneDir).toContain("harness-agent")
  })

  it("does not record experiences when no interventions occurred", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    // End execution without any interventions
    controller.onExecutionEnd("exec-1")

    // Verify no experiences were recorded
    expect(mocks.evolutionDao.insertExperienceV2).not.toHaveBeenCalled()
    expect(mocks.memoryService.recordDaily).not.toHaveBeenCalled()
  })

  it("includes structured summary in content field", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    const session = controller.getSession("exec-1")
    const report = makeReport({
      detector: "deterministic_error",
      pattern: "syntax_error",
      nodeId: "build",
      nodeType: "bash",
      severity: "critical",
    })
    const decision = makeDecision({
      decision: "fix_and_retry",
      reasoning: "Missing dependency in package.json",
    })
    session!.appendIntervention(report, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision)

    controller.onExecutionEnd("exec-1")

    const experienceRow = mocks.evolutionDao.insertExperienceV2.mock.calls[0][0]
    // Content should be searchable and contain key information
    expect(experienceRow.content).toContain("deterministic_error") // detector
    expect(experienceRow.content).toContain("syntax_error") // pattern
    expect(experienceRow.content).toContain("fix_and_retry") // decision
    expect(experienceRow.content).toContain("Missing dependency") // reasoning
    expect(experienceRow.content).toContain("build") // node
  })

  it("sets pattern_tags as JSON array with decision, pattern, nodeType, severity", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    const session = controller.getSession("exec-1")
    const report = makeReport({
      detector: "deterministic_error",
      pattern: "syntax_error",
      nodeType: "bash",
      severity: "critical",
    })
    const decision = makeDecision({ decision: "fix_and_retry" })
    session!.appendIntervention(report, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision)

    controller.onExecutionEnd("exec-1")

    const experienceRow = mocks.evolutionDao.insertExperienceV2.mock.calls[0][0]
    const patternTags = JSON.parse(experienceRow.pattern_tags)
    expect(Array.isArray(patternTags)).toBe(true)
    expect(patternTags).toContain("fix_and_retry") // decision
    expect(patternTags).toContain("syntax_error") // pattern
    expect(patternTags).toContain("bash") // nodeType
    expect(patternTags).toContain("critical") // severity
  })

  it("uses harness-agent clone directory for daily memory", () => {
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    const session = controller.getSession("exec-1")
    const report = makeReport()
    const decision = makeDecision()
    session!.appendIntervention(report, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision)

    controller.onExecutionEnd("exec-1")

    const cloneDir = mocks.memoryService.recordDaily.mock.calls[0][3]
    expect(cloneDir).toContain("harness-agent")
  })
})

// ─── AC-5: HarnessAgentSession.close() extended ─────────────────────────────

describe("HarnessAgentSession — AC-5: close() returns intervention summary", () => {
  it("returns structured intervention data on close", () => {
    const ctx = makeSessionContext()
    const session = new HarnessAgentSession(ctx)

    const report = makeReport()
    const decision = makeDecision()
    session.appendIntervention(report, { varpoolSnapshot: {} })
    session.recordDecision("build", decision)

    session.close()

    // getSummary() should return the interventions
    const summary = session.getSummary()
    expect(summary).not.toBeNull()
    expect(summary!.totalInterventions).toBe(1)
    expect(summary!.decisions).toHaveLength(1)
    expect(summary!.decisions[0].node).toBe("build")
    expect(summary!.decisions[0].decision).toBe("fix_and_retry")
  })

  it("returns null summary when no interventions occurred", () => {
    const ctx = makeSessionContext()
    const session = new HarnessAgentSession(ctx)

    session.close()

    const summary = session.getSummary()
    expect(summary).toBeNull()
  })
})

// ─── AC-7: Existing harness_events behavior unchanged ───────────────────────

describe("HarnessController — AC-7: existing harness_summary behavior unchanged", () => {
  it("still writes harness_summary to executions table", () => {
    const mocks = makeMocks()
    const controller = new HarnessController({
      dao: mocks.dao,
      sse: mocks.sse,
      configService: mocks.configService,
      evolutionDao: mocks.evolutionDao,
      memoryService: mocks.memoryService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeError: vi.fn(),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onRetry: vi.fn(),
      onLLMCall: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
    })

    const session = controller.getSession("exec-1")
    const report = makeReport()
    const decision = makeDecision()
    session!.appendIntervention(report, { varpoolSnapshot: {} })
    session!.recordDecision("build", decision)

    // Mock the DAO's getDb().prepare() to verify the UPDATE call
    const prepareMock = vi.fn().mockReturnValue({
      run: vi.fn(),
    })
    ;(mocks.dao.getDb() as any).prepare = prepareMock

    controller.onExecutionEnd("exec-1")

    // Verify the UPDATE to executions table was called
    expect(prepareMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE executions")
    )
  })
})
