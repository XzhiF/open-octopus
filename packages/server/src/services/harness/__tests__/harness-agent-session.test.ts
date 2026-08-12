// packages/server/src/services/harness/__tests__/harness-agent-session.test.ts
//
// Unit tests for HarnessAgentSession lifecycle (ticket 10).
// Tests session creation, context accumulation across interventions,
// close + summary generation, and integration with HarnessController.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  HarnessAgentSession,
  type HarnessSessionContext,
} from "../harness-agent-session"
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
      { id: "deploy", type: "agent" },
    ],
    dependencyGraph: { build: [], test: ["build"], deploy: ["test"] },
    varpoolSnapshot: { working_dir: "/project", env: "dev" },
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
    detector: "stupid_retry",
    severity: "warning",
    executionId: "exec-1",
    nodeId: "build",
    nodeType: "bash",
    pattern: "stupid_retry",
    evidence: [
      { attempt: 1, errorHash: "abc", errorMessage: "Cannot find module" },
    ],
    context: { retryCount: 2, nodeDurationMs: 5000, workflowProgress: 0.3 },
    ...overrides,
  }
}

function makeDecision(
  overrides: Partial<DelegationResult> = {},
): DelegationResult {
  return {
    success: true,
    decision: "fix_and_retry",
    reasoning: "Missing dependency",
    varPoolPatches: { PRE_INSTALL: "apt-get install -y jq" },
    ...overrides,
  }
}

// ─── AC1: Session creation ──────────────────────────────────────────────────

describe("HarnessAgentSession — AC1: creation", () => {
  it("creates a session with initial workflow context", () => {
    const ctx = makeSessionContext()
    const session = new HarnessAgentSession(ctx)

    expect(session).toBeDefined()
    expect(session.executionId).toBe("exec-1")
    expect(session.isClosed).toBe(false)
  })

  it("stores workflow YAML, node list, dependency graph, and varpool snapshot", () => {
    const ctx = makeSessionContext({
      workflowContent: "name: my-wf\nnodes:\n  - id: a\n    type: bash",
      nodeList: [{ id: "a", type: "bash" }],
      dependencyGraph: { a: [] },
      varpoolSnapshot: { key: "val" },
    })
    const session = new HarnessAgentSession(ctx)

    const initContext = session.getInitialContext()
    expect(initContext.workflowContent).toContain("my-wf")
    expect(initContext.nodeList).toHaveLength(1)
    expect(initContext.dependencyGraph).toEqual({ a: [] })
    expect(initContext.varpoolSnapshot).toEqual({ key: "val" })
  })

  it("starts with empty intervention history", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    expect(session.getInterventions()).toHaveLength(0)
    // conversationHistory includes the system initialization message
    expect(session.conversationHistory).toHaveLength(1)
    expect(session.conversationHistory[0].role).toBe("system")
  })
})

// ─── AC2: Session context includes workflow info ────────────────────────────

describe("HarnessAgentSession — AC2: initialization context", () => {
  it("builds an initial system message with workflow YAML", () => {
    const ctx = makeSessionContext({
      workflowContent: "name: test-workflow\nnodes:\n  - id: step-1\n    type: bash",
    })
    const session = new HarnessAgentSession(ctx)

    const messages = session.getMessages()
    // First message should be the initialization context (system-like)
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("test-workflow")
    expect(messages[0].content).toContain("step-1")
  })

  it("includes node list and dependency graph in initial message", () => {
    const ctx = makeSessionContext({
      nodeList: [
        { id: "build", type: "bash" },
        { id: "deploy", type: "agent" },
      ],
      dependencyGraph: { build: [], deploy: ["build"] },
    })
    const session = new HarnessAgentSession(ctx)

    const messages = session.getMessages()
    const initMsg = messages[0].content
    expect(initMsg).toContain("build")
    expect(initMsg).toContain("deploy")
    // Check for dependency info (Chinese: 依赖 or English: depends on)
    expect(initMsg).toContain("depends on")
  })

  it("includes varpool snapshot in initial message", () => {
    const ctx = makeSessionContext({
      varpoolSnapshot: { API_KEY: "secret", NODE_ENV: "production" },
    })
    const session = new HarnessAgentSession(ctx)

    const messages = session.getMessages()
    expect(messages[0].content).toContain("API_KEY")
    expect(messages[0].content).toContain("NODE_ENV")
  })
})

// ─── AC3: Intervention appends DiagnosisReport as user message ──────────────

describe("HarnessAgentSession — AC3: append intervention", () => {
  it("appends DiagnosisReport as user message to conversation", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    const report = makeReport({ nodeId: "build", detector: "stupid_retry" })

    session.appendIntervention(report, { varpoolSnapshot: { key: "val" } })

    const messages = session.getMessages()
    // Should have initial context + 1 user message
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("stupid_retry")
    expect(messages[1].content).toContain("build")
  })

  it("includes current varpool snapshot in intervention message", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    const report = makeReport()

    session.appendIntervention(report, {
      varpoolSnapshot: { new_var: "new_value" },
    })

    const messages = session.getMessages()
    const interventionMsg = messages[1]
    expect(interventionMsg.content).toContain("new_var")
    expect(interventionMsg.content).toContain("new_value")
  })

  it("records intervention in history", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    const report = makeReport()
    const decision = makeDecision({ decision: "fix_and_retry" })

    session.appendIntervention(report, { varpoolSnapshot: {} })
    session.recordDecision(report.nodeId, decision)

    const interventions = session.getInterventions()
    expect(interventions).toHaveLength(1)
    expect(interventions[0].nodeId).toBe("build")
    expect(interventions[0].decision).toBe("fix_and_retry")
  })
})

// ─── AC4: Session maintains context across multiple interventions ───────────

describe("HarnessAgentSession — AC4: context accumulation", () => {
  it("accumulates conversation history across multiple interventions", () => {
    const session = new HarnessAgentSession(makeSessionContext())

    // First intervention
    const report1 = makeReport({
      id: "report-1",
      nodeId: "build",
      detector: "stupid_retry",
    })
    session.appendIntervention(report1, { varpoolSnapshot: {} })
    session.recordDecision("build", makeDecision({ decision: "fix_and_retry" }))

    // Append assistant response to conversation (simulating agent response)
    session.appendAssistantResponse('{"decision": "fix_and_retry", "reasoning": "fix"}')

    // Second intervention
    const report2 = makeReport({
      id: "report-2",
      nodeId: "test",
      detector: "timeout_cascade",
    })
    session.appendIntervention(report2, { varpoolSnapshot: {} })
    session.recordDecision("test", makeDecision({ decision: "guide_and_retry" }))

    const messages = session.getMessages()
    // initial context + user1 + assistant1 + user2 = 4
    expect(messages).toHaveLength(4)

    // All history should be preserved
    expect(messages[0].role).toBe("system") // initial context
    expect(messages[1].role).toBe("user") // first intervention
    expect(messages[2].role).toBe("assistant") // first response
    expect(messages[3].role).toBe("user") // second intervention

    expect(messages[1].content).toContain("stupid_retry")
    expect(messages[3].content).toContain("timeout_cascade")
  })

  it("maintains correct intervention count across multiple interventions", () => {
    const session = new HarnessAgentSession(makeSessionContext())

    for (let i = 0; i < 5; i++) {
      const report = makeReport({
        id: `report-${i}`,
        nodeId: `node-${i}`,
      })
      session.appendIntervention(report, { varpoolSnapshot: {} })
      session.recordDecision(`node-${i}`, makeDecision())
      session.appendAssistantResponse(`{"decision": "fix_and_retry"}`)
    }

    expect(session.getInterventions()).toHaveLength(5)
    // system + 5 * (user + assistant) = 11
    expect(session.getMessages()).toHaveLength(11)
  })
})

// ─── AC5: Session close + summary ──────────────────────────────────────────

