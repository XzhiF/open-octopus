// packages/server/src/__tests__/harness-e2e-semantic-v2.test.ts
//
// E2E Integration Tests for Harness Semantic V2 — Ticket 08
//
// These tests verify the complete harness semantic v2 flow:
// - AC1: process_conflict → node blocked + harness_status = "blocked"
// - AC2: stupid_retry → Harness Agent intervenes + harness_status = "intervened"
// - AC3: timeout_cascade → Harness Agent intervenes (not advisory)
// - AC4: Agent tool interceptor → block + guide + resume → completed
// - AC5: Execution list API returns harnessStatus field
// - AC6: Agent events contain decision field
// - AC7: Harness Agent session maintains context across interventions
//
// Prerequisites:
// - Server running (pnpm dev) at SERVER_URL (default: http://localhost:3001)
// - Test workspace "test-harness" exists with ID e6d714bf-ed74-4041-ad56-2ccc82acd16b
// - Test workflows available: test-process-conflict, test-stupid-retry, test-timeout-cascade, test-agent-tool-interceptor
//
// Run:
//   SERVER_URL=http://localhost:3001 pnpm vitest run packages/server/src/__tests__/harness-e2e-semantic-v2.test.ts
//
// Note: These tests are designed to be run against a live server.
// If the server is not available, tests will be skipped gracefully.

import { describe, it, expect, beforeAll } from "vitest"

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3001"
const WORKSPACE_ID = process.env.WORKSPACE_ID || "e6d714bf-ed74-4041-ad56-2ccc82acd16b"
const API_BASE = `${SERVER_URL}/api/workspaces/${WORKSPACE_ID}`
const POLL_INTERVAL_MS = 3000
const MAX_POLL_MS = 300000 // 5 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/actuator/health`)
    return res.ok
  } catch {
    return false
  }
}

async function createExecution(workflowRef: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_ref: workflowRef }),
    })
    if (!res.ok) return null
    const data = await res.json() as { id?: string }
    return data.id ?? null
  } catch {
    return null
  }
}

async function startExecution(execId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/executions/${execId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    return res.ok
  } catch {
    return false
  }
}

