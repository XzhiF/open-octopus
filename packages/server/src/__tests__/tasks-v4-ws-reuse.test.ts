// packages/server/src/__tests__/tasks-v4-ws-reuse.test.ts
//
// task-phase-redesign ticket 05 — dispatchPhaseRound + same-task workspace reuse.
//
// Verifies (real better-sqlite3 + applySchema + REAL WorkspaceService under a
// fake HOME tmp dir + stubbed ExecutionService registry that mirrors
// lifecycle.create's DB write, R1-R7):
//   AC1: v4 first trigger → createFromSpec + tasks.workspace_id write-back +
//        executions tagged (1,1); 2nd dispatch (dispatchPhaseRound) → workspaces
//        count STILL 1 and the ws DIRECTORY survives untouched (marker file +
//        inode assertions — the anti-rmSync regression tripwire).
//   AC2: a concurrent 2nd dispatch under the same envelope is rejected with an
//        explainable TaskStatusConflictError; the partial unique index
//        idx_sched_execs_unique_active is itself proven to be the structural
//        gate (raw double-insert throws SQLITE_CONSTRAINT).
//   AC3: same-name createFromSpec THROWS (was silent rmSync overwrite — 暗雷#3)
//        and existing contents survive; the `-MMDD-HHmmss` name is a FIRST-
//        BUILD concern only (reuse path creates no new name / no new dir).
//   AC4: enforceRetention skips task-bound workspaces whose task is not 'done'
//        (豁免) and deletes them once done; unbound scheduler ws still deleted.
//   ⑥: abortTask keeps tasks.workspace_id bound (round 打回现场不作废) — a
//        dispatchPhaseRound after abort reuses the SAME ws.
//
// E2E_WR_ data prefix; fs assertions all under mkdtemp tmp HOMEs (cleaned).

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
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
import type { SchedulerJob, WorkflowConfig } from "@octopus/shared"

const ORG = "e2e-wr"

