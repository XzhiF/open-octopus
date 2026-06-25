import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import { ExecutionService } from "../services/execution"

const MINIMAL_WF = "apiVersion: octopus/v1\nkind: Workflow\nname: test\nnodes:\n  - id: step1\n    type: bash\n    bash: echo hello"

let db: Database.Database
let sse: SSEService
let wfService: WorkflowService
let builtInWfService: BuiltInWorkflowService
let execService: ExecutionService
let workspacePath: string
let workspaceId: string
let dbPath: string

const ORG = "test-org"

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-exec-svc-${Date.now()}`)
  fs.mkdirSync(path.join(workspacePath, "workflows"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "projects"), { recursive: true })
  fs.writeFileSync(path.join(workspacePath, "workflows", "test.yaml"), MINIMAL_WF)
  fs.writeFileSync(path.join(workspacePath, "config.json"), JSON.stringify({ name: "test-ws", init_branch_name: "haha", repos: [], created: new Date().toISOString() }))

  dbPath = path.join(os.tmpdir(), `test-exec-db-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  workspaceId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(workspaceId, "test-ws", ORG, workspacePath, now, now)

  sse = new SSEService()
  wfService = new WorkflowService()
  builtInWfService = new BuiltInWorkflowService()
  execService = new ExecutionService(db, sse, wfService, builtInWfService, ORG, workspacePath, workspaceId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  if (fs.existsSync(workspacePath)) fs.rmSync(workspacePath, { recursive: true, force: true })
})

describe("ExecutionService.create", () => {
  it("creates an execution with node_type normal by default", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    expect(exec.node_type).toBe("normal")
    expect(exec.branch).toBe("haha")
    expect(exec.parent_id).toBe("0")
  })

  it("creates an execution with specified node_type", () => {
    const exec = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      node_type: "fork",
    })
    expect(exec.node_type).toBe("fork")
  })

  it("creates fork node with branch derived from parent", () => {
    const parent = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const child = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: parent.id,
      node_type: "fork",
    })
    expect(child.node_type).toBe("fork")
    expect(child.branch).toBeTruthy()
    expect(child.branch).toContain("-fork-")
    expect(child.parent_id).toBe(parent.id)
  })

  it("creates normal child inheriting parent branch", () => {
    const root = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const forkChild = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: root.id,
      node_type: "fork",
    })
    const normalChild = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: forkChild.id,
      node_type: "normal",
    })
    expect(normalChild.node_type).toBe("normal")
    expect(normalChild.branch).toBe(forkChild.branch)
  })

  it("fork with no parent_id gets init_branch_name", () => {
    const exec = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      node_type: "fork",
    })
    expect(exec.branch).toBe("haha")
  })

  it("normal node with no parent_id gets init_branch_name", () => {
    const exec = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
    })
    expect(exec.branch).toBe("haha")
  })

  it("emits execution_created SSE event with treeNodeId", () => {
    const events: unknown[] = []
    sse.subscribe(workspaceId, (e) => events.push(e))
    const created = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    expect(events.length).toBe(1)
    const evt = events[0] as { event: string; data: { executionId: string; treeNodeId: string } }
    expect(evt.event).toBe("execution_created")
    expect(evt.data.treeNodeId).toBe(created.id)
    expect(evt.data.executionId).toBe(created.id)
  })
})