describe("HarnessAgentSession — AC5: close + summary", () => {
  it("closes the session and marks it as closed", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    expect(session.isClosed).toBe(false)

    session.close()
    expect(session.isClosed).toBe(true)
  })

  it("produces a summary with total intervention count and decisions", () => {
    const session = new HarnessAgentSession(makeSessionContext())

    session.appendIntervention(makeReport({ nodeId: "build" }), {
      varpoolSnapshot: {},
    })
    session.recordDecision("build", makeDecision({ decision: "fix_and_retry", reasoning: "Missing dep" }))

    session.appendIntervention(makeReport({ nodeId: "test" }), {
      varpoolSnapshot: {},
    })
    session.recordDecision("test", makeDecision({ decision: "block_node", reasoning: "Dangerous op" }))

    session.close()
    const summary = session.getSummary()

    expect(summary).toBeDefined()
    expect(summary!.totalInterventions).toBe(2)
    expect(summary!.decisions).toHaveLength(2)
    expect(summary!.decisions[0]).toEqual({
      node: "build",
      decision: "fix_and_retry",
      reason: "Missing dep",
    })
    expect(summary!.decisions[1]).toEqual({
      node: "test",
      decision: "block_node",
      reason: "Dangerous op",
    })
  })

  it("returns null summary when no interventions occurred", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    session.close()

    const summary = session.getSummary()
    expect(summary).toBeNull()
  })

  it("determines harness_status from decisions", () => {
    // block_node → "blocked"
    const session1 = new HarnessAgentSession(makeSessionContext({ executionId: "e1" }))
    session1.appendIntervention(makeReport(), { varpoolSnapshot: {} })
    session1.recordDecision("build", makeDecision({ decision: "block_node" }))
    session1.close()
    expect(session1.getSummary()!.harnessStatus).toBe("blocked")

    // agent_takeover → "delegated"
    const session2 = new HarnessAgentSession(makeSessionContext({ executionId: "e2" }))
    session2.appendIntervention(makeReport(), { varpoolSnapshot: {} })
    session2.recordDecision("build", makeDecision({ decision: "agent_takeover" }))
    session2.close()
    expect(session2.getSummary()!.harnessStatus).toBe("delegated")

    // fix_and_retry → "intervened"
    const session3 = new HarnessAgentSession(makeSessionContext({ executionId: "e3" }))
    session3.appendIntervention(makeReport(), { varpoolSnapshot: {} })
    session3.recordDecision("build", makeDecision({ decision: "fix_and_retry" }))
    session3.close()
    expect(session3.getSummary()!.harnessStatus).toBe("intervened")
  })

  it("prioritizes harness_status: blocked > delegated > intervened", () => {
    const session = new HarnessAgentSession(makeSessionContext())

    // First: fix_and_retry (intervened)
    session.appendIntervention(makeReport({ nodeId: "a" }), { varpoolSnapshot: {} })
    session.recordDecision("a", makeDecision({ decision: "fix_and_retry" }))

    // Second: agent_takeover (delegated)
    session.appendIntervention(makeReport({ nodeId: "b" }), { varpoolSnapshot: {} })
    session.recordDecision("b", makeDecision({ decision: "agent_takeover" }))

    // Third: block_node (blocked) — highest priority
    session.appendIntervention(makeReport({ nodeId: "c" }), { varpoolSnapshot: {} })
    session.recordDecision("c", makeDecision({ decision: "block_node" }))

    session.close()
    expect(session.getSummary()!.harnessStatus).toBe("blocked")
  })

  it("throws when appending to a closed session", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    session.close()

    expect(() => {
      session.appendIntervention(makeReport(), { varpoolSnapshot: {} })
    }).toThrow(/closed/)
  })
})

// ─── AC6: Timeout protection (already exists in AgentDelegationService) ─────

describe("HarnessAgentSession — AC6: timeout metadata", () => {
  it("stores the default timeout value for reference", () => {
    const session = new HarnessAgentSession(makeSessionContext())
    expect(session.timeoutMs).toBe(5 * 60 * 1000) // 5 minutes
  })

  it("accepts custom timeout", () => {
    const session = new HarnessAgentSession(
      makeSessionContext(),
      { timeoutMs: 30000 },
    )
    expect(session.timeoutMs).toBe(30000)
  })
})

// ─── HarnessController integration ──────────────────────────────────────────

