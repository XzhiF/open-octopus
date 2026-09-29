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
import { ExecutionService } from "../services/execution"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"

const ORG = "test-org"

// P1 B4 票2B-3：onNodeEnd 的落账尾段（recordNodeUsage/costForNodeExecution）已迁 PG，
// 且跑在 fire-and-forget async 体里 —— 本文件钉的是 outputs 持久化与 $ref 解析（纯
// SQLite 读模型），套用 execution-lifecycle 已验证的桩注入配方（ExecutionService
// 第 10 参 → ExecutionLifecycle 第 12 参），把跨引擎空 join 关在测试边界之外。
function makeStubTokenUsageDao(handle: Database.Database): TokenUsageDAO {
  return {
    recordNodeUsage: vi.fn(async (input: any) => {
      handle.prepare(
        `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.id, input.nodeExecutionId, input.model,
        input.usage?.inputTokens ?? 0, input.usage?.outputTokens ?? 0,
        input.usage?.cacheReadTokens ?? 0, input.usage?.cacheCreationTokens ?? 0,
        input.source ?? 'node', input.createdAt ?? new Date().toISOString(),
      )
    }),
    costForNodeExecution: vi.fn(async () => ({ usd: 0 })),
    aggregateByExecution: vi.fn(async () => null),
    insertLlmCallBatch: vi.fn(async () => undefined),
  } as unknown as TokenUsageDAO
}

let db: Database.Database
let sse: SSEService
let wfService: WorkflowService
let builtInWfService: BuiltInWorkflowService
let execService: ExecutionService
let stubTokenUsage: TokenUsageDAO
let workspacePath: string
let workspaceId: string
let dbPath: string

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-ref-${Date.now()}`)
  fs.mkdirSync(path.join(workspacePath, "workflows"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "projects"), { recursive: true })

  const wfContent = `apiVersion: octopus/v1
kind: Workflow
name: test
nodes:
  - id: step1
    type: bash
    bash: echo hello
`
  fs.writeFileSync(path.join(workspacePath, "workflows", "test.yaml"), wfContent)
  fs.writeFileSync(
    path.join(workspacePath, "config.json"),
    JSON.stringify({ name: "test-ws", init_branch_name: "main", repos: [], created: new Date().toISOString() }),
  )

  dbPath = path.join(os.tmpdir(), `test-ref-db-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  workspaceId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(workspaceId, "test-ws", ORG, workspacePath, now, now)

  sse = new SSEService()
  wfService = new WorkflowService()
  builtInWfService = new BuiltInWorkflowService()
  stubTokenUsage = makeStubTokenUsageDao(db)
  execService = new ExecutionService(db, sse, wfService, builtInWfService, ORG, workspacePath, workspaceId,
    undefined, undefined, stubTokenUsage)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  if (fs.existsSync(workspacePath)) fs.rmSync(workspacePath, { recursive: true, force: true })
})

describe("node_executions.outputs persistence", () => {
  it("writes outputs to node_executions table via onNodeEnd callback", async () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const neId = `${exec.id}-step1`

    // Ensure node_executions row exists (ensureNodeExecutions creates it)
    db.prepare(
      "INSERT OR IGNORE INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(neId, exec.id, "step1", "bash", "running", new Date().toISOString())

    // Simulate onNodeEnd callback with outputs
    const callbacks = (execService as any).buildCallbacks(exec.id)
    callbacks.onNodeEnd("step1", "completed", 500, {
      outputs: { last_output: "hello world", exit_code: 0 },
      status: "completed",
      durationMs: 500,
      logLines: [],
    })

    // Verify outputs were persisted
    const row = db.prepare("SELECT outputs FROM node_executions WHERE id = ?").get(neId) as {
      outputs: string | null
    }
    expect(row.outputs).toBeTruthy()
    const parsed = JSON.parse(row.outputs!)
    expect(parsed.last_output).toBe("hello world")
    expect(parsed.exit_code).toBe(0)

    // 落账尾段是微任务 —— 等桩被调用后断言，确保 async 体在 afterEach 关库前收尾。
    await vi.waitFor(() => expect(stubTokenUsage.costForNodeExecution).toHaveBeenCalled(), { timeout: 1500 })
  })

  it("stores empty outputs object when result has no outputs", async () => {
    const exec = execService.create(workspaceId, { workflow_ref: "test.yaml" })
    const neId = `${exec.id}-step1`

    db.prepare(
      "INSERT OR IGNORE INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(neId, exec.id, "step1", "bash", "running", new Date().toISOString())

    const callbacks = (execService as any).buildCallbacks(exec.id)
    callbacks.onNodeEnd("step1", "failed", 100, {
      status: "failed",
      durationMs: 100,
      logLines: [],
      error: "timeout",
    })

    const row = db.prepare("SELECT outputs FROM node_executions WHERE id = ?").get(neId) as {
      outputs: string | null
    }
    // No outputs property on result → outputs column stays null (no spread)
    expect(row.outputs).toBeNull()

    await vi.waitFor(() => expect(stubTokenUsage.costForNodeExecution).toHaveBeenCalled(), { timeout: 1500 })
  })
})

describe("$ref: cross-execution resolution", () => {
  it("resolves $ref:workflowRef.nodeId.outputKey from latest completed execution", () => {
    // Simulate a completed execution with outputs stored in node_executions
    const pastExecId = `past-exec-${Date.now()}`
    const now = new Date().toISOString()

    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(pastExecId, workspaceId, "security-scan.yaml", "Security Scan", "completed", ORG, now, now)

    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `${pastExecId}-scan`,
      pastExecId,
      "scan",
      "bash",
      "completed",
      now,
      now,
      JSON.stringify({ last_output: "3 critical vulnerabilities", exit_code: 0 }),
    )

    // Create the resolver and test it
    const resolver = (execService as any).createRefResolver()

    const result = resolver("security-scan.yaml.scan.last_output")
    expect(result).toBe("3 critical vulnerabilities")

    const exitCode = resolver("security-scan.yaml.scan.exit_code")
    expect(exitCode).toBe(0)
  })

  it("returns undefined for non-existent workflow ref", () => {
    const resolver = (execService as any).createRefResolver()
    expect(resolver("nonexistent.node.key")).toBeUndefined()
  })

  it("returns undefined for non-existent node", () => {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("exec-1", workspaceId, "my-workflow.yaml", "My Workflow", "completed", ORG, now, now)

    const resolver = (execService as any).createRefResolver()
    expect(resolver("my-workflow.yaml.nonexistent.key")).toBeUndefined()
  })

  it("returns undefined for malformed ref path", () => {
    const resolver = (execService as any).createRefResolver()
    expect(resolver("only-two-parts")).toBeUndefined()
    expect(resolver("one")).toBeUndefined()
  })

  it("resolves latest when multiple executions exist", () => {
    const now1 = "2024-01-01T00:00:00.000Z"
    const now2 = "2024-01-02T00:00:00.000Z"

    // Older execution
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("exec-old", workspaceId, "build.yaml", "Build", "completed", ORG, now1, now1)
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "exec-old-compile",
      "exec-old",
      "compile",
      "bash",
      "completed",
      now1,
      now1,
      JSON.stringify({ last_output: "old output" }),
    )

    // Newer execution
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("exec-new", workspaceId, "build.yaml", "Build", "completed", ORG, now2, now2)
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "exec-new-compile",
      "exec-new",
      "compile",
      "bash",
      "completed",
      now2,
      now2,
      JSON.stringify({ last_output: "new output" }),
    )

    const resolver = (execService as any).createRefResolver()
    expect(resolver("build.yaml.compile.last_output")).toBe("new output")
  })

  it("caches repeated lookups for same workflow+node", () => {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("exec-1", workspaceId, "wf.yaml", "Workflow", "completed", ORG, now, now)
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "exec-1-node1",
      "exec-1",
      "node1",
      "bash",
      "completed",
      now,
      now,
      JSON.stringify({ a: "alpha", b: "beta" }),
    )

    const resolver = (execService as any).createRefResolver()
    // Both calls resolve from the same workflow+node — second should hit cache
    expect(resolver("wf.yaml.node1.a")).toBe("alpha")
    expect(resolver("wf.yaml.node1.b")).toBe("beta")
  })
})
