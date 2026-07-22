import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { RepairService, RepairError } from "../services/repair"
import type { SSEService } from "../services/sse"
import type { ExecutionService } from "../services/execution"
import type { WorkflowService } from "../services/workflow"
import type { BuiltInWorkflowService } from "../services/builtin-workflow"

let db: Database.Database
let dbPath: string
let dao: ExecutionDAO
let wsId: string
let execId: string
let repairService: RepairService

// Minimal mocks
const mockSSE: SSEService = {
  emit: vi.fn(),
  emitToAll: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  broadcast: vi.fn(),
} as unknown as SSEService

const mockExecutionService: ExecutionService = {
  getEnginePool: vi.fn(() => ({
    get: vi.fn(() => undefined),
    has: vi.fn(() => false),
  })),
  getWorkflowContent: vi.fn(() => null),
} as unknown as ExecutionService

const mockWorkflowService: WorkflowService = {
  get: vi.fn(() => null),
} as unknown as WorkflowService

const mockBuiltInWorkflowService: BuiltInWorkflowService = {
  get: vi.fn(() => null),
} as unknown as BuiltInWorkflowService

function insertWorkspace(id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "test-ws", "test-org", "/tmp/test-ws", now, now)
}

function insertExecution(id: string, workspaceId: string, overrides: Record<string, unknown> = {}): void {
  const now = new Date().toISOString()
  const defaults = {
    id,
    workspace_id: workspaceId,
    parent_id: "0",
    workflow_ref: "test-workflow.yaml",
    workflow_name: "Test Workflow",
    status: "failed",
    org: "test-org",
    var_pool: "{}",
    retry_count: 0,
    resume_attempts: 0,
    pending_hooks: "[]",
    created_at: now,
    updated_at: now,
  }
  const row = { ...defaults, ...overrides }
  const keys = Object.keys(row)
  const placeholders = keys.map(() => "?").join(", ")
  const values = keys.map(k => (row as Record<string, unknown>)[k])
  db.prepare(
    `INSERT INTO executions (${keys.join(", ")}) VALUES (${placeholders})`
  ).run(...values)
}

function insertNodeExecution(
  id: string,
  executionId: string,
  nodeId: string,
  overrides: Record<string, unknown> = {},
): void {
  const now = new Date().toISOString()
  const defaults = {
    id,
    execution_id: executionId,
    node_id: nodeId,
    node_type: "bash",
    status: "pending",
    retry_count: 0,
    started_at: now,
  }
  const row = { ...defaults, ...overrides }
  const keys = Object.keys(row)
  const placeholders = keys.map(() => "?").join(", ")
  const values = keys.map(k => (row as Record<string, unknown>)[k])
  db.prepare(
    `INSERT INTO node_executions (${keys.join(", ")}) VALUES (${placeholders})`
  ).run(...values)
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new ExecutionDAO(db)

  wsId = randomUUID()
  execId = randomUUID()
  insertWorkspace(wsId)
  insertExecution(execId, wsId)

  repairService = new RepairService(
    dao,
    mockSSE,
    mockExecutionService,
    mockWorkflowService,
    mockBuiltInWorkflowService,
    "/tmp/test-ws",
    wsId,
  )
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  vi.restoreAllMocks()
})

// ── Diagnose ──────────────────────────────────────────────────────

describe("RepairService.diagnose", () => {
  it("returns a complete report for a failed execution", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "completed",
      outputs: JSON.stringify({ last_output: "done" }),
    })
    insertNodeExecution(`${execId}-step2`, execId, "step2", {
      status: "failed",
      error: "timeout exceeded",
    })

    const report = repairService.diagnose(execId)

    expect(report.execution.id).toBe(execId)
    expect(report.execution.status).toBe("failed")
    expect(report.nodes).toHaveLength(2)
    expect(report.nodes.find(n => n.nodeId === "step1")?.status).toBe("completed")
    expect(report.nodes.find(n => n.nodeId === "step2")?.status).toBe("failed")
    expect(report.nodes.find(n => n.nodeId === "step2")?.error).toBe("timeout exceeded")
  })

  it("throws RepairError for non-existent execution", () => {
    expect(() => repairService.diagnose("nonexistent")).toThrow(RepairError)
  })

  it("detects orphaned nodes when execution is not running", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "running",
    })

    const report = repairService.diagnose(execId)

    const orphanAnomalies = report.anomalies.filter(a => a.type === "orphaned_node")
    expect(orphanAnomalies).toHaveLength(1)
    expect(orphanAnomalies[0].nodeId).toBe("step1")
  })

  it("detects exhausted retry when node retry_count is high", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
      error: "connection refused",
      retry_count: 5,
    })

    const report = repairService.diagnose(execId)

    const retryAnomalies = report.anomalies.filter(a => a.type === "exhausted_retry")
    expect(retryAnomalies).toHaveLength(1)
    expect(retryAnomalies[0].nodeId).toBe("step1")
    expect(retryAnomalies[0].severity).toBe("critical")
  })

  it("detects false completion for agent nodes with no output", () => {
    insertNodeExecution(`${execId}-agent1`, execId, "agent1", {
      node_type: "agent",
      status: "completed",
      outputs: null,
    })

    const report = repairService.diagnose(execId)

    const falseCompletion = report.anomalies.filter(a => a.type === "false_completion")
    expect(falseCompletion).toHaveLength(1)
    expect(falseCompletion[0].nodeId).toBe("agent1")
  })

  it("detects pending_hooks anomaly", () => {
    // Re-insert with pending hooks
    db.prepare("UPDATE executions SET pending_hooks = ? WHERE id = ?").run(
      JSON.stringify([{ event: "on_complete", hook_id: "h1" }]),
      execId,
    )

    const report = repairService.diagnose(execId)

    const hookAnomalies = report.anomalies.filter(a => a.type === "pending_hooks")
    expect(hookAnomalies).toHaveLength(1)
    expect(hookAnomalies[0].severity).toBe("info")
  })

  it("detects infinite retry when execution retry_count is high", () => {
    db.prepare("UPDATE executions SET retry_count = 10 WHERE id = ?").run(execId)

    const report = repairService.diagnose(execId)

    const infiniteRetry = report.anomalies.filter(a => a.type === "infinite_retry")
    expect(infiniteRetry).toHaveLength(1)
    expect(infiniteRetry[0].severity).toBe("critical")
  })

  it("includes varPool in the report", () => {
    const varPool = { key1: "value1", key2: 42 }
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?").run(JSON.stringify(varPool), execId)

    const report = repairService.diagnose(execId)
    expect(report.varPool).toEqual(varPool)
  })

  it("emits SSE event after diagnosis", () => {
    repairService.diagnose(execId)

    expect(mockSSE.emit).toHaveBeenCalledWith(wsId, expect.objectContaining({
      event: "repair_diagnose",
    }))
  })
})

// ── VarPool Patch ─────────────────────────────────────────────────

describe("RepairService.patchVarPool", () => {
  it("merges updates into existing var_pool", () => {
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?").run(
      JSON.stringify({ existing: "value", key1: "old" }),
      execId,
    )

    const result = repairService.patchVarPool(execId, { key1: "new", key2: "added" })

    expect(result.updated).toBe(2)
    expect(result.snapshot).toEqual({ existing: "value", key1: "new", key2: "added" })

    // Verify DB was updated
    const row = db.prepare("SELECT var_pool FROM executions WHERE id = ?").get(execId) as { var_pool: string }
    expect(JSON.parse(row.var_pool)).toEqual({ existing: "value", key1: "new", key2: "added" })
  })

  it("throws RepairError for non-existent execution", () => {
    expect(() => repairService.patchVarPool("nonexistent", {})).toThrow(RepairError)
  })

  it("emits SSE event after patching", () => {
    repairService.patchVarPool(execId, { x: 1 })

    expect(mockSSE.emit).toHaveBeenCalledWith(wsId, expect.objectContaining({
      event: "repair_varpool",
    }))
  })
})