async function getExecution(execId: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}/executions/${execId}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function getExecutionList(): Promise<any[]> {
  try {
    const res = await fetch(`${API_BASE}/executions`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : (data.nodes ?? [])
  } catch {
    return []
  }
}

async function getAgentEvents(execId: string, nodeId?: string): Promise<any[]> {
  try {
    const url = nodeId
      ? `${API_BASE}/executions/${execId}/agent-events?nodeId=${nodeId}`
      : `${API_BASE}/executions/${execId}/agent-events`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return data.events ?? data ?? []
  } catch {
    return []
  }
}

async function pollUntilTerminal(execId: string): Promise<string> {
  const TERMINAL_STATUSES = new Set([
    "completed", "failed", "completed_with_failures", "cancelled", "blocked"
  ])
  const start = Date.now()
  while (Date.now() - start < MAX_POLL_MS) {
    const detail = await getExecution(execId)
    if (detail && TERMINAL_STATUSES.has(detail.status)) {
      return detail.status
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return "TIMEOUT"
}

async function cleanupExecution(_execId: string): Promise<void> {
  // Best-effort cleanup — some servers may not support DELETE
  try {
    await fetch(`${API_BASE}/executions/${_execId}`, { method: "DELETE" })
  } catch { /* ignore */ }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.RUN_E2E_HARNESS)("Harness Semantic V2 — E2E Integration", () => {
  let serverAvailable: boolean

  beforeAll(async () => {
    serverAvailable = await checkServer()
    if (!serverAvailable) {
      console.warn("⚠️  Server not reachable at", SERVER_URL, "— skipping E2E tests")
      console.warn("   Start server with 'pnpm dev' and set RUN_E2E_HARNESS=1 to run")
    }
  })

  // ─── AC1: Process Conflict ──────────────────────────────────────────────

  describe("AC1: test-process-conflict", () => {
    it("should block dangerous node and set harness_status = blocked", async () => {
      if (!serverAvailable) return

      const execId = await createExecution("test-process-conflict")
      expect(execId).toBeTruthy()

      const started = await startExecution(execId!)
      expect(started).toBe(true)

      const status = await pollUntilTerminal(execId!)
      expect(["completed", "completed_with_failures", "failed", "blocked"]).toContain(status)

      const detail = await getExecution(execId!)
      expect(detail).toBeTruthy()

      // Execution-level harness_status should be "blocked"
      expect(detail.harness_status ?? detail.harnessStatus).toBe("blocked")

      // At least one step should have harnessStatus set
      const stepsWithHarness = (detail.steps ?? []).filter(
        (s: any) => s.harnessStatus != null
      )
      expect(stepsWithHarness.length).toBeGreaterThan(0)

      // Agent events should exist for the blocked execution
      const events = await getAgentEvents(execId!)
      expect(events.length).toBeGreaterThan(0)

      await cleanupExecution(execId!)
    }, MAX_POLL_MS + 30000)
  })

  // ─── AC2: Stupid Retry ─────────────────────────────────────────────────

  describe("AC2: test-stupid-retry", () => {
    it("should trigger Harness Agent intervention and set harness_status = intervened", async () => {
      if (!serverAvailable) return

      const execId = await createExecution("test-stupid-retry")
      expect(execId).toBeTruthy()

      const started = await startExecution(execId!)
      expect(started).toBe(true)

      const status = await pollUntilTerminal(execId!)
      expect(["completed", "completed_with_failures", "failed"]).toContain(status)

      const detail = await getExecution(execId!)
      expect(detail).toBeTruthy()

      // Execution-level harness_status should be "intervened"
      expect(detail.harness_status ?? detail.harnessStatus).toBe("intervened")

      // At least one step should show harness modification
      const modifiedSteps = (detail.steps ?? []).filter(
        (s: any) => s.harnessStatus === "harness_modified" || s.harnessStatus === "intervened"
      )
      expect(modifiedSteps.length).toBeGreaterThan(0)

      // Agent events should contain harness intervention
      const events = await getAgentEvents(execId!)
      const interventions = events.filter(
        (e: any) => e.event_type === "harness_intervention" || e.decision != null
      )
      expect(interventions.length).toBeGreaterThan(0)

      await cleanupExecution(execId!)
    }, MAX_POLL_MS + 30000)
  })

  // ─── AC3: Timeout Cascade ──────────────────────────────────────────────

  describe("AC3: test-timeout-cascade", () => {
    it("should trigger Harness Agent intervention (not advisory)", async () => {
      if (!serverAvailable) return

      const execId = await createExecution("test-timeout-cascade")
      expect(execId).toBeTruthy()

      const started = await startExecution(execId!)
      expect(started).toBe(true)

      const status = await pollUntilTerminal(execId!)
      expect(["completed", "completed_with_failures", "failed"]).toContain(status)

      const detail = await getExecution(execId!)
      expect(detail).toBeTruthy()

      // harness_status should NOT be null — proves Agent actually intervened
      const harnessStatus = detail.harness_status ?? detail.harnessStatus
      expect(harnessStatus).not.toBeNull()
      expect(harnessStatus).not.toBeUndefined()

      // At least one step should have harness handling
      const handledSteps = (detail.steps ?? []).filter(
        (s: any) => s.harnessStatus != null
      )
      expect(handledSteps.length).toBeGreaterThan(0)

      // Agent events should contain non-advisory decisions
      const events = await getAgentEvents(execId!)
      const realDecisions = events.filter(
        (e: any) => e.decision != null && e.decision !== "advisory"
      )
      expect(realDecisions.length).toBeGreaterThan(0)

      await cleanupExecution(execId!)
    }, MAX_POLL_MS + 30000)
  })

  // ─── AC4: Agent Tool Interceptor ───────────────────────────────────────

  describe("AC4: Agent node tool interceptor", () => {
    it("should block dangerous tool call, guide agent, and resume to completion", async () => {
      if (!serverAvailable) return

      const execId = await createExecution("test-agent-tool-interceptor")
      expect(execId).toBeTruthy()

      const started = await startExecution(execId!)
      expect(started).toBe(true)

      const status = await pollUntilTerminal(execId!)
      expect(["completed", "completed_with_failures"]).toContain(status)

      const detail = await getExecution(execId!)
      expect(detail).toBeTruthy()

      // harness_status should be "intervened"
      expect(detail.harness_status ?? detail.harnessStatus).toBe("intervened")

      // Agent events for the agent node should contain tool block event
      const events = await getAgentEvents(execId!, "run-e2e-tests")
      const blockedTools = events.filter(
        (e: any) => e.event_type === "tool_blocked"
          || e.event_type === "tool_intercepted"
          || e.event === "tool_blocked"
      )
      expect(blockedTools.length).toBeGreaterThan(0)

      await cleanupExecution(execId!)
    }, MAX_POLL_MS + 30000)
  })

  // ─── AC5: Execution List API ───────────────────────────────────────────

  describe("AC5: Execution list API", () => {
    it("should return harnessStatus field in execution list items", async () => {
      if (!serverAvailable) return

      const list = await getExecutionList()
      expect(list.length).toBeGreaterThan(0)

      // Each execution item should have harnessStatus field (even if null)
      const firstExec = list[0]
      const hasField = "harness_status" in firstExec || "harnessStatus" in firstExec
      expect(hasField).toBe(true)
    })
  })

  // ─── AC6: Agent Events Decision Field ──────────────────────────────────

  describe("AC6: Agent events decision field", () => {
    it("should contain decision field in agent events for intervened executions", async () => {
      if (!serverAvailable) return

      // Find an intervened execution from previous tests
      const list = await getExecutionList()
      const intervenedExec = list.find(
        (e: any) => (e.harness_status ?? e.harnessStatus) === "intervened"
      )

      if (!intervenedExec) {
        console.warn("No intervened execution found — skipping AC6")
        return
      }

      const events = await getAgentEvents(intervenedExec.id)
      const withDecision = events.filter((e: any) => e.decision != null)
      expect(withDecision.length).toBeGreaterThan(0)

      // Validate decision types
      const VALID_DECISIONS = new Set([
        "fix_and_retry", "guide_and_retry", "reconfigure_and_retry",
        "agent_takeover", "block_node"
      ])
      for (const evt of withDecision) {
        expect(VALID_DECISIONS.has(evt.decision)).toBe(true)
      }
    })
  })

  // ─── AC7: Harness Agent Session Context ────────────────────────────────

  describe("AC7: Harness Agent session context", () => {
    it("should maintain context across multiple interventions in same execution", async () => {
      if (!serverAvailable) return

      // Find an intervened execution
      const list = await getExecutionList()
      const intervenedExec = list.find(
        (e: any) => (e.harness_status ?? e.harnessStatus) === "intervened"
      )

      if (!intervenedExec) {
        console.warn("No intervened execution found — skipping AC7")
        return
      }

      const detail = await getExecution(intervenedExec.id)
      expect(detail).toBeTruthy()

      // harness_summary should contain intervention history
      const summaryRaw = detail.harness_summary ?? detail.harnessSummary
      expect(summaryRaw).not.toBeNull()

      // Parse summary (might be JSON string or object)
      let summary: any
      if (typeof summaryRaw === "string") {
        summary = JSON.parse(summaryRaw)
      } else {
        summary = summaryRaw
      }

      expect(summary.totalInterventions).toBeGreaterThan(0)
      expect(summary.decisions).toBeDefined()
      expect(summary.decisions.length).toBeGreaterThan(0)

      // Agent events should show sequential interventions
      const events = await getAgentEvents(intervenedExec.id)
      const interventions = events.filter(
        (e: any) => e.event_type === "harness_intervention" || e.decision != null
      )
      expect(interventions.length).toBeGreaterThan(0)
    })
  })
})
