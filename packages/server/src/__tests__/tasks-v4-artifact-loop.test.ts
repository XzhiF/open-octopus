// packages/server/src/__tests__/tasks-v4-artifact-loop.test.ts
//
// task-phase-redesign ticket 06 — 产物单向环: seed 下行 / collect 上行 / SSE。
//
// Verifies (real better-sqlite3 + applySchema + REAL WorkspaceService + REAL
// TaskHomeService layout under a fake HOME tmp dir + stubbed ExecutionService
// registry, same harness shape as tasks-v4-ws-reuse.test.ts):
//   AC1: 首触 execute() → ws 内存在 seed 文件且内容=home 版；round2 开跑
//        （dispatchPhaseRound）前改 home spec → ws 反映新内容（home 覆盖 ws 同名）。
//   AC2: 执行侧改 issues Status（终态回调后）home 同名文件更新 + 新报告回流，
//        且 SSE task_artifacts_update 在 taskpool 事件流可收到。
//   AC3: 写权纪律 — 执行侧乱改 ws spec.md，collect 不回流覆盖 home（home 权威）。
//   AC4: ws 目录被 rm -rf 后 home 产物完整（防丢兜底）。
//   底线: v3 envelope（无 format/phases）execute() 不 seed 不 collect。
//
// E2E_AL_ data prefix; all fs assertions under mkdtemp tmp dirs (cleaned).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { applySchema } from "../db/schema"
import {
  ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, WorkspaceDAO, TaskDAO,
} from "../db/dao"
import { SSEService } from "../services/sse"
import { WorkspaceService } from "../services/workspace"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { TasksService } from "../services/tasks/tasks-service"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import type { SchedulerJob, WorkflowConfig } from "@octopus/shared"

const ORG = "e2e-al"