// ── Node Reset ────────────────────────────────────────────────────

describe("RepairService.resetNode", () => {
  it("resets a failed node to pending", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
      error: "something broke",
    })

    const result = repairService.resetNode(execId, "step1", "pending")

    expect(result.previousStatus).toBe("failed")
    expect(result.newStatus).toBe("pending")

    // Verify DB
    const ne = db.prepare("SELECT status, error FROM node_executions WHERE id = ?").get(`${execId}-step1`) as { status: string; error: string | null }
    expect(ne.status).toBe("pending")
    expect(ne.error).toBeNull()
  })

  it("marks a failed node as completed with injected outputs", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
    })

    const outputs = { result: "manual output", last_output: "injected" }
    const result = repairService.resetNode(execId, "step1", "completed", outputs)

    expect(result.newStatus).toBe("completed")

    const ne = db.prepare("SELECT outputs FROM node_executions WHERE id = ?").get(`${execId}-step1`) as { outputs: string | null }
    const parsed = JSON.parse(ne.outputs!)
    expect(parsed.result).toBe("manual output")
    expect(parsed.last_output).toBe("injected")
    expect(parsed.manual_override).toBe(true)
  })

  it("rejects invalid state transitions", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "running",
    })

    expect(() => repairService.resetNode(execId, "step1", "pending")).toThrow(RepairError)
  })

  it("throws RepairError for non-existent node", () => {
    expect(() => repairService.resetNode(execId, "nonexistent", "pending")).toThrow(RepairError)
  })

  it("emits SSE event after reset", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "failed" })
    repairService.resetNode(execId, "step1", "pending")

    expect(mockSSE.emit).toHaveBeenCalledWith(wsId, expect.objectContaining({
      event: "repair_node_reset",
    }))
  })
})

// ── Restore Point ─────────────────────────────────────────────────

describe("RepairService.restorePoint", () => {
  it("resets target and downstream nodes to pending", () => {
    // Create a workflow with 3 nodes: step1 → step2 → step3
    const workflowContent = `
apiVersion: octopus/v1
kind: Workflow
name: Test Workflow
nodes:
  - id: step1
    type: bash
    bash: echo 1
  - id: step2
    type: bash
    bash: echo 2
    depends_on: [step1]
  - id: step3
    type: bash
    bash: echo 3
    depends_on: [step2]
`
    vi.mocked(mockExecutionService.getWorkflowContent).mockReturnValue(workflowContent)

    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "completed" })
    insertNodeExecution(`${execId}-step2`, execId, "step2", { status: "completed" })
    insertNodeExecution(`${execId}-step3`, execId, "step3", { status: "failed", error: "broke" })

    const result = repairService.restorePoint(execId, "step2")

    expect(result.restoredFrom).toBe("step2")
    expect(result.resetNodes).toContain("step2")
    expect(result.resetNodes).toContain("step3")

    // step1 should remain completed
    const step1 = db.prepare("SELECT status FROM node_executions WHERE id = ?").get(`${execId}-step1`) as { status: string }
    expect(step1.status).toBe("completed")

    // step2 and step3 should be pending
    const step2 = db.prepare("SELECT status FROM node_executions WHERE id = ?").get(`${execId}-step2`) as { status: string }
    expect(step2.status).toBe("pending")
  })

  it("throws RepairError when workflow not found", () => {
    vi.mocked(mockExecutionService.getWorkflowContent).mockReturnValue(null)
    expect(() => repairService.restorePoint(execId, "step1")).toThrow(RepairError)
  })

  it("throws RepairError when target node not in workflow", () => {
    const workflowContent = `
apiVersion: octopus/v1
kind: Workflow
name: Test
nodes:
  - id: step1
    type: bash
    bash: echo 1
`
    vi.mocked(mockExecutionService.getWorkflowContent).mockReturnValue(workflowContent)
    expect(() => repairService.restorePoint(execId, "nonexistent")).toThrow(RepairError)
  })
})

// ── Clear Retry ───────────────────────────────────────────────────

describe("RepairService.clearRetry", () => {
  it("clears retry counts for all nodes", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "failed", retry_count: 3 })
    insertNodeExecution(`${execId}-step2`, execId, "step2", { status: "failed", retry_count: 5 })
    db.prepare("UPDATE executions SET retry_count = 2 WHERE id = ?").run(execId)

    const result = repairService.clearRetry(execId)

    expect(result.cleared).toContain("step1")
    expect(result.cleared).toContain("step2")

    const ne1 = db.prepare("SELECT retry_count FROM node_executions WHERE id = ?").get(`${execId}-step1`) as { retry_count: number }
    expect(ne1.retry_count).toBe(0)

    const exec = db.prepare("SELECT retry_count FROM executions WHERE id = ?").get(execId) as { retry_count: number }
    expect(exec.retry_count).toBe(0)
  })

  it("clears retry counts for specific nodes only", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "failed", retry_count: 3 })
    insertNodeExecution(`${execId}-step2`, execId, "step2", { status: "failed", retry_count: 5 })

    const result = repairService.clearRetry(execId, ["step1"])

    expect(result.cleared).toContain("step1")
    expect(result.cleared).not.toContain("step2")

    const ne2 = db.prepare("SELECT retry_count FROM node_executions WHERE id = ?").get(`${execId}-step2`) as { retry_count: number }
    expect(ne2.retry_count).toBe(5)
  })

  it("returns empty array when no nodes have retries", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "completed", retry_count: 0 })

    const result = repairService.clearRetry(execId)
    expect(result.cleared).toEqual([])
  })
})

// ── Intervene ─────────────────────────────────────────────────────

describe("RepairService.intervene", () => {
  it("returns injected:false when engine is not live", async () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", { status: "running" })

    const result = await repairService.intervene(execId, "step1", "please stop")

    expect(result.injected).toBe(false)
  })

  it("throws RepairError for non-existent execution", async () => {
    await expect(repairService.intervene("nonexistent", "step1", "msg")).rejects.toThrow(RepairError)
  })
})

// ── Reload Workflow ───────────────────────────────────────────────

describe("RepairService.reloadWorkflow", () => {
  it("returns reloaded:true for valid YAML", () => {
    const content = `
apiVersion: octopus/v1
kind: Workflow
name: Updated Workflow
nodes:
  - id: step1
    type: bash
    bash: echo updated
`
    const result = repairService.reloadWorkflow(execId, content)
    expect(result.reloaded).toBe(true)
  })

  it("throws RepairError for non-existent execution", () => {
    expect(() => repairService.reloadWorkflow("nonexistent", "content")).toThrow(RepairError)
  })

  it("throws on invalid YAML", () => {
    expect(() => repairService.reloadWorkflow(execId, "not: valid: yaml: [[[")).toThrow()
  })
})

// ── Error Classification ──────────────────────────────────────────

describe("RepairService error classification in diagnose", () => {
  it("classifies timeout errors", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
      error: "connection timeout exceeded",
    })

    const report = repairService.diagnose(execId)
    const err = report.recentErrors.find(e => e.nodeId === "step1")
    expect(err?.category).toBe("timeout")
  })

  it("classifies API errors", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
      error: "API rate limit exceeded (429)",
    })

    const report = repairService.diagnose(execId)
    const err = report.recentErrors.find(e => e.nodeId === "step1")
    expect(err?.category).toBe("api_error")
  })

  it("classifies permission errors", () => {
    insertNodeExecution(`${execId}-step1`, execId, "step1", {
      status: "failed",
      error: "EACCES: permission denied",
    })

    const report = repairService.diagnose(execId)
    const err = report.recentErrors.find(e => e.nodeId === "step1")
    expect(err?.category).toBe("permission")
  })
})
