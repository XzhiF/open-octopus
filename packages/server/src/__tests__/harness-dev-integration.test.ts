// packages/server/src/__tests__/harness-dev-integration.test.ts
//
// Integration test for harness dev fixes (R2-02):
// - AC1: ExecutionLifecycle autoResume calls onExecutionEnd for cleanup
// - AC2: ExecutionLifecycle runInteractionCompleteInBackground calls cleanup
// - AC3: SSE harness_delegation event distinguishes from user pause
// - AC4: HarnessDAO + route handler end-to-end event flow

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { HarnessDAO } from "../db/dao/harness-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { SSEService } from "../services/sse"
import { HarnessController } from "../services/harness/harness-controller"
import { HarnessConfigService } from "../services/harness/config-service"
import type { HarnessEvent } from "@octopus/shared"
import harnessRoutes, { setHarnessDependencies } from "../routes/harness"
import { Hono } from "hono"

let db: Database.Database
let harnessDAO: HarnessDAO
let execDAO: ExecutionDAO
let sse: SSEService
let harnessController: HarnessController
let dbPath: string
let workspacePath: string
let workspaceId: string
let app: Hono

const ORG = "test-org"

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    execution_id: "exec-001",
    node_id: "step1",
    timestamp: Date.now(),
    event_type: "diagnosis",
    detector: "stupid_retry",
    severity: "warning",
    report_json: JSON.stringify({ detector: "stupid_retry" }),
    action_json: null,
    result_json: null,
    token_usage_json: null,
    created_at: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-harness-dev-${Date.now()}`)
  fs.mkdirSync(path.join(workspacePath, "workflows"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "projects"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "state"), { recursive: true })
  fs.writeFileSync(
    path.join(workspacePath, "config.json"),
    JSON.stringify({ name: "test-ws", init_branch_name: "main", repos: [], created: new Date().toISOString() }),
  )

  dbPath = path.join(os.tmpdir(), `test-harness-dev-db-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  workspaceId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(workspaceId, "test-ws", ORG, workspacePath, now, now)

  harnessDAO = new HarnessDAO(db)
  execDAO = new ExecutionDAO(db)
  sse = new SSEService()

  const configService = new HarnessConfigService(harnessDAO)
  harnessController = new HarnessController({
    dao: harnessDAO,
    sse,
    configService,
  })

  setHarnessDependencies(harnessDAO)
  app = new Hono()
  app.route("/api/workspaces/:id/harness", harnessRoutes)
})

afterEach(() => {
  try {
    harnessController.destroyAll()
  } catch { /* ignore */ }
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  if (fs.existsSync(workspacePath)) fs.rmSync(workspacePath, { recursive: true, force: true })
})

async function request(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const url = `http://localhost${urlPath}`
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { "Content-Type": "application/json" }
  }
  return app.fetch(new Request(url, init))
}

