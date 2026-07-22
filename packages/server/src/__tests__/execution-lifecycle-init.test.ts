import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { execSync } from "child_process"
import { ENGINE_INIT_JSONL } from "../services/execution/EngineInitPhase"
import { ExecutionLifecycle } from "../services/execution/ExecutionLifecycle"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { SSEService } from "../services/sse"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import { ObservabilityService } from "../services/observability"
import { PrivacyFilter } from "../services/privacy-filter"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"

const MINIMAL_WF = `apiVersion: octopus/v1
kind: Workflow
name: test
nodes:
  - id: step1
    type: bash
    bash: echo hello`

let db: Database.Database
let dao: ExecutionDAO
let sse: SSEService
let lifecycle: ExecutionLifecycle
let workspacePath: string
let workspaceId: string
let sseWorkspaceId: string
let dbPath: string

const ORG = "test-org"

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-lifecycle-init-${Date.now()}`)
  fs.mkdirSync(path.join(workspacePath, "workflows"), { recursive: true })
  fs.mkdirSync(path.join(workspacePath, "projects"), { recursive: true })
  fs.writeFileSync(path.join(workspacePath, "workflows", "test.yaml"), MINIMAL_WF)
  fs.writeFileSync(
    path.join(workspacePath, "config.json"),
    JSON.stringify({ name: "test-ws", init_branch_name: "test", repos: [], created: new Date().toISOString() }),
  )

  // Initialize git so recordStartCommits works
  execSync("git init -q", { cwd: workspacePath })
  execSync("git config user.email test@test.com", { cwd: workspacePath })
  execSync("git config user.name Test", { cwd: workspacePath })
  execSync("git add -A && git commit -q -m init", { cwd: workspacePath })

  dbPath = path.join(os.tmpdir(), `test-lifecycle-db-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  workspaceId = randomUUID()
  sseWorkspaceId = `${ORG}:${workspacePath}`
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(workspaceId, "test-ws", ORG, workspacePath, now, now)

  dao = new ExecutionDAO(db)
  sse = new SSEService()
  const wfService = new WorkflowService()
  const builtInWfService = new BuiltInWorkflowService()
  const obs = new ObservabilityService(db, new PrivacyFilter(), dao)

  lifecycle = new ExecutionLifecycle(
    dao, sse, wfService, builtInWfService,
    ORG, workspacePath, workspaceId, sseWorkspaceId, obs,
  )
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  if (fs.existsSync(workspacePath)) fs.rmSync(workspacePath, { recursive: true, force: true })
})

describe("ExecutionLifecycle engine_init integration", () => {
  it("creates __engine_init__.jsonl when start() runs with syncMainBranch=false", async () => {
    const receivedEvents: { event: string }[] = []
    sse.subscribe(sseWorkspaceId, (e) => receivedEvents.push(e))

    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)

    const startPromise = lifecycle.start(exec.id, undefined, { syncMainBranch: false })

    // Wait briefly for engine_init to write its JSONL, then cancel to avoid hanging
    await new Promise(r => setTimeout(r, 500))
    try { await lifecycle.cancel(exec.id) } catch { /* ignore */ }

    try { await startPromise } catch { /* cancel causes rejection */ }

    const jsonlPath = path.join(workspacePath, "logs", exec.id, ENGINE_INIT_JSONL)
    expect(fs.existsSync(jsonlPath)).toBe(true)

    const content = fs.readFileSync(jsonlPath, "utf-8")
    const lines = content.split("\n").filter(l => l.trim())
    expect(lines.length).toBeGreaterThanOrEqual(3)

    const events = lines.map(l => JSON.parse(l))
    expect(events.some((e: any) => e.event === "engine_init_start")).toBe(true)
    expect(events.some((e: any) => e.event === "engine_init_complete")).toBe(true)

    const sseTypes = receivedEvents.map(e => e.event)
    expect(sseTypes).toContain("engine_init_start")
    expect(sseTypes).toContain("engine_init_complete")
  }, 10000)

  it("getAgentEvents includes engine_init events after refresh", async () => {
    const exec = lifecycle.create(workspaceId, { workflow_ref: "test.yaml" }, ORG)

    // Manually write a fake engine_init JSONL to test getAgentEvents
    const logDir = path.join(workspacePath, "logs", exec.id)
    fs.mkdirSync(logDir, { recursive: true })
    const jsonlPath = path.join(logDir, ENGINE_INIT_JSONL)
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ event: "engine_init_start", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ event: "engine_init_complete", timestamp: "2026-01-01T00:00:01.000Z" }),
    ].join("\n") + "\n")

    const events = lifecycle.getAgentEvents(exec.id)
    const initEvents = events.filter((e: any) => e.event?.startsWith("engine_init_"))
    expect(initEvents.length).toBe(2)
    expect(initEvents[0].event).toBe("engine_init_start")
    expect(initEvents[1].event).toBe("engine_init_complete")
  })
})