describe("HarnessController — session lifecycle integration", () => {
  // These are tested through the HarnessController which is the public seam.
  // We import HarnessController here to verify the session wiring.
  let HarnessController: any
  let HarnessAgentSession: any

  beforeEach(async () => {
    const ctrl = await import("../harness-controller")
    HarnessController = ctrl.HarnessController
    const sess = await import("../harness-agent-session")
    HarnessAgentSession = sess.HarnessAgentSession
  })

  function makeControllerMocks() {
    const dao = {
      insertEvent: vi.fn(),
      findEvents: vi.fn().mockReturnValue([]),
      getDb: vi.fn().mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
        }),
      }),
    }

    const sse = {
      emit: vi.fn(),
    }

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
    }

    return { dao, sse, configService }
  }

  it("AC1: onExecutionStart creates a session when session context is provided", async () => {
    const mocks = makeControllerMocks()
    const controller = new HarnessController({
      dao: mocks.dao as any,
      sse: mocks.sse as any,
      configService: mocks.configService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
      varpoolSnapshot: { key: "val" },
    })

    const session = controller.getSession("exec-1")
    expect(session).toBeDefined()
    expect(session).toBeInstanceOf(HarnessAgentSession)
  })

  it("AC5: onExecutionEnd closes session and writes harness_summary", async () => {
    const mocks = makeControllerMocks()
    const controller = new HarnessController({
      dao: mocks.dao as any,
      sse: mocks.sse as any,
      configService: mocks.configService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
      varpoolSnapshot: {},
    })

    // Simulate an intervention
    const session = controller.getSession("exec-1")
    session.appendIntervention(makeReport(), { varpoolSnapshot: {} })
    session.recordDecision("build", makeDecision({ decision: "fix_and_retry", reasoning: "test" }))

    // End execution
    controller.onExecutionEnd("exec-1")

    // Session should be gone
    expect(controller.getSession("exec-1")).toBeUndefined()
    expect(controller.isActive("exec-1")).toBe(false)

    // harness_summary should have been written via dao.getDb()
    const db = mocks.dao.getDb()
    const prepareCalls = (mocks.dao.getDb() as any).prepare.mock.calls
    // At least one prepare call should reference harness_summary
    const summaryUpdate = prepareCalls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("harness_summary"),
    )
    expect(summaryUpdate).toBeDefined()
  })

  it("AC4: session accumulates context across multiple interventions within same execution", async () => {
    const mocks = makeControllerMocks()
    const controller = new HarnessController({
      dao: mocks.dao as any,
      sse: mocks.sse as any,
      configService: mocks.configService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks, {
      workflowContent: "name: test",
      nodeList: [{ id: "build", type: "bash" }],
      dependencyGraph: { build: [] },
      varpoolSnapshot: {},
    })

    const session = controller.getSession("exec-1")

    // First intervention
    session.appendIntervention(makeReport({ id: "r1", nodeId: "build" }), {
      varpoolSnapshot: {},
    })
    session.recordDecision("build", makeDecision({ decision: "fix_and_retry" }))
    session.appendAssistantResponse('{"decision":"fix_and_retry"}')

    // Second intervention
    session.appendIntervention(makeReport({ id: "r2", nodeId: "test" }), {
      varpoolSnapshot: {},
    })
    session.recordDecision("test", makeDecision({ decision: "guide_and_retry" }))

    expect(session.getInterventions()).toHaveLength(2)
    // system + user1 + assistant1 + user2 = 4
    expect(session.getMessages()).toHaveLength(4)
  })

  it("onExecutionStart without session context still creates pipeline (backward compat)", async () => {
    const mocks = makeControllerMocks()
    const controller = new HarnessController({
      dao: mocks.dao as any,
      sse: mocks.sse as any,
      configService: mocks.configService as any,
    })

    const baseCallbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
    } as any

    controller.onExecutionStart("exec-1", "ws-1", baseCallbacks)

    // Pipeline should exist
    expect(controller.isActive("exec-1")).toBe(true)
    // But no session
    expect(controller.getSession("exec-1")).toBeUndefined()
  })
})