// ── ExecutionService registry stub (ws-reuse 同款) ────────────────────
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-al-exec-${execSeq++}`
    mockHooks.db!
      .prepare(
        `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`,
      )
      .run(id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""), ORG)
    return { id }
  }),
  start: vi.fn(async () => {}),
  registerExternalCallbacks: vi.fn(),
  clearExternalCallbacks: vi.fn(),
}
let execSeq = 0
const mockHooks: { db: Database.Database | null } = { db: null }

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = mockHooks.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    return ws ? { service: stubService, wsPath: ws.path } : undefined
  },
}))

// ── Fixture helpers ───────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  return db
}

let seq = 0
function insertV4Task(db: Database.Database): string {
  const id = `e2e-al-task-${seq++}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, 'running', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)
  `).run(
    id, ORG, `E2E_AL ${id}`,
    JSON.stringify({ format: "v4", task_type: "coding", phases: [] }),
    now, now,
  )
  return id
}

/** Task home per ADR-0011: os.homedir()/.octopus/tasks/{id} — with HOME
 *  pointed at fakeHome, that is fakeHome/.octopus/tasks/{id}. */
function homeFor(taskId: string): string {
  return path.join(fakeHome, ".octopus", "tasks", taskId)
}

function writeBatchDir(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

const DATE = "20260903"

/** home 批次目录: {home}/.scratch/<date>/<slug>/ */
function seedHomeBatch(taskId: string, slug: string, files: Record<string, string>): string {
  const dir = path.join(homeFor(taskId), ".scratch", DATE, slug)
  writeBatchDir(dir, files)
  return dir
}

/** v4 envelope config in exactly ticket 04's materialized shape (absolute
 *  specPath/specDir under the task home). */
function v4EnvelopeConfig(taskId: string): WorkflowConfig {
  const p1Dir = path.join(homeFor(taskId), ".scratch", DATE, "p1")
  const p2Dir = path.join(homeFor(taskId), ".scratch", DATE, "p2")
  return {
    schema_version: "3.0",
    type: "workflow",
    workspace_spec: { org: ORG, branch_prefix: `taskpool-e2e-al-env`, projects: [] },
    workflow_chain: [
      { workflow_ref: "built-in/flow-p1", input_values: { idea: "p1" } },
    ],
    max_retain: 10,
    format: "v4",
    phases: [
      { index: 1, name: "Phase 1", slug: "p1", specPath: path.join(p1Dir, "spec.md"), specDir: p1Dir, workflowRef: "built-in/flow-p1", inputValues: { idea: "p1" } },
      { index: 2, name: "Phase 2", slug: "p2", specPath: path.join(p2Dir, "spec.md"), specDir: p2Dir, workflowRef: "built-in/flow-p2", inputValues: { idea: "p2" } },
    ],
  } as unknown as WorkflowConfig
}

function seedEnvelope(db: Database.Database, taskId: string, config: WorkflowConfig): { scheduleId: string; schedExecId: string } {
  const scheduleId = `e2e-al-sched-${seq++}`
  const schedExecId = `e2e-al-se-${seq++}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
      job_type, config, parallel_policy, status, origin_type, origin_id, origin_role,
      scheduled_at, created_at, updated_at, max_retain)
    VALUES (?, ?, ?, NULL, 'UTC', 1, 'workflow', ?, 'skip', 'running', 'task', ?, 'primary', ?, ?, ?, 10)
  `).run(scheduleId, ORG, `task-${taskId}-primary`, JSON.stringify(config), taskId, now, now, now)
  db.prepare(`
    INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, created_at, triggered_by)
    VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')
  `).run(schedExecId, scheduleId)
  return { scheduleId, schedExecId }
}

function buildJob(scheduleId: string, config: WorkflowConfig): SchedulerJob {
  return {
    id: scheduleId,
    name: `task-${scheduleId}-primary`,
    job_type: "workflow",
    cron_expression: null,
    timezone: "UTC",
    enabled: true,
    org: ORG,
    config,
    parallel_policy: "skip",
    timeout_seconds: 3600,
    notify_on_failure: false,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as SchedulerJob
}

function boundWs(db: Database.Database, taskId: string): { wsId: string; wsPath: string } {
  const { workspace_id: wsId } = db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as
    { workspace_id: string }
  const { path: wsPath } = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
    { path: string }
  return { wsId, wsPath }
}

/** The onComplete callback the last registerExternalCalls capture holds —
 *  invoking it simulates the engine reaching a terminal status. */
function lastOnComplete(): (status?: string) => void {
  return stubService.registerExternalCallbacks.mock.calls.at(-1)![0].onComplete
}

let fakeHome: string
let realHome: string | undefined

describe("ticket 06 — 产物单向环 seed/collect/SSE", () => {
  let db: Database.Database
  let sse: SSEService
  let workspaceService: WorkspaceService
  let executor: WorkflowExecutor
  let artifactsEvents: Array<Record<string, unknown>>

  beforeEach(() => {
    db = newDb()
    mockHooks.db = db
    execSeq = 0
    seq = 0
    vi.clearAllMocks()
    realHome = process.env.HOME
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-al-home-"))
    process.env.HOME = fakeHome
    sse = new SSEService()
    artifactsEvents = []
    sse.subscribe("taskpool", (e) => {
      if (e.event === TASK_ARTIFACTS_UPDATE_EVENT) artifactsEvents.push(e.data as Record<string, unknown>)
    })
    workspaceService = new WorkspaceService(new WorkspaceDAO(db))
    executor = new WorkflowExecutor(
      sse,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      workspaceService,
      undefined,
      new TaskDAO(db),
    )
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    fs.rmSync(fakeHome, { recursive: true, force: true })
    db.close()
  })

  // ── AC1 (part 1) — 首触 execute(): seed home→ws ─────────────────────
  it("AC1: first execute seeds {home}/.scratch/<date>/<slug>/ into the ws verbatim", async () => {
    const taskId = insertV4Task(db)
    const p1 = seedHomeBatch(taskId, "p1", {
      "spec.md": "# spec p1 v1\n",
      "issues/01-x.md": "Status: ready-for-agent\n",
    })
    const config = v4EnvelopeConfig(taskId)
    const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)

    const result = await executor.execute(buildJob(scheduleId, config), schedExecId)
    expect(result.status, `execute failed: ${result.errorMessage}`).not.toBe("failure")

    const { wsPath } = boundWs(db, taskId)
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p1")
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p1 v1\n")
    expect(fs.readFileSync(path.join(wsBatch, "issues/01-x.md"), "utf-8")).toBe("Status: ready-for-agent\n")
    void p1
  })

  it("AC1b: a v3 (non-v4) envelope gets NO seed at all (字节不变底线)", async () => {
    const taskId = insertV4Task(db)
    seedHomeBatch(taskId, "p1", { "spec.md": "# spec p1\n" })
    const config = v4EnvelopeConfig(taskId)
    // v3 shape: no format, no phases
    delete (config as unknown as { format?: string }).format
    delete (config as unknown as { phases?: unknown }).phases
    const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)

    const result = await executor.execute(buildJob(scheduleId, config), schedExecId)
    expect(result.status).not.toBe("failure")

    // v3: no tasks.workspace_id write-back — read the created ws directly.
    const row = db.prepare("SELECT path FROM workspaces ORDER BY rowid DESC LIMIT 1").get() as
      { path: string } | undefined
    expect(row).toBeDefined()
    expect(fs.existsSync(path.join(row!.path, ".scratch"))).toBe(false)
  })

  // ── AC2 (execute path) — 首触终态回调 collect + SSE ──────────────────
  it("AC2: first-round terminal callback collects execution-side changes into home + emits task_artifacts_update", async () => {
    const taskId = insertV4Task(db)
    const p1 = seedHomeBatch(taskId, "p1", {
      "spec.md": "# spec p1\n",
      "issues/01-x.md": "Status: ready-for-agent\n",
    })
    const config = v4EnvelopeConfig(taskId)
    const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)
    await executor.execute(buildJob(scheduleId, config), schedExecId)
    const { wsPath } = boundWs(db, taskId)

    // Simulated execution side: edit the issues status, add a report, and
    // MANGLE spec.md (AC3 bait). Bump mtimes explicitly (+5s) so the ws>home
    // rule is deterministic regardless of clock granularity.
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p1")
    const edited = path.join(wsBatch, "issues/01-x.md")
    fs.writeFileSync(edited, "Status: done\n")
    const st = fs.statSync(edited)
    fs.utimesSync(edited, st.atime, new Date(st.mtimeMs + 5000))
    const report = path.join(wsBatch, "report-r1.md")
    fs.writeFileSync(report, "# round 1 report\n")
    fs.writeFileSync(path.join(wsBatch, "spec.md"), "GARBLED BY EXECUTION\n")

    // Engine terminal → the onComplete registered by execute() finalizes.
    lastOnComplete()("completed")

    expect(fs.readFileSync(path.join(p1, "issues/01-x.md"), "utf-8")).toBe("Status: done\n")
    expect(fs.readFileSync(path.join(p1, "report-r1.md"), "utf-8")).toBe("# round 1 report\n")
    // AC3: spec*.md is home 权威 — the mangling never flows back.
    expect(fs.readFileSync(path.join(p1, "spec.md"), "utf-8")).toBe("# spec p1\n")
    // SSE 上行可收 (taskpool 订阅).
    expect(artifactsEvents.some((d) => d.task_id === taskId)).toBe(true)
    void scheduleId; void schedExecId
  })

  // ── AC1c + AC2/AC3 (dispatch path) — dispatchPhaseRound seed / finalize collect
  it("dispatchPhaseRound seeds the target batch; execution edits collect back at finalize; round-2 re-seed reflects home edits", async () => {
    const taskId = insertV4Task(db)
    seedHomeBatch(taskId, "p1", { "spec.md": "# spec p1\n" })
    const p2 = seedHomeBatch(taskId, "p2", {
      "spec.md": "# spec p2 v1\n",
      "issues/02-y.md": "Status: needs-info\n",
    })
    const config = v4EnvelopeConfig(taskId)
    const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)
    await executor.execute(buildJob(scheduleId, config), schedExecId)
    lastOnComplete()("completed") // release the phase-1 slot

    const service = new TasksService(db, sse)
    const { wsPath } = boundWs(db, taskId)

    // ── round 1 of phase 2: seed puts p2 batch into ws (home 版内容) ──
    await service.dispatchPhaseRound(taskId, 2, 1, "go")
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p2")
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p2 v1\n")
    expect(fs.readFileSync(path.join(wsBatch, "issues/02-y.md"), "utf-8")).toBe("Status: needs-info\n")

    // Execution side: update issues + tamper spec.md in the ws copy.
    const edited = path.join(wsBatch, "issues/02-y.md")
    fs.writeFileSync(edited, "Status: done\n")
    const st = fs.statSync(edited)
    fs.utimesSync(edited, st.atime, new Date(st.mtimeMs + 5000))
    fs.writeFileSync(path.join(wsBatch, "spec.md"), "GARBLED\n")

    // Terminal → finalizePhaseRoundExecution collects.
    lastOnComplete()("completed")
    expect(fs.readFileSync(path.join(p2, "issues/02-y.md"), "utf-8")).toBe("Status: done\n")
    expect(fs.readFileSync(path.join(p2, "spec.md"), "utf-8")).toBe("# spec p2 v1\n") // AC3
    expect(artifactsEvents.some((d) => d.task_id === taskId)).toBe(true) // AC2

    // ── round 2: home spec edited between rounds → next seed 覆盖 ws 同名 ──
    fs.writeFileSync(path.join(p2, "spec.md"), "# spec p2 v2\n")
    await service.dispatchPhaseRound(taskId, 2, 2)
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p2 v2\n")

    // AC4: ws 后续被删 — home 产物完整 (防丢兜底).
    lastOnComplete()("completed")
    fs.rmSync(wsPath, { recursive: true, force: true })
    expect(fs.readFileSync(path.join(p2, "spec.md"), "utf-8")).toBe("# spec p2 v2\n")
    expect(fs.readFileSync(path.join(p2, "issues/02-y.md"), "utf-8")).toBe("Status: done\n")
    void scheduleId; void schedExecId
  })
})