// ── ExecutionService registry stub ────────────────────────────────────
// service.create mirrors ExecutionLifecycle's DB write (inserts an executions
// row) so phase_index/round_index tagging is asserted against the REAL table.
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-wr-exec-${execSeq++}`
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

/** A v4 envelope config in EXACTLY the shape ticket 04's materialize produces
 *  (format + resolved phases[] + workflow_chain[0] = phase 1). projects=[] →
 *  createFromSpec's worktree loop is a no-op (no git fixtures needed). */
function v4EnvelopeConfig(): WorkflowConfig {
  return {
    schema_version: "3.0",
    type: "workflow",
    workspace_spec: { org: ORG, branch_prefix: `taskpool-e2e-wr-env`, projects: [] },
    workflow_chain: [
      { workflow_ref: "built-in/flow-p1", input_values: { idea: "p1", task_artifacts_dir: "/tmp/e2e-wr-artifacts" } },
    ],
    max_retain: 10,
    // intentional unknown keys (ticket 04 survival mechanism — the persisted
    // JSON carries them; the strict schema would strip on re-parse).
    format: "v4",
    phases: [
      { index: 1, name: "Phase 1", slug: "p1", specPath: "/tmp/e2e-wr/spec-p1.md", specDir: "/tmp/e2e-wr", workflowRef: "built-in/flow-p1", inputValues: { idea: "p1", task_artifacts_dir: "/tmp/e2e-wr-artifacts" } },
      { index: 2, name: "Phase 2", slug: "p2", specPath: "/tmp/e2e-wr/spec-p2.md", specDir: "/tmp/e2e-wr", workflowRef: "built-in/flow-p2", inputValues: { idea: "p2", task_artifacts_dir: "/tmp/e2e-wr-artifacts" } },
    ],
  } as unknown as WorkflowConfig
}

let seq = 0
function insertV4Task(db: Database.Database, status = "running"): string {
  const id = `e2e-wr-task-${seq++}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)
  `).run(
    id, ORG, `E2E_WR ${id}`, status,
    JSON.stringify({ format: "v4", task_type: "coding", phases: [{ index: 1, name: "Phase 1", slug: "p1", specPath: "spec-p1.md", workflowRef: "built-in/flow-p1", inputValues: {} }] }),
    now, now,
  )
  return id
}

/** Seed the envelope (parked 'queued' with a due scheduled_at — the state a
 *  claim happens on) + its triggered schedule_executions row. */
function seedEnvelope(db: Database.Database, taskId: string, config: WorkflowConfig): { scheduleId: string; schedExecId: string } {
  const scheduleId = `e2e-wr-sched-${seq++}`
  const schedExecId = `e2e-wr-se-${seq++}`
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

function wsCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM workspaces").get() as { c: number }).c
}

function executionRow(db: Database.Database, workflowRef: string) {
  return db
    .prepare("SELECT * FROM executions WHERE workflow_ref = ? ORDER BY rowid DESC LIMIT 1")
    .get(workflowRef) as { id: string; phase_index: number | null; round_index: number | null; workspace_id: string } | undefined
}

describe("ticket 05 — v4 workspace reuse + dispatchPhaseRound", () => {
  let db: Database.Database
  let fakeHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined
  let workspaceService: WorkspaceService
  let executor: WorkflowExecutor
  let sse: SSEService

  beforeEach(() => {
    db = newDb()
    mockHooks.db = db
    execSeq = 0
    vi.clearAllMocks()
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-wr-home-"))
    // Fake BOTH env vars: os.homedir() reads $HOME on POSIX but %USERPROFILE%
    // on Windows — without the latter the REAL user home was used here, the
    // root cause of the Windows baseline-red (colon ENOENT + same-second name
    // collisions against the real workspaces dir).
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    sse = new SSEService()
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
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(fakeHome, { recursive: true, force: true })
    db.close()
  })

  /** Run phase 1 through the REAL claim-path executor, then simulate the
   *  terminal finalize (handleChainComplete equivalent) so the active slot
   *  releases — the state ticket 07 sees when it calls dispatchPhaseRound. */
  async function firstPhaseCompleted(): Promise<{
    service: TasksService; taskId: string; scheduleId: string; boundWsId: string; wsPath: string
  }> {
    const service = new TasksService(db, sse)
    const taskId = insertV4Task(db)
    const config = v4EnvelopeConfig()
    const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)
    await executor.execute(buildJob(scheduleId, config), schedExecId)
    db.prepare("UPDATE schedule_executions SET status = 'completed' WHERE id = ?").run(schedExecId)
    db.prepare("UPDATE schedules SET status = 'done' WHERE id = ?").run(scheduleId)
    const { workspace_id: boundWsId } = db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as
      { workspace_id: string }
    const { path: wsPath } = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(boundWsId) as
      { path: string }
    return { service, taskId, scheduleId, boundWsId, wsPath }
  }

  // ── AC3 — same-name dir is an ERROR, not a silent rmSync rebuild ─────
  describe("AC3: createFromSpec same-name conflict", () => {
    function specInput(name: string) {
      return {
        org: ORG,
        name,
        projects: [],
        branch_prefix: "taskpool-x",
        branch_suffix: "bs1",
        source: "scheduler" as const,
        source_schedule_id: "s-conflict",
        workflow_chain: [],
      }
    }

    it("throws on an existing same-name dir and PRESERVES its contents", () => {
      const ws = workspaceService.createFromSpec(specInput("task:dup-0902-010000"))
      const marker = path.join(ws.path, "fix-feedback-r1.md")
      fs.writeFileSync(marker, "round-1 evidence")

      expect(() => workspaceService.createFromSpec(specInput("task:dup-0902-010000"))).toThrow(
        /already exists/i,
      )
      // The old rmSync path would have wiped this file.
      expect(fs.readFileSync(marker, "utf-8")).toBe("round-1 evidence")
      // No second DB row for the refused creation.
      expect(wsCount(db)).toBe(1)
    })
  })

  // ── AC1 (part 1) — execute(): first run creates+binds+tags, 2nd run reuses ──
  describe("AC1: WorkflowExecutor.execute v4 ws bind / reuse", () => {
    it("first trigger: createFromSpec + tasks.workspace_id write-back + executions tagged (1,1)", () => {
      const taskId = insertV4Task(db)
      const config = v4EnvelopeConfig()
      const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)

      const spy = vi.spyOn(workspaceService, "createFromSpec")
      return executor.execute(buildJob(scheduleId, config), schedExecId).then((result) => {
        expect(result.status, `execute failed: ${result.errorMessage}`).not.toBe("failure")
        expect(spy).toHaveBeenCalledTimes(1)
        expect(wsCount(db)).toBe(1)

        // tasks.workspace_id binding (系统事件写法 — version 不 bump).
        const task = db.prepare("SELECT workspace_id, version FROM tasks WHERE id = ?").get(taskId) as
          { workspace_id: string | null; version: number }
        expect(task.workspace_id).toBeTruthy()
        expect(task.version).toBe(1)

        // ws 名 = task:{标题}-{MMDD-HHmmss}（首建拼名），目录真实落盘。
        const ws = db.prepare("SELECT name, path FROM workspaces WHERE id = ?").get(task.workspace_id!) as
          { name: string; path: string }
        expect(ws.name).toMatch(/^task:E2E_WR .+-\d{4}-\d{6}$/)
        expect(fs.existsSync(ws.path)).toBe(true)
        expect(ws.path.startsWith(fakeHome)).toBe(true)

        // 首执行打标 (1,1)。
        const exec = executionRow(db, "built-in/flow-p1")
        expect(exec).toBeDefined()
        expect(exec!.phase_index).toBe(1)
        expect(exec!.round_index).toBe(1)
        expect(exec!.workspace_id).toBe(task.workspace_id)
      })
    })

    it("re-claim with tasks.workspace_id set: NO second createFromSpec — same ws, round bumps", async () => {
      const taskId = insertV4Task(db)
      const config = v4EnvelopeConfig()
      const { scheduleId, schedExecId } = seedEnvelope(db, taskId, config)
      await executor.execute(buildJob(scheduleId, config), schedExecId)
      const boundId = (db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as
        { workspace_id: string }).workspace_id!
      const wsPath = (db.prepare("SELECT path FROM workspaces WHERE id = ?").get(boundId) as
        { path: string }).path

      // A marker file + the dir inode — the rmSync-regression tripwire.
      const marker = path.join(wsPath, "round1-report.md")
      fs.writeFileSync(marker, "phase 1 evidence")
      const inoBefore = fs.statSync(wsPath).ino

      const spy = vi.spyOn(workspaceService, "createFromSpec")
      // Simulate the crash-recovery re-claim: envelope back to running + a NEW
      // active schedule_executions slot (the previous one released).
      db.prepare("UPDATE schedule_executions SET status = 'completed' WHERE id = ?").run(schedExecId)
      const { schedExecId: se2 } = seedEnvelopeActive(db, scheduleId)

      const result = await executor.execute(buildJob(scheduleId, config), se2)
      expect(result.status).not.toBe("failure")
      expect(spy).not.toHaveBeenCalled()
      expect(wsCount(db)).toBe(1)
      // 目录未被重建 — 同 inode、marker 存活。
      expect(fs.statSync(wsPath).ino).toBe(inoBefore)
      expect(fs.readFileSync(marker, "utf-8")).toBe("phase 1 evidence")
      // 复用执行仍绑同一 ws，round 递增 → (1,2)。
      const exec = executionRow(db, "built-in/flow-p1")
      expect(exec!.workspace_id).toBe(boundId)
      expect(exec!.phase_index).toBe(1)
      expect(exec!.round_index).toBe(2)
    })
  })

  // ── AC1 (part 2) + AC2 — dispatchPhaseRound on the bound ws ──────────
  describe("AC1/AC2: dispatchPhaseRound — same envelope, same ws, tagged round", () => {
    it("dispatches phase 2 on the BOUND ws: ws count=1, dir untouched, row tagged (2,1)", async () => {
      const { service, taskId, scheduleId, boundWsId, wsPath } = await firstPhaseCompleted()
      const marker = path.join(wsPath, "phase1-report.md")
      fs.writeFileSync(marker, "keep me")
      const inoBefore = fs.statSync(wsPath).ino
      const spy = vi.spyOn(workspaceService, "createFromSpec")

      const res = await service.dispatchPhaseRound(taskId, 2, 1, "fix the login redirect")

      expect(res.workspaceId).toBe(boundWsId)
      expect(spy).not.toHaveBeenCalled()
      expect(wsCount(db)).toBe(1)
      expect(fs.statSync(wsPath).ino).toBe(inoBefore)
      expect(fs.readFileSync(marker, "utf-8")).toBe("keep me")

      // service.create ran on the BOUND ws with the phase-2 ref + feedback +
      // recovery stamps (management keys).
      const createCall = stubService.create.mock.calls.at(-1)!
      expect(createCall[0]).toBe(boundWsId)
      const iv = createCall[1].input_values as Record<string, string>
      expect(createCall[1].workflow_ref).toBe("built-in/flow-p2")
      expect(iv.feedback).toBe("fix the login redirect")
      expect(iv._phase_index).toBe("2")
      expect(iv._round_index).toBe("1")

      // executions row tagged (2,1), on the same ws.
      const exec = executionRow(db, "built-in/flow-p2")
      expect(exec).toBeDefined()
      expect(exec!.phase_index).toBe(2)
      expect(exec!.round_index).toBe(1)
      expect(exec!.workspace_id).toBe(boundWsId)
      expect(res.executionId).toBe(exec!.id)

      // Envelope REUSED (K5 — no second schedule row): count stays 1, chain[0]
      // points at phase 2, phases[] intact, status back in-flight.
      const env = db.prepare("SELECT status, config FROM schedules WHERE id = ?").get(scheduleId) as
        { status: string; config: string }
      const envConfig = JSON.parse(env.config)
      expect(envConfig.workflow_chain[0].workflow_ref).toBe("built-in/flow-p2")
      expect(envConfig.phases).toHaveLength(2)
      expect(env.status).toBe("claimed")

      // Second active slot row + ws association + link.
      const seRows = db.prepare("SELECT * FROM schedule_executions WHERE schedule_id = ? ORDER BY rowid").all(scheduleId) as
        Array<{ status: string; execution_id: string | null; workspace_id: string | null }>
      expect(seRows).toHaveLength(2)
      expect(seRows[1].execution_id).toBe(exec!.id)
      expect(seRows[1].workspace_id).toBe(boundWsId)
      const sws = db.prepare("SELECT workspace_id, status FROM schedule_workspaces WHERE schedule_id = ?").all(scheduleId) as
        Array<{ workspace_id: string; status: string }>
      expect(sws.at(-1)!.workspace_id).toBe(boundWsId)

      // Terminal callback → slot releases, envelope back to done.
      const cbCall = stubService.registerExternalCallbacks.mock.calls.at(-1)!
      cbCall[0].onComplete("completed")
      const seFinal = db.prepare("SELECT status FROM schedule_executions WHERE schedule_id = ? ORDER BY rowid DESC LIMIT 1").get(scheduleId) as
        { status: string }
      expect(seFinal.status).toBe("completed")
      expect((db.prepare("SELECT status FROM schedules WHERE id = ?").get(scheduleId) as { status: string }).status).toBe("done")

      // Round 2 of the same phase now dispatches cleanly → tagged (2,2).
      const res2 = await service.dispatchPhaseRound(taskId, 2, 2)
      expect(res2.workspaceId).toBe(boundWsId)
      expect(wsCount(db)).toBe(1)
      const exec2 = executionRow(db, "built-in/flow-p2")
      expect(exec2!.phase_index).toBe(2)
      expect(exec2!.round_index).toBe(2)
    })

    it("AC2: concurrent second dispatch under the same envelope → explainable conflict; the unique index itself rejects the raw insert too", async () => {
      const { service, taskId, scheduleId } = await firstPhaseCompleted()
      await service.dispatchPhaseRound(taskId, 2, 1)
      // Still active (running slot) — a parallel second dispatch must be refused
      // with an explainable error, not silently queue behind.
      await expect(service.dispatchPhaseRound(taskId, 2, 2)).rejects.toThrow(TaskStatusConflictError)
      await expect(service.dispatchPhaseRound(taskId, 2, 2)).rejects.toThrow(/进行中|active/i)
      expect(wsCount(db)).toBe(1)
      // No slot leaked from the refused attempts.
      expect((db.prepare("SELECT COUNT(*) c FROM schedule_executions WHERE schedule_id=? AND status IN ('triggered','running')").get(scheduleId) as { c: number }).c).toBe(1)

      // The structural backstop: idx_sched_execs_unique_active (schedule_id
      // WHERE status IN ('triggered','running')) — a raw double-insert collides.
      const runDAO = new ScheduleRunDAO(db)
      expect(() =>
        runDAO.insertTriggeredExecution(`e2e-wr-se-${seq++}`, scheduleId, "scheduled", new Date().toISOString(), "+00:00", "UTC", "scheduler"),
      ).toThrow(/UNIQUE|constraint/i)
    })

    it("guards: unbound task (no ws yet) / unknown phase index → explainable errors", async () => {
      const service = new TasksService(db, sse)
      const taskId = insertV4Task(db)
      const config = v4EnvelopeConfig()
      const { scheduleId } = seedEnvelope(db, taskId, config)
      // Never triggered → no ws binding.
      await expect(service.dispatchPhaseRound(taskId, 1, 1)).rejects.toThrow(/workspace/)
      // Bind manually to reach the phase lookup.
      db.prepare("UPDATE tasks SET workspace_id = 'ws-ghost' WHERE id = ?").run(taskId)
      await expect(service.dispatchPhaseRound(taskId, 3, 1)).rejects.toThrow(/phase 3/)
      void scheduleId
    })
  })

  // ── AC4 — enforceRetention exempts not-yet-done task workspaces ──────
  describe("AC4: retention exemption for task-origin ws", () => {
    function seedSchedulerWs(id: string, name: string): string {
      const p = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", name)
      fs.mkdirSync(p, { recursive: true })
      db.prepare(
        "INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', datetime('now'), datetime('now'))",
      ).run(id, name, ORG, p)
      return p
    }
    function seedCompletedAssoc(scheduleId: string, wsId: string): void {
      db.prepare(
        "INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at) VALUES (?, ?, ?, 'completed', 'bs', datetime('now'))",
      ).run(`sws-${wsId}-${seq++}`, scheduleId, wsId)
    }
    function wsExists(id: string): boolean {
      return !!db.prepare("SELECT id FROM workspaces WHERE id = ?").get(id)
    }

    it("skips a task-bound ws while the task is not done; deletes it once done; unbound ws always deleted", () => {
      const taskId = insertV4Task(db, "awaiting_review")
      // NOTE: name doubles as the dir name here (test seeds the fs directly) —
      // no `:` (illegal on Windows); the retention logic keys off the DB row.
      seedSchedulerWs("ws-bound", "task-bound-ws")
      seedSchedulerWs("ws-free", "taskpool-free-ws")
      db.prepare("UPDATE tasks SET workspace_id = 'ws-bound' WHERE id = ?").run(taskId)
      seedEnvelope(db, taskId, v4EnvelopeConfig())
      const scheduleId = (db.prepare("SELECT id FROM schedules WHERE origin_id = ?").get(taskId) as { id: string }).id
      seedCompletedAssoc(scheduleId, "ws-bound")
      seedCompletedAssoc(scheduleId, "ws-free")

      // maxRetain=0 → every completed association is an eviction candidate.
      ;(executor as unknown as { enforceRetention(id: string, max: number): void }).enforceRetention(scheduleId, 0)

      expect(wsExists("ws-free")).toBe(false)     // unbound scheduler ws → reclaimed
      expect(wsExists("ws-bound")).toBe(true)     // task-bound + not done → EXEMPT (K12)

      // done (archived) lifts the exemption — the next sweep reclaims it.
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId)
      ;(executor as unknown as { enforceRetention(id: string, max: number): void }).enforceRetention(scheduleId, 0)
      expect(wsExists("ws-bound")).toBe(false)
    })
  })

  // ── ⑥ — abort keeps the scene: binding + ws survive, dispatch reuses ──
  describe("⑥ abortTask × ws reuse semantics", () => {
    it("abort releases the slot but KEEPS the binding; the next dispatch runs on the same ws", async () => {
      const { service, taskId, scheduleId, boundWsId, wsPath } = await firstPhaseCompleted()
      await service.dispatchPhaseRound(taskId, 2, 1)
      const marker = path.join(wsPath, "half-done-work.md")
      fs.writeFileSync(marker, "round scene")

      service.abortTask(taskId)

      // Binding + ws row + files SURVIVE the abort (round 打回现场不作废).
      const task = db.prepare("SELECT workspace_id, status FROM tasks WHERE id = ?").get(taskId) as
        { workspace_id: string | null; status: string }
      expect(task.workspace_id).toBe(boundWsId)
      expect(task.status).toBe("aborted")
      expect(fs.readFileSync(marker, "utf-8")).toBe("round scene")
      // The in-flight slot is released (abortChildSchedule → markStaleExecutionsFailed).
      expect(
        (db.prepare("SELECT COUNT(*) c FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered','running')").get(scheduleId) as { c: number }).c,
      ).toBe(0)
      // 'cleaned' now means "association slot closed" — NOT "workspace gone":
      // the schedule_workspaces row exists with the ws still resolvable.
      const assoc = db.prepare(
        "SELECT status, workspace_id FROM schedule_workspaces WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1",
      ).get(scheduleId) as { status: string; workspace_id: string }
      expect(assoc.workspace_id).toBe(boundWsId)

      // And the mechanism-level promise: a fresh dispatch reuses the SAME ws.
      const res = await service.dispatchPhaseRound(taskId, 2, 2)
      expect(res.workspaceId).toBe(boundWsId)
      expect(wsCount(db)).toBe(1)
      expect(fs.readFileSync(marker, "utf-8")).toBe("round scene")
    })
  })
})

/** Insert an extra ACTIVE schedule_executions slot for an existing envelope. */
function seedEnvelopeActive(db: Database.Database, scheduleId: string): { schedExecId: string } {
  const schedExecId = `e2e-wr-se-${seq++}`
  db.prepare(`
    INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
      timezone_offset, timezone_iana, created_at, triggered_by)
    VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')
  `).run(schedExecId, scheduleId)
  return { schedExecId }
}