describe("ExecutionService.syncStateJson", () => {
  it("create() writes executions.json automatically", () => {
    const stateDir = path.join(workspacePath, "state")
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true })

    execService.create(workspaceId, { workflow_ref: "test.yaml" })
    // create() should call syncStateJson() internally, so file should exist

    expect(fs.existsSync(path.join(stateDir, "executions.json"))).toBe(true)
  })

  it("creates state directory if not exists", () => {
    const stateDir = path.join(workspacePath, "state")
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true })

    const created = execService.create(workspaceId, { workflow_ref: "test.yaml" }); // eslint-disable-line no-extra-semi
    (execService as any).syncStateJson()

    expect(fs.existsSync(stateDir)).toBe(true)
    expect(fs.existsSync(path.join(stateDir, "executions.json"))).toBe(true)
  })

  it("writes valid JSON with expected structure", () => {
    const created = execService.create(workspaceId, { workflow_ref: "test.yaml" }); // eslint-disable-line no-extra-semi
    (execService as any).syncStateJson()

    const stateDir = path.join(workspacePath, "state")
    const content = fs.readFileSync(path.join(stateDir, "executions.json"), "utf-8")
    const state = JSON.parse(content)

    expect(state.workspace_id).toBe(workspaceId)
    expect(state.updated_at).toBeTruthy()
    expect(state.executions).toBeInstanceOf(Array)
    expect(state.executions.length).toBe(1)
    expect(state.executions[0].node_type).toBe("normal")
    expect(state.executions[0].status).toBe("pending")
    expect(state.executions[0].workflow_name).toBe("test")
  })

  it("reflects node_type and branch in state file", () => {
    const root = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const forkChild = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      parent_id: root.id,
      node_type: "fork",
    }); // eslint-disable-line no-extra-semi
    (execService as any).syncStateJson()

    const stateDir = path.join(workspacePath, "state")
    const content = fs.readFileSync(path.join(stateDir, "executions.json"), "utf-8")
    const state = JSON.parse(content)

    const forkEntry = state.executions.find((e: any) => e.node_type === "fork")
    expect(forkEntry).toBeDefined()
    expect(forkEntry.branch).toBeTruthy()
    expect(forkEntry.parent_id).toBe(root.id)
  })

  it("reflects updated state after status change via skip", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    execService.skip(exec.id)
    // skip() calls syncStateJson() internally

    const stateDir = path.join(workspacePath, "state")
    const content = fs.readFileSync(path.join(stateDir, "executions.json"), "utf-8")
    const state = JSON.parse(content)

    const entry = state.executions.find((e: any) => e.execution_id === exec.id)
    expect(entry).toBeDefined()
    expect(entry.status).toBe("pending")
  })

  it("records start_commit_id and end_commit_id as parsed objects in state", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })

    db.prepare("UPDATE executions SET start_commit_id = ?, end_commit_id = ? WHERE id = ?")
      .run(JSON.stringify({ "project-a": "abc123" }), JSON.stringify({ "project-a": "def456" }), exec.id)

    ;(execService as any).syncStateJson()  // leading semicolon prevents ASI

    const stateDir = path.join(workspacePath, "state")
    const content = fs.readFileSync(path.join(stateDir, "executions.json"), "utf-8")
    const state = JSON.parse(content)

    const entry = state.executions.find((e: any) => e.execution_id === exec.id)
    expect(entry.start_commit_id).toEqual({ "project-a": "abc123" })
    expect(entry.end_commit_id).toEqual({ "project-a": "def456" })
  })

  it("handles null start_commit_id and end_commit_id in state", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" }); // eslint-disable-line no-extra-semi
    (execService as any).syncStateJson()

    const stateDir = path.join(workspacePath, "state")
    const content = fs.readFileSync(path.join(stateDir, "executions.json"), "utf-8")
    const state = JSON.parse(content)

    const entry = state.executions.find((e: any) => e.execution_id === exec.id)
    expect(entry.start_commit_id).toBeNull()
    expect(entry.end_commit_id).toBeNull()
  })
})

describe("ExecutionService.getById and list", () => {
  it("returns execution with all new fields", () => {
    const exec = execService.create(workspaceId, {
      workflow_ref: "test.yaml",
      node_type: "fork",
    })
    const fetched = execService.getById(exec.id)
    expect(fetched).toBeDefined()
    expect(fetched!.node_type).toBe("fork")
    expect(fetched!.branch).toBe("haha")
  })

  it("lists executions with new fields", () => {
    const root = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    execService.create(workspaceId, { workflow_ref: "test.yaml", node_type: "fork", parent_id: root.id })
    const list = execService.list(workspaceId)
    expect(list.length).toBe(2)
    expect(list.some(e => e.node_type === "normal")).toBe(true)
    expect(list.some(e => e.node_type === "fork")).toBe(true)
  })
})

describe("ExecutionService.skip", () => {
  it("skip updates gate_status and syncs state", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const result = execService.skip(exec.id)
    expect(result).toBe(true)

    const fetched = execService.getById(exec.id)
    expect(fetched!.gate_status).toBe("bypassed")
  })
})

describe("ExecutionService.delete", () => {
  it("deletes an execution", () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    expect(execService.delete(exec.id)).toBe(true)
    expect(execService.getById(exec.id)).toBeUndefined()
  })
})

describe("ExecutionService.cancel", () => {
  it("cancel throws for non-running/paused status", async () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    await expect(execService.cancel(exec.id)).rejects.toThrow("Cannot cancel in current status")
  })
})

describe("ExecutionService.start single-leaf constraint", () => {
  it("start throws 409 when another leaf is running", async () => {
    const exec1 = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const exec2 = execService.create(workspaceId, { workflow_ref: "test.yaml", parent_id: exec1.id })
    const exec3 = execService.create(workspaceId, { workflow_ref: "test.yaml", parent_id: exec1.id })

    // Mark exec2 as running — it's a leaf (no children), so constraint should fire
    db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(exec2.id)

    try {
      await execService.start(exec3.id)
      expect.fail("Should have thrown")
    } catch (err: any) {
      expect(err.message).toBe("已有叶子节点正在执行，请等待其完成")
      expect(err.status).toBe(409)
    }
  })
})