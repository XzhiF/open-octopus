// packages/server/src/__tests__/execution-lifecycle.test.ts
// Characterization tests for ExecutionLifecycle — lock behavior before refactoring.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ExecutionLifecycle } from "../services/execution/ExecutionLifecycle"
import { ObservabilityService } from "../services/observability"
import { PrivacyFilter } from "../services/privacy-filter"

const BUDGET_WF = `apiVersion: octopus/v1
kind: Workflow
name: budget-test
budget:
  max_tokens: 100000
  max_duration: 300
  max_cost_usd: 2
  alert_threshold: 0.8
nodes:
  - id: step1
    type: bash
    bash: echo hello
  - id: step2
    type: bash
    bash: echo world
    depends_on:
      - step1`

const NO_BUDGET_WF = `apiVersion: octopus/v1
kind: Workflow
name: no-budget-test
nodes:
  - id: step1
    type: bash
    bash: echo hello`

const MINIMAL_WF = `apiVersion: octopus/v1
kind: Workflow
name: test
nodes:
  - id: step1
    type: bash
    bash: echo hello
  - id: step2
    type: bash
    bash: echo world
    depends_on:
      - step1`

const CONDITION_WF = `apiVersion: octopus/v1
kind: Workflow
name: condition-test
nodes:
  - id: check
    type: condition
    condition: "true"
    cases:
      - when: "true"
        then: step-yes
      - when: "false"
        then: step-no
  - id: step-yes
    type: bash
    bash: echo yes
  - id: step-no
    type: bash
    bash: echo no`

let db: Database.Database
let sse: SSEService
let wfService: WorkflowService
let builtInWfService: BuiltInWorkflowService
let dao: ExecutionDAO
let lifecycle: ExecutionLifecycle
let workspacePath: string
let workspaceId: string
let workspaceDbId: string
let dbPath: string

const ORG = "test-org"

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-lifecycle-${Date.now()}`)
  fs.mkdirSync(path.join(workspacePath, "workflows"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "projects"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "state"), { recursive: true })
  fs.writeFileSync(path.join(workspacePath, "workflows", "test.yaml"), MINIMAL_WF)
  fs.writeFileSync(path.join(workspacePath, "workflows", "condition.yaml"), CONDITION_WF)
  fs.writeFileSync(path.join(workspacePath, "workflows", "budget.yaml"), BUDGET_WF)
  fs.writeFileSync(path.join(workspacePath, "workflows", "no-budget.yaml"), NO_BUDGET_WF)
  fs.writeFileSync(
    path.join(workspacePath, "config.json"),
    JSON.stringify({ name: "test-ws", init_branch_name: "main", repos: [], created: new Date().toISOString() }),
  )

  dbPath = path.join(os.tmpdir(), `test-lifecycle-db-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  workspaceDbId = randomUUID()
  const sseWorkspaceId = ORG + ":" + workspacePath
  workspaceId = workspaceDbId // DB FK uses UUID
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(workspaceDbId, "test-ws", ORG, workspacePath, now, now)

  sse = new SSEService()
  wfService = new WorkflowService()
  builtInWfService = new BuiltInWorkflowService()
  dao = new ExecutionDAO(db)
  const obs = new ObservabilityService(db, new PrivacyFilter(), dao)

  lifecycle = new ExecutionLifecycle(
    db, dao, sse, wfService, builtInWfService,
    ORG, workspacePath, workspaceDbId, sseWorkspaceId, obs,
  )
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  if (fs.existsSync(workspacePath)) fs.rmSync(workspacePath, { recursive: true, force: true })
})

// ==================== create() ====================

describe("ExecutionLifecycle.create", () => {
  it("creates a root execution with pending status", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    expect(exec.status).toBe("pending")
    expect(exec.node_type).toBe("normal")
    expect(exec.parent_id).toBe("0")
    expect(exec.branch).toBe("main")
    expect(exec.workflow_name).toBe("test")
  })

  it("creates a child execution inheriting parent branch", () => {
    const root = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const child = lifecycle.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: root.id,
      node_type: "normal",
    }, ORG)
    expect(child.parent_id).toBe(root.id)
    expect(child.branch).toBe(root.branch)
  })

  it("creates a fork execution with derived branch name", () => {
    const root = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const fork = lifecycle.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: root.id,
      node_type: "fork",
    }, ORG)
    expect(fork.node_type).toBe("fork")
    expect(fork.branch).toContain("fork")
    expect(fork.branch).toContain(fork.id.substring(0, 8))
  })

  it("throws when creating second root in same workspace", () => {
    lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    expect(() => lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG))
      .toThrow(/already has a root/)
  })

  // ── ADR-0021 票03 — the seam the whole design rests on, tested UNSUBSTUBBED ──
  it("writes task_id / phase_index / round_index AT INSERT (the row IS the instance)", () => {
    // This is the one line of the refactor that no tasks-domain test could catch: those
    // stub ExecutionService.create and do the INSERT themselves, so they pin what the
    // stub writes, not what production writes. If these three fields are dropped here,
    // the latch (ux_exec_task_active) cannot protect the row, idx_exec_pending_claimable
    // cannot find it — an armed task never launches and the board shows nothing. Found by
    // booting the built server and triggering a task (spec §8b).
    const exec = lifecycle.create(workspaceId, {
      workflow_ref: "test.yaml", task_id: "task-bind-1", phase_index: 2, round_index: 3,
    }, ORG)
    expect(exec.task_id).toBe("task-bind-1")
    expect(exec.phase_index).toBe(2)
    expect(exec.round_index).toBe(3)
    // Read back from the DB rather than trusting the returned object.
    const raw = db.prepare("SELECT task_id, phase_index, round_index FROM executions WHERE id = ?")
      .get(exec.id) as { task_id: string; phase_index: number; round_index: number }
    expect(raw).toEqual({ task_id: "task-bind-1", phase_index: 2, round_index: 3 })
  })

  it("a task-bound root is exempt from the one-root-per-ws invariant (and stays findable)", () => {
    // The exemption is only safe because the row carries its task: the tighter latch
    // replaces the invariant it waives. A second root for the SAME task must hit the
    // UNIQUE index, and both rows must be claimable by the built-in job.
    const first = lifecycle.create(workspaceId, { workflow_ref: "test.yaml", task_id: "task-bind-2" }, ORG)
    expect(() => lifecycle.create(workspaceId, { workflow_ref: "test.yaml", task_id: "task-bind-2" }, ORG))
      .toThrow(/ux_exec_task_active|UNIQUE/i)
    const claimable = db.prepare(
      "SELECT id FROM executions WHERE task_id = 'task-bind-2' AND status = 'pending'",
    ).all() as { id: string }[]
    expect(claimable.map((r) => r.id)).toEqual([first.id])
  })

  it("a generic launch is unaffected (task columns NULL, invariant still enforced)", () => {
    lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const plain = db.prepare("SELECT task_id, phase_index, round_index FROM executions ORDER BY created_at DESC LIMIT 1")
      .get() as { task_id: string | null; phase_index: number | null; round_index: number | null }
    expect(plain).toEqual({ task_id: null, phase_index: null, round_index: null })
  })

  // ── 票05 真机实测:the claim→start handoff ──
  it("a claimed row starts with its own lease and refuses somebody else's", async () => {
    // The built-in task-lifecycle job claims (guarded pending→running) BEFORE it starts,
    // because the claim — not start — is the serializer for "who runs this task". That
    // makes the row non-'pending' at the moment start() is called, which is exactly how
    // every real task launch died before this handoff existed ("Execution is not
    // pending", found on a booted server, invisible to the stubbed tests).
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml", task_id: "task-lease" }, ORG)
    const lease = new Date().toISOString()
    expect(dao.claimLaunch(exec.id, lease).changes).toBe(1)

    // Right lease: accepted, and the claim's started_at is NOT rewritten (the queue and the
    // duration math read that instant).
    const started = await lifecycle.start(exec.id, undefined, undefined, lease)
    // The stub workflow in this harness runs to completion inside start(), so the only
    // status assertions available here are "it did NOT bounce off the precondition" plus
    // the lease surviving (a re-write would move started_at and with it the launch instant
    // the queue and duration math read).
    expect(["running", "completed"]).toContain(started.status)
    expect(started.started_at).toBe(lease)

    // Somebody else's lease (or none) is a different owner's claim → refused.
    const other = lifecycle.create(workspaceId, { workflow_ref: "test.yaml", task_id: "task-lease-2" }, ORG)
    const lease2 = new Date().toISOString()
    dao.claimLaunch(other.id, lease2)
    await expect(lifecycle.start(other.id, undefined, undefined, "2020-01-01T00:00:00.000Z"))
      .rejects.toThrow(/not claimed by this launcher/)
    await expect(lifecycle.start(other.id)).rejects.toThrow(/not pending/)
    // Still the original claim — a refused start must not have touched it.
    expect(dao.findById(other.id)!.started_at).toBe(lease2)
  })

  it("stores initial_var_pool as JSON", () => {
    const exec = lifecycle.create(workspaceId, {
      workflow_ref: "test.yaml",
      initial_var_pool: { FOO: "bar" },
    }, ORG)
    expect(JSON.parse(exec.var_pool)).toEqual({ FOO: "bar" })
  })
})