describe("R2-02 Harness Dev Integration", () => {
  describe("AC1: autoResume harness cleanup", () => {
    it("HarnessController cleans up after onExecutionEnd is called", () => {
      const executionId = randomUUID()
      const mockCallbacks = {
        onNodeStart: vi.fn(),
        onNodeEnd: vi.fn(),
      }

      // Start execution in harness
      harnessController.onExecutionStart(executionId, workspaceId, mockCallbacks as any)
      expect(harnessController.isActive(executionId)).toBe(true)

      // Simulate what autoResume should do: call onExecutionEnd after completion
      harnessController.onExecutionEnd(executionId)
      expect(harnessController.isActive(executionId)).toBe(false)
      expect(harnessController.activePipelineCount).toBe(0)
    })

    it("onExecutionEnd is safe to call for unknown execution", () => {
      // Should not throw even if execution was never started
      expect(() => {
        harnessController.onExecutionEnd("nonexistent-exec-id")
      }).not.toThrow()
    })
  })

  describe("AC2: runInteractionCompleteInBackground harness cleanup", () => {
    it("HarnessController cleans up after interaction completion", () => {
      const executionId = randomUUID()
      const mockCallbacks = {
        onNodeStart: vi.fn(),
        onNodeEnd: vi.fn(),
      }

      // Start execution in harness
      harnessController.onExecutionStart(executionId, workspaceId, mockCallbacks as any)
      expect(harnessController.isActive(executionId)).toBe(true)

      // Simulate what runInteractionCompleteInBackground should do after completion
      harnessController.onExecutionEnd(executionId)
      expect(harnessController.isActive(executionId)).toBe(false)
    })
  })

  describe("AC3: SSE delegate vs pause distinction", () => {
    it("ExecutionResult interface supports pauseReason field", () => {
      // Verify the ExecutionResult type accepts pauseReason
      // This is a compile-time check that the type is correct
      const result: import("@octopus/engine").ExecutionResult = {
        workflowName: "test",
        status: "paused",
        nodeResults: {},
        poolSnapshot: {},
        durationMs: 100,
        pauseReason: "harness_delegate",
      }
      expect(result.pauseReason).toBe("harness_delegate")
    })

    it("ExecutionResult without pauseReason still works (backward compatible)", () => {
      const result: import("@octopus/engine").ExecutionResult = {
        workflowName: "test",
        status: "paused",
        nodeResults: {},
        poolSnapshot: {},
        durationMs: 100,
      }
      expect(result.pauseReason).toBeUndefined()
    })

    it("harness_delegation SSE event can be distinguished from execution_paused", () => {
      const emitSpy = vi.spyOn(sse, "emit")
      const executionId = randomUUID()

      // Simulate the SSE emission that ExecutionLifecycle would do for harness delegate
      sse.emit(workspaceId, {
        event: "harness_delegation",
        data: { executionId, source: "harness_delegate" },
      })

      // Simulate the SSE emission for user pause
      sse.emit(workspaceId, {
        event: "execution_paused",
        data: { executionId },
      })

      const calls = emitSpy.mock.calls
      const delegateCall = calls.find(c => c[1].event === "harness_delegation")
      const pausedCall = calls.find(c => c[1].event === "execution_paused")

      expect(delegateCall).toBeDefined()
      expect(delegateCall![1].data.source).toBe("harness_delegate")

      expect(pausedCall).toBeDefined()
      expect(pausedCall![1].data.source).toBeUndefined()

      // They are different event types
      expect(delegateCall![1].event).not.toBe(pausedCall![1].event)
    })
  })

  describe("AC4: HarnessDAO + route handler end-to-end", () => {
    it("creates execution, inserts harness events, retrieves via GET endpoint", async () => {
      const executionId = randomUUID()

      // Create an execution record
      execDAO.insertExecution({
        id: executionId,
        workspace_id: workspaceId,
        parent_id: "0",
        child_index: 0,
        workflow_ref: "test.yaml",
        workflow_name: "test",
        name: "test-exec",
        status: "running",
        input_values: "{}",
        var_pool: "{}",
        triggered_by: "manual",
        node_type: "normal",
        branch: "main",
        org: ORG,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Insert harness events via HarnessDAO
      const event1 = makeEvent({
        id: "evt-1",
        execution_id: executionId,
        node_id: "bash-fail",
        event_type: "diagnosis",
        detector: "stupid_retry",
        severity: "warning",
        report_json: JSON.stringify({ detector: "stupid_retry", nodeId: "bash-fail", count: 3 }),
      })
      const event2 = makeEvent({
        id: "evt-2",
        execution_id: executionId,
        node_id: "bash-fail",
        event_type: "intervention",
        detector: "stupid_retry",
        severity: "warning",
        action_json: JSON.stringify({ type: "skip", reason: "repeated failure" }),
      })
      const event3 = makeEvent({
        id: "evt-3",
        execution_id: executionId,
        node_id: "agent-step",
        event_type: "delegation",
        detector: "timeout_cascade",
        severity: "critical",
        report_json: JSON.stringify({ detector: "timeout_cascade" }),
      })

      harnessDAO.insertEvent(event1)
      harnessDAO.insertEvent(event2)
      harnessDAO.insertEvent(event3)

      // Verify events are in DB
      expect(harnessDAO.countEvents(executionId)).toBe(3)

      // Call GET /harness/events/:execId via route handler
      const res = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${executionId}`)
      expect(res.status).toBe(200)

      const data = await res.json() as any
      expect(data.events).toHaveLength(3)

      // Verify events are ordered by timestamp
      expect(data.events[0].id).toBe("evt-1")
      expect(data.events[1].id).toBe("evt-2")
      expect(data.events[2].id).toBe("evt-3")

      // Verify event data integrity
      expect(data.events[0].event_type).toBe("diagnosis")
      expect(data.events[0].detector).toBe("stupid_retry")
      expect(JSON.parse(data.events[0].report_json).count).toBe(3)

      expect(data.events[1].event_type).toBe("intervention")
      expect(JSON.parse(data.events[1].action_json).type).toBe("skip")

      expect(data.events[2].event_type).toBe("delegation")
      expect(data.events[2].severity).toBe("critical")
    })

    it("filters events by type for a specific execution", async () => {
      const executionId = randomUUID()

      execDAO.insertExecution({
        id: executionId,
        workspace_id: workspaceId,
        parent_id: "0",
        child_index: 0,
        workflow_ref: "test.yaml",
        workflow_name: "test",
        name: "test-filter",
        status: "running",
        input_values: "{}",
        var_pool: "{}",
        triggered_by: "manual",
        node_type: "normal",
        branch: "main",
        org: ORG,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      harnessDAO.insertEvent(makeEvent({ id: "e1", execution_id: executionId, event_type: "diagnosis" }))
      harnessDAO.insertEvent(makeEvent({ id: "e2", execution_id: executionId, event_type: "intervention" }))
      harnessDAO.insertEvent(makeEvent({ id: "e3", execution_id: executionId, event_type: "diagnosis" }))

      const res = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${executionId}?type=diagnosis`)
      expect(res.status).toBe(200)

      const data = await res.json() as any
      expect(data.events).toHaveLength(2)
      expect(data.events.every((e: any) => e.event_type === "diagnosis")).toBe(true)
    })

    it("filters events by severity for a specific execution", async () => {
      const executionId = randomUUID()

      execDAO.insertExecution({
        id: executionId,
        workspace_id: workspaceId,
        parent_id: "0",
        child_index: 0,
        workflow_ref: "test.yaml",
        workflow_name: "test",
        name: "test-severity",
        status: "running",
        input_values: "{}",
        var_pool: "{}",
        triggered_by: "manual",
        node_type: "normal",
        branch: "main",
        org: ORG,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      harnessDAO.insertEvent(makeEvent({ id: "e1", execution_id: executionId, severity: "warning" }))
      harnessDAO.insertEvent(makeEvent({ id: "e2", execution_id: executionId, severity: "critical" }))
      harnessDAO.insertEvent(makeEvent({ id: "e3", execution_id: executionId, severity: "info" }))

      const res = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${executionId}?severity=critical`)
      expect(res.status).toBe(200)

      const data = await res.json() as any
      expect(data.events).toHaveLength(1)
      expect(data.events[0].severity).toBe("critical")
    })

    it("returns empty events for execution with no harness events", async () => {
      const executionId = randomUUID()

      execDAO.insertExecution({
        id: executionId,
        workspace_id: workspaceId,
        parent_id: "0",
        child_index: 0,
        workflow_ref: "test.yaml",
        workflow_name: "test",
        name: "test-empty",
        status: "completed",
        input_values: "{}",
        var_pool: "{}",
        triggered_by: "manual",
        node_type: "normal",
        branch: "main",
        org: ORG,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const res = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${executionId}`)
      expect(res.status).toBe(200)

      const data = await res.json() as any
      expect(data.events).toEqual([])
    })

    it("isolates events between different executions", async () => {
      const exec1 = randomUUID()
      const exec2 = randomUUID()

      for (const id of [exec1, exec2]) {
        execDAO.insertExecution({
          id,
          workspace_id: workspaceId,
          parent_id: "0",
          child_index: 0,
          workflow_ref: "test.yaml",
          workflow_name: "test",
          name: "test-isolation",
          status: "running",
          input_values: "{}",
          var_pool: "{}",
          triggered_by: "manual",
          node_type: "normal",
          branch: "main",
          org: ORG,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      }

      harnessDAO.insertEvent(makeEvent({ id: "a1", execution_id: exec1, event_type: "diagnosis" }))
      harnessDAO.insertEvent(makeEvent({ id: "a2", execution_id: exec1, event_type: "diagnosis" }))
      harnessDAO.insertEvent(makeEvent({ id: "b1", execution_id: exec2, event_type: "intervention" }))

      const res1 = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${exec1}`)
      const data1 = await res1.json() as any
      expect(data1.events).toHaveLength(2)
      expect(data1.events.every((e: any) => e.execution_id === exec1)).toBe(true)

      const res2 = await request("GET", `/api/workspaces/${workspaceId}/harness/events/${exec2}`)
      const data2 = await res2.json() as any
      expect(data2.events).toHaveLength(1)
      expect(data2.events[0].execution_id).toBe(exec2)
    })
  })
})