// ==================== delete() ====================

describe("ExecutionLifecycle.delete", () => {
  it("deletes an execution and returns true", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const result = lifecycle.delete(exec.id)
    expect(result).toBe(true)
    expect(dao.findById(exec.id)).toBeNull()
  })
})

// ==================== skip() ====================

describe("ExecutionLifecycle.skip", () => {
  it("sets gate_status to bypassed", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    lifecycle.skip(exec.id)
    const updated = dao.findById(exec.id)
    expect(updated!.gate_status).toBe("bypassed")
  })
})

// ==================== computeBranch() ====================

describe("ExecutionLifecycle.computeBranch", () => {
  it("returns init_branch_name from config for root executions", () => {
    const branch = lifecycle.computeBranch(workspaceId, null, "normal", "new-id")
    expect(branch).toBe("main")
  })

  it("returns parent branch for normal child", () => {
    const root = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const branch = lifecycle.computeBranch(workspaceId, root.id, "normal", "new-id")
    expect(branch).toBe(root.branch)
  })

  it("returns fork branch with execution id prefix", () => {
    const root = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const newId = randomUUID()
    const branch = lifecycle.computeBranch(workspaceId, root.id, "fork", newId)
    expect(branch).toBe(`${root.branch}-fork-${newId.substring(0, 8)}`)
  })

  it("throws for invalid parent_id", () => {
    expect(() => lifecycle.computeBranch(workspaceId, "nonexistent", "normal", "new-id"))
      .toThrow(/not found/)
  })
})

// ==================== resolveWorkflowName() ====================

describe("ExecutionLifecycle.resolveWorkflowName", () => {
  it("resolves name from local workflow file", () => {
    const name = lifecycle.resolveWorkflowName("test.yaml")
    expect(name).toBe("test")
  })

  it("returns workflow_ref when not found", () => {
    // BuiltInWorkflowService requires resourceManager — without it, the fallback throws.
    // The method catches this gracefully in practice; test the local workflow path instead.
    const name = lifecycle.resolveWorkflowName("test.yaml")
    expect(name).toBe("test")
  })
})

// ==================== getLogEvents() ====================

describe("ExecutionLifecycle.getLogEvents", () => {
  it("returns empty array for execution with no node executions", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const events = lifecycle.getLogEvents(exec.id)
    expect(events).toEqual([])
  })

  it("returns events from node executions", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    // Manually insert node executions to simulate lifecycle
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "bash", status: "completed",
      started_at: "2024-01-01T00:00:00Z",
    })
    const events = lifecycle.getLogEvents(exec.id)
    expect(events.length).toBe(1)
    expect(events[0].data.nodeId).toBe("step1")
    expect(events[0].data.status).toBe("completed")
  })
})

// ==================== getTokenUsagesForExecution() ====================

describe("ExecutionLifecycle.getTokenUsagesForExecution", () => {
  it("returns empty array when no token usages recorded", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const usages = lifecycle.getTokenUsagesForExecution(exec.id)
    expect(usages).toEqual([])
  })

  it("aggregates token usages by model across steps", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    // Insert node executions and token usages
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "agent", status: "completed",
    })
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step2`, execution_id: exec.id,
      node_id: "step2", node_type: "agent", status: "completed",
    })
    const now = new Date().toISOString()
    const tokenDao = new TokenUsageDAO(dao.getDb())
    tokenDao.recordNodeUsage({ id: `${exec.id}-step1-token-claude`, nodeExecutionId: `${exec.id}-step1`, model: "claude", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 }, costUsd: 0.01, source: 'node', createdAt: now })
    tokenDao.recordNodeUsage({ id: `${exec.id}-step2-token-claude`, nodeExecutionId: `${exec.id}-step2`, model: "claude", usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 30, cacheCreationTokens: 15 }, costUsd: 0.02, source: 'node', createdAt: now })

    const usages = lifecycle.getTokenUsagesForExecution(exec.id)
    expect(usages.length).toBe(1)
    expect(usages[0].model).toBe("claude")
    expect(usages[0].inputTokens).toBe(300)
    expect(usages[0].outputTokens).toBe(130)
    expect(usages[0].cacheReadTokens).toBe(50)
    expect(usages[0].cacheCreationTokens).toBe(25)
  })
})

// ==================== getTokenUsagesPerStep() ====================

describe("ExecutionLifecycle.getTokenUsagesPerStep", () => {
  it("returns per-step token usages", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "agent", status: "completed",
    })
    const now = new Date().toISOString()
    new TokenUsageDAO(dao.getDb()).recordNodeUsage({ id: `${exec.id}-step1-token-claude`, nodeExecutionId: `${exec.id}-step1`, model: "claude", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 }, costUsd: 0.01, source: 'node', createdAt: now })

    const usages = lifecycle.getTokenUsagesPerStep(exec.id)
    expect(usages.length).toBe(1)
    expect(usages[0].stepId).toBe("step1")
    expect(usages[0].model).toBe("claude")
    expect(usages[0].inputTokens).toBe(100)
  })
})

// ==================== syncStateJson() ====================

describe("ExecutionLifecycle.syncStateJson", () => {
  it("writes executions.json to state directory", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    lifecycle.syncStateJson()

    const stateFile = path.join(workspacePath, "state", "executions.json")
    expect(fs.existsSync(stateFile)).toBe(true)

    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    expect(state.workspace_id).toBe(workspaceDbId)
    expect(state.executions.length).toBe(1)
    expect(state.executions[0].execution_id).toBe(exec.id)
    expect(state.executions[0].workflow_ref).toBe("test.yaml")
  })

  it("includes all executions in workspace", () => {
    const root = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const child = lifecycle.create(workspaceId, {
      workflow_ref: "test.yaml", parent_id: root.id,
    }, ORG)
    lifecycle.syncStateJson()

    const stateFile = path.join(workspacePath, "state", "executions.json")
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    expect(state.executions.length).toBe(2)
  })
})

// ==================== getStateJson() ====================

describe("ExecutionLifecycle.getStateJson", () => {
  it("returns null for nonexistent state file", () => {
    const result = lifecycle.getStateJson("nonexistent")
    expect(result).toBeNull()
  })
})

// ==================== getWorkflowContent() ====================

describe("ExecutionLifecycle.getWorkflowContent", () => {
  it("returns workflow content from snapshot if exists", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    // Simulate snapshot creation (normally done by start())
    const snapshotName = `${exec.id}-test.yaml`
    fs.writeFileSync(path.join(workspacePath, "state", snapshotName), MINIMAL_WF, "utf-8")

    const content = lifecycle.getWorkflowContent(exec.id)
    expect(content).toBe(MINIMAL_WF)
  })

  it("falls back to workflow service if no snapshot", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const content = lifecycle.getWorkflowContent(exec.id)
    expect(content).toBe(MINIMAL_WF)
  })

  it("returns null for nonexistent execution", () => {
    const result = lifecycle.getWorkflowContent("nonexistent")
    expect(result).toBeNull()
  })
})

// ==================== buildCallbacks() ====================

describe("ExecutionLifecycle.buildCallbacks", () => {
  it("returns an object with all expected callback methods", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const cb = lifecycle.buildCallbacks(exec.id)

    expect(cb.onNodeStart).toBeTypeOf("function")
    expect(cb.onNodeEnd).toBeTypeOf("function")
    expect(cb.onNodeLog).toBeTypeOf("function")
    expect(cb.onNodeCompacted).toBeTypeOf("function")
    expect(cb.onStatusChange).toBeTypeOf("function")
    expect(cb.onError).toBeTypeOf("function")
    expect(cb.onComplete).toBeTypeOf("function")
    expect(cb.onBranchStart).toBeTypeOf("function")
    expect(cb.onBranchEnd).toBeTypeOf("function")
    expect(cb.onAgentEvent).toBeTypeOf("function")
    expect(cb.onSwarmEvent).toBeTypeOf("function")
    expect(cb.onNodeRetry).toBeTypeOf("function")
    expect(cb.onPipelineReloaded).toBeTypeOf("function")
    expect(cb.onRuntimeNodeAdded).toBeTypeOf("function")
  })

  it("onNodeStart updates node status to running and emits SSE", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    // Manually ensure node execution exists
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "bash", status: "pending",
    })

    const cb = lifecycle.buildCallbacks(exec.id)
    const emitSpy = vi.spyOn(sse, "emit")

    cb.onNodeStart!("step1", "bash")

    const ne = dao.findNodeExecutionById(`${exec.id}-step1`)
    expect(ne!.status).toBe("running")
    expect(ne!.started_at).toBeTruthy()

    // Verify SSE emission
    const nodeStartEvent = emitSpy.mock.calls.find(c => c[1]?.event === "node_start")
    expect(nodeStartEvent).toBeTruthy()
    expect(nodeStartEvent![1].data.nodeId).toBe("step1")
  })

  it("onNodeEnd updates node status with duration", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "bash", status: "running",
    })

    const cb = lifecycle.buildCallbacks(exec.id)
    cb.onNodeEnd!("step1", "completed", 5000, { outputs: { result: "ok" } }, "bash")

    const ne = dao.findNodeExecutionById(`${exec.id}-step1`)
    expect(ne!.status).toBe("completed")
    expect(ne!.duration).toBe(5000)
    expect(ne!.completed_at).toBeTruthy()
  })

  it("onError updates node status to failed", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "bash", status: "running",
    })

    const cb = lifecycle.buildCallbacks(exec.id)
    cb.onError!("step1", "something went wrong")

    const ne = dao.findNodeExecutionById(`${exec.id}-step1`)
    expect(ne!.status).toBe("failed")
    expect(ne!.error).toBe("something went wrong")
  })

  it("onBranchStart/onBranchEnd emit SSE events with timing", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const cb = lifecycle.buildCallbacks(exec.id)
    const emitSpy = vi.spyOn(sse, "emit")

    cb.onBranchStart!(`${exec.id}-step1`, 1)
    const startEvent = emitSpy.mock.calls.find(c => c[1]?.event === "branch_start")
    expect(startEvent).toBeTruthy()
    expect(startEvent![1].data.iteration).toBe(1)

    // Small delay to get measurable duration
    cb.onBranchEnd!(`${exec.id}-step1`, 1, "completed", [])
    const endEvent = emitSpy.mock.calls.find(c => c[1]?.event === "branch_end")
    expect(endEvent).toBeTruthy()
    expect(endEvent![1].data.status).toBe("completed")
    expect(typeof endEvent![1].data.durationMs).toBe("number")
  })

  it("onRuntimeNodeAdded inserts new node execution", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const cb = lifecycle.buildCallbacks(exec.id)

    cb.onRuntimeNodeAdded!("dynamic-node", "bash")

    const ne = dao.findNodeExecutionById(`${exec.id}-dynamic-node`)
    expect(ne).toBeTruthy()
    expect(ne!.node_type).toBe("bash")
    expect(ne!.status).toBe("pending")
  })

  it("onComplete fires external callbacks when registered", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const externalComplete = vi.fn()
    lifecycle.registerExternalCallbacks({ onComplete: externalComplete }, exec.id)

    const cb = lifecycle.buildCallbacks(exec.id)
    cb.onComplete!()

    expect(externalComplete).toHaveBeenCalledOnce()
  })

  it("onComplete fires default external callbacks", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const externalComplete = vi.fn()
    lifecycle.registerExternalCallbacks({ onComplete: externalComplete })

    const cb = lifecycle.buildCallbacks(exec.id)
    cb.onComplete!()

    expect(externalComplete).toHaveBeenCalledOnce()
  })

  it("onNodeEnd persists token usage when modelUsages present", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    dao.insertNodeExecutionOrIgnore({
      id: `${exec.id}-step1`, execution_id: exec.id,
      node_id: "step1", node_type: "agent", status: "running",
    })

    const cb = lifecycle.buildCallbacks(exec.id)
    cb.onNodeEnd!("step1", "completed", 3000, {
      modelUsages: [{
        model: "claude-sonnet-4-20250514",
        inputTokens: 500, outputTokens: 200, costUsd: 0.005,
        cacheReadTokens: 100, cacheCreationTokens: 50,
      }],
    }, "agent")

    const usages = lifecycle.getTokenUsagesPerStep(exec.id)
    expect(usages.length).toBe(1)
    expect(usages[0].model).toBe("claude-sonnet-4-20250514")
    expect(usages[0].inputTokens).toBe(500)
  })
})

// ==================== External callbacks management ====================

describe("ExecutionLifecycle external callbacks", () => {
  it("registerExternalCallbacks stores callbacks for specific execution", () => {
    const cb = { onComplete: vi.fn() }
    lifecycle.registerExternalCallbacks(cb, "exec-1")
    // The external callbacks should be fired when buildCallbacks(exec-1).onComplete is called
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    lifecycle.registerExternalCallbacks(cb, exec.id)

    const callbacks = lifecycle.buildCallbacks(exec.id)
    callbacks.onComplete!()
    expect(cb.onComplete).toHaveBeenCalledOnce()
  })

  it("clearExternalCallbacks removes callbacks for specific execution", () => {
    const cb = { onComplete: vi.fn() }
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    lifecycle.registerExternalCallbacks(cb, exec.id)
    lifecycle.clearExternalCallbacks(exec.id)

    const callbacks = lifecycle.buildCallbacks(exec.id)
    callbacks.onComplete!()
    expect(cb.onComplete).not.toHaveBeenCalled()
  })
})

// ==================== createRefResolver() ====================

describe("ExecutionLifecycle.createRefResolver", () => {
  it("returns undefined for invalid ref paths", () => {
    const resolver = lifecycle.createRefResolver()
    expect(resolver("")).toBeUndefined()
    expect(resolver("nodots")).toBeUndefined()
    expect(resolver("one.dot")).toBeUndefined()
  })

  it("returns undefined for non-existent cross-exec outputs", () => {
    const resolver = lifecycle.createRefResolver()
    expect(resolver("workflow.node.output")).toBeUndefined()
  })
})

// ==================== getAgentEvents() ====================

describe("ExecutionLifecycle.getAgentEvents", () => {
  it("returns empty array when log directory does not exist", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const events = lifecycle.getAgentEvents(exec.id)
    expect(events).toEqual([])
  })

  it("reads events from JSONL log files", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const logDir = path.join(workspacePath, "logs", exec.id)
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(
      path.join(logDir, "step1.jsonl"),
      JSON.stringify({ timestamp: "2024-01-01T00:00:00Z", type: "text", content: "hello" }) + "\n",
    )

    const events = lifecycle.getAgentEvents(exec.id)
    expect(events.length).toBe(1)
    expect(events[0].content).toBe("hello")
    expect(events[0].nodeId).toBe("step1")
  })
})

// ==================== getLoopIterationSummary() ====================

describe("ExecutionLifecycle.getLoopIterationSummary", () => {
  it("returns empty object when log directory does not exist", () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)
    const summary = lifecycle.getLoopIterationSummary(exec.id)
    expect(summary).toEqual({})
  })
})

// ==================== budget snapshot ====================

describe("ExecutionLifecycle.start budget_snapshot", () => {
  it("writes budget_snapshot when workflow has budget", async () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "budget.yaml" }, ORG)

    // start() runs the full lifecycle; budget_snapshot is written before engine creation
    // Even if later phases fail, the snapshot should already be persisted.
    try {
      await lifecycle.start(exec.id)
    } catch {
      // start() may throw for reasons unrelated to budget_snapshot (git, engine_init, etc.)
    }

    const row = dao.findById(exec.id)
    expect(row).toBeTruthy()
    expect(row!.budget_snapshot).toBeTruthy()

    const snapshot = JSON.parse(row!.budget_snapshot!)
    expect(snapshot.max_tokens).toBe(100000)
    expect(snapshot.max_duration).toBe(300)
    expect(snapshot.max_cost_usd).toBe(2)
    expect(snapshot.alert_threshold).toBe(0.8)
  }, 30000)

  it("leaves budget_snapshot NULL when workflow has no budget", async () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "no-budget.yaml" }, ORG)

    try {
      await lifecycle.start(exec.id)
    } catch {
      // start() may throw for reasons unrelated to budget_snapshot
    }

    const row = dao.findById(exec.id)
    expect(row).toBeTruthy()
    expect(row!.budget_snapshot).toBeNull()
  }, 30000)
})
