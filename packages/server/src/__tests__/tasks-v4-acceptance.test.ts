// packages/server/src/__tests__/tasks-v4-acceptance.test.ts
//
// task-phase-redesign ticket 07 — the acceptance API (通过/打回/auto_advance/入
// archiving) + the derived view on GET /:id + the `phases` spec-field.
//
// 票03 (ADR-0021 task-scheduler-decouple) rewrote this file's read model: a v4 round
// IS an `executions` row (task_id + parent_id='0' + phase_index/round_index), read
// directly by deriveTaskView. There is no `schedules` envelope any more — no parked
// definition row, no schedule_executions slot, no config to rewrite per round, and no
// status listener mirroring a schedule onto tasks.status. The fixture therefore lays
// rounds down as executions rows, and the launch assertions read the row the run
// actually ate (same harness family as tasks-v4-handoff-injection.test.ts, which was
// converted first — the stub here writes REAL rows so the latch/claim scan/derive all
// see what is really stored).
//
// Verifies (real better-sqlite3 + applySchema + real tmp task homes + a stubbed
// ExecutionService registry that writes real executions rows, R1-R7):
//   AC1: accepted mid-phase → ledger row appended (decision=accepted, feedback
//        NULL) + next_action='dispatched' + the NEXT phase's round 1 dispatches
//        on the bound ws (round row tagged (i+1,1)); accepted on the LAST
//        phase → next_action='archiving', persisted status 'archiving', the
//        票 08 hook fires, and NO execution is dispatched.
//   AC2: autoAdvance=false → accepted records the decision but does NOT start
//        anything; next_action='awaiting_manual_trigger'.
//   AC3: rejected → feedback artefact `{home}/.scratch/<date>/<slug>/
//        fix-feedback-r{N}.md` + round N+1 dispatches on the SAME phase
//        (round = ledger rejected-count + 1) + the ledger stays traceable
//        (one row per decision, append-only).
//   AC4: 409 when the derived phase status is not awaiting_review / the round
//        is not the awaiting one / the round was already decided / a non-v4
//        task; 404 unknown task; 400 malformed body (incl. rejected without
//        feedback). A persisted status the human-gated flow legitimately leaves
//        behind (a card parked at 'ready' while its round waits for review — the
//        lifecycle job mirrors the launch, and K3 forbids it mirroring a v4
//        round's ending) must NOT block acceptance.
//   AC5: spec-field field=phases (whole-array PUT, version bump, SSE).
//   + GET /:id embeds deriveTaskView's output as `derived`.
//
// E2E_AC_ data prefix; fs assertions under mkdtemp tmp HOME (cleaned after).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { WorkspaceService } from "../services/workspace"
import { createTasksRoutes } from "../routes/tasks"
import { PHASE_STATUS_UPDATE_EVENT, TASK_STATUS_EVENT } from "@octopus/shared"
import { ExecutionDAO, WorkspaceDAO } from "../db/dao"

const ORG = "e2e-ac"
const BATCH_DATE = "20260903"

/** The refs this suite's fixtures bind phases to. armTask re-materializes the launch
 *  plan from task_spec + home on EVERY round (票03), so a v4 dispatch now has to be
 *  able to resolve its phase refs — hence a stub with a deliberate whitelist: the
 *  AC5 gate case binds `built-in/task-dev`, which must stay unresolvable. */
const KNOWN_REFS = new Set([
  "built-in/flow-p1",
  "built-in/flow-p2",
  "built-in/flow-p3",
  "built-in/task-fix",
])
const builtInStub = {
  get: (ref: string) =>
    KNOWN_REFS.has(ref) ? { ref, content: "name: demo\nnodes: []\n", name: "demo" } : null,
} as never

// ── ExecutionService registry stub (mirrors tasks-v4-handoff-injection.test.ts) ──
// create() lands a REAL armed root row: ux_exec_task_active, the job's claim scan and
// deriveView all read what is actually stored, not what this stub pretends.
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-ac-exec-${execSeq++}`
    mockHooks.db!
      .prepare(
        `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
           status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
         VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?, ?, ?)`,
      )
      .run(
        id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
        JSON.stringify(input.input_values ?? {}), ORG,
        input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
      )
    return { id }
  }),
  start: vi.fn(async (id: string) => {
    mockHooks.db!
      .prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?")
      .run(id)
  }),
  registerExternalCallbacks: vi.fn((hooks: { onComplete?: (s?: string) => void }, execId: string) => {
    capturedCallbacks.set(execId, hooks.onComplete ?? null)
  }),
  clearExternalCallbacks: vi.fn(),
  cancel: vi.fn((id: string) => ({ id })),
  hasLiveEngine: () => false,
}
let execSeq = 0
const capturedCallbacks = new Map<string, ((s?: string) => void) | null>()
const mockHooks: { db: Database.Database | null } = { db: null }

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = mockHooks.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    return ws ? { service: stubService, wsPath: ws.path } : undefined
  },
}))

// ── Fixture helpers ──────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  return db
}

interface PhaseDef {
  index: number
  name: string
  slug: string
  workflowRef: string
}

const TWO_PHASES: PhaseDef[] = [
  { index: 1, name: "Phase 1", slug: "p1", workflowRef: "built-in/flow-p1" },
  { index: 2, name: "Phase 2", slug: "p2", workflowRef: "built-in/flow-p2" },
]

/** home-relative batch dir of a phase (K10: `.scratch/<date>/<slug>/`). */
function batchRel(slug: string): string {
  return path.join(".scratch", BATCH_DATE, slug)
}

let taskSeq = 0

/**
 * Build a v4 task parked in 「待验收」: task home with the phase batch dirs +
 * spec files, a bound workspace row (real dir), and ONE terminal round-1 execution
 * tagged (1,1) on that task. deriveTaskView then reports phase 1 = awaiting_review /
 * awaitingRound = 1.
 *
 * 票03: that row IS the whole read model — there is no envelope to park (the active
 * slot releases itself once the row goes terminal) and no schedule_executions to
 * bridge through. The batch spec.md files must exist on disk because armTask re-checks
 * the v4 contract on every round it starts.
 */
function seedAwaitingReview(opts: {
  phases?: PhaseDef[]
  autoAdvance?: boolean
  /** Persisted tasks.status — 'running' is what the lifecycle job leaves between
   *  rounds (it mirrors the launch, never a v4 round's ending); 'ready' is where a
   *  human gate parks the card; 'done'/'archiving' only ever come from the archiver. */
  status?: string
  /** Extra ledger rows to pre-insert (round/replay scenarios). */
  ledger?: Array<{ phase_index: number; round_index: number; decision: string; feedback?: string }>
  /** Rounds to lay down for phase 1 (default 1 terminal round). */
  rounds?: Array<{ round: number; status: string }>
} = {}) {
  const db = mockHooks.db!
  const phases = opts.phases ?? TWO_PHASES
  const taskId = `e2e-ac-task-${taskSeq++}`
  const now = new Date().toISOString()

  // home + batch dirs (the 票 04 gate would have resolved these; we place them
  // directly so the fix-feedback artifact assertion has a real target).
  const home = taskHome.homePath(taskId)
  const specDirs = new Map<number, string>()
  for (const p of phases) {
    const dir = path.join(home, batchRel(p.slug))
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, `spec.md`), `# ${p.name} scope\n`)
    specDirs.set(p.index, dir)
  }

  // workspace row + dir (armTask reuses the bound ws; K4 one ws per task).
  const workspaceId = `e2e-ac-ws-${taskSeq}`
  const wsPath = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", `${taskId}-ws`)
  fs.mkdirSync(wsPath, { recursive: true })
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'task', 'active', ?, datetime('now'), datetime('now'))",
  ).run(workspaceId, `task:${taskId}`, ORG, wsPath, taskId)

  const spec = {
    format: "v4",
    task_type: "coding",
    skill_groups: [],
    ...(opts.autoAdvance === undefined ? {} : { autoAdvance: opts.autoAdvance }),
    phases: phases.map((p) => ({
      index: p.index,
      name: p.name,
      slug: p.slug,
      specPath: path.join(batchRel(p.slug), "spec.md"),
      workflowRef: p.workflowRef,
      inputValues: {},
    })),
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_AC ${taskId}`, opts.status ?? "running", JSON.stringify(spec), now, now, workspaceId)

  // round executions — 票03 起这就是全部的读模型：task_id 直连 + parent_id='0' +
  // 轮次坐标在列上（deriveView/账本/历史都读它，不再有 join 桥）。
  const rounds = opts.rounds ?? [{ round: 1, status: "completed" }]
  const execIds: string[] = []
  for (const r of rounds) {
    const execId = `e2e-ac-exec-seeded-${taskSeq}-${r.round}`
    execIds.push(execId)
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index, completed_at)
       VALUES (?, ?, '0', 0, ?, ?, ?, '{}', '{}', ?, datetime('now'), datetime('now'), ?, 1, ?, datetime('now'))`,
    ).run(
      execId, workspaceId, phases[0].workflowRef, phases[0].workflowRef,
      r.status, ORG, taskId, r.round,
    )
  }

  for (const row of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(`e2e-ac-acc-${taskSeq}-${row.phase_index}-${row.round_index}`, taskId, row.phase_index, row.round_index, row.decision, row.feedback ?? null)
  }

  return { db, taskId, workspaceId, wsPath, home, specDirs, execIds }
}

function ledgerRows(db: Database.Database, taskId: string) {
  return db
    .prepare("SELECT phase_index, round_index, decision, feedback FROM task_phase_acceptances WHERE task_id = ? ORDER BY phase_index, round_index, id")
    .all(taskId) as Array<{ phase_index: number; round_index: number; decision: string; feedback: string | null }>
}

function taskRow(db: Database.Database, taskId: string) {
  return db.prepare("SELECT status, workspace_id, version, completed_at FROM tasks WHERE id = ?").get(taskId) as
    { status: string; workspace_id: string | null; version: number; completed_at: string | null }
}

/** The row the run actually ate — replaces reading the envelope's materialized
 *  chain[0]/config (票03: the launch plan is derived per arm, the coordinates and the
 *  input_values live ON the round's own row). */
function launchedRow(taskId: string) {
  const row = new ExecutionDAO(mockHooks.db!).findLatestTaskRoot(taskId)
  if (!row) throw new Error(`no launch row for ${taskId}`)
  return row
}

function launchedIV(taskId: string): Record<string, string> {
  return JSON.parse(launchedRow(taskId).input_values) as Record<string, string>
}

function specPhasesOf(taskId: string): Array<Record<string, unknown>> {
  const { task_spec } = mockHooks.db!
    .prepare("SELECT task_spec FROM tasks WHERE id = ?")
    .get(taskId) as { task_spec: string }
  return (JSON.parse(task_spec) as { phases: Array<Record<string, unknown>> }).phases
}

function phaseOf(view: { phaseViews: Array<{ index: number }> }, index: number) {
  const p = view.phaseViews.find((x) => x.index === index)
  if (!p) throw new Error(`phase ${index} missing from derived view`)
  return p as unknown as {
    index: number
    status: string
    currentRound: number | null
    acceptedRound: number | null
    awaitingRound: number | null
    rounds: Array<{ roundIndex: number; state: string; decision: string | null; exec: { id: string } }>
  }
}

/** Fire a dispatched round's terminal callback (what the engine would do). The row's
 *  terminal status is written by the lifecycle job (finalizeLaunch → setLaunchStatus),
 *  so the fixture verifies it instead of UPDATE-ing it by hand — a hand-written status
 *  would hide a broken finalize the same way the deleted listener used to. */
function completeDispatchedRound(execId: string, status = "completed"): void {
  const cb = capturedCallbacks.get(execId)
  expect(cb, `no terminal callback captured for ${execId}`).toBeTruthy()
  cb!(status)
  const row = mockHooks.db!
    .prepare("SELECT status FROM executions WHERE id = ?")
    .get(execId) as { status: string }
  expect(row.status, `finalizeLaunch did not land '${status}' on ${execId}`).toBe(status)
}

// ── Suite ────────────────────────────────────────────────────────────

let db: Database.Database
let sse: SSEService
let service: TasksService
let app: Hono
let taskHome: TaskHomeService
let fakeHome: string
let realHome: string | undefined
let realUserProfile: string | undefined
let sseEvents: Array<{ event: string; data: Record<string, unknown> }>

function postAcceptance(taskId: string, body: Record<string, unknown>) {
  return app.request(`/api/tasks/${taskId}/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function sseOf(event: string) {
  return sseEvents.filter((e) => e.event === event)
}

beforeEach(() => {
  db = newDb()
  mockHooks.db = db
  execSeq = 0
  taskSeq = 0
  capturedCallbacks.clear()
  vi.clearAllMocks()
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ac-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome // os.homedir() on Windows reads USERPROFILE
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  sse = new SSEService()
  sseEvents = []
  sse.subscribe("taskpool", (e) => sseEvents.push({ event: e.event, data: e.data as Record<string, unknown> }))
  // 票03: dispatching a round goes through the task-lifecycle job, which resolves each
  // phase's ref (contract re-check) and prepares the workspace — both need wiring the
  // pre-票03 fixture could dodge by rewriting an envelope.
  service = new TasksService(
    db, sse, undefined, taskHome, undefined, builtInStub, null,
    new WorkspaceService(new WorkspaceDAO(db)),
  )
  app = new Hono().route("/api/tasks", createTasksRoutes(service, sse))
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(fakeHome, { recursive: true, force: true })
  db.close()
})

describe("AC1 — accepted: ledger + advance", () => {
  it("mid-phase accepted appends the ledger row and dispatches phase i+1 round 1 on the bound ws", async () => {
    const { taskId, workspaceId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as {
      next_action: string
      dispatch?: Record<string, unknown>
      task: { derived: { taskStatus: string; isV4: boolean; phaseViews: unknown[] } }
    }

    // 账本一行 (append-only, feedback NULL for accepted).
    expect(ledgerRows(db, taskId)).toEqual([
      { phase_index: 1, round_index: 1, decision: "accepted", feedback: null },
    ])

    // next_action=dispatched(next_phase)
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch).toMatchObject({ phase_index: 2, round_index: 1 })

    // 真实派发落在同一 ws：executions tagged (2,1) + create() 带 phase-2 ref。
    const createCall = stubService.create.mock.calls.at(-1)!
    expect(createCall[0]).toBe(workspaceId)
    expect(createCall[1].workflow_ref).toBe("built-in/flow-p2")
    const tagged = db
      .prepare("SELECT phase_index, round_index, workspace_id, status, task_id FROM executions WHERE phase_index = 2")
      .all() as Array<{ phase_index: number; round_index: number; workspace_id: string; status: string; task_id: string }>
    expect(tagged).toHaveLength(1)
    expect(tagged[0].round_index).toBe(1)
    expect(tagged[0].workspace_id).toBe(workspaceId)
    // 票03: the row belongs to the TASK, not to an envelope — that column is what
    // deriveView and the one-instance latch key on.
    expect(tagged[0].task_id).toBe(taskId)

    // 返回体嵌派生视图：phase1 accepted / phase2 running。
    expect(body.task.derived.isV4).toBe(true)
    expect(phaseOf(body.task.derived as never, 1).status).toBe("accepted")
    expect(phaseOf(body.task.derived as never, 1).acceptedRound).toBe(1)
    expect(phaseOf(body.task.derived as never, 2).status).toBe("running")
  })

  it("emits phase_status_update at the acceptance-caused transitions and keeps the task dispatchable", async () => {
    // The world 票03 actually leaves behind: a card parked at 'ready' by the human gate
    // (autoAdvance=false, or an accepted phase whose dispatch failed) while phase 1's
    // round sits terminal-and-unreviewed. The status the old SG2 listener produced by
    // mirroring the FIRST round's ending no longer exists — but the same regression is
    // still worth pinning: the gate is derive-based, so the stale row must not stop the
    // decision, and after it acceptance has to realign the row with what the human just
    // authorized — otherwise abortTask (ready/running only) would 409 a task that IS
    // running.
    const { taskId } = seedAwaitingReview({ status: "ready" })
    await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })

    expect(sseOf(PHASE_STATUS_UPDATE_EVENT)).toEqual([
      { event: PHASE_STATUS_UPDATE_EVENT, data: { task_id: taskId, phase_index: 1, status: "accepted", round_index: 1 } },
      { event: PHASE_STATUS_UPDATE_EVENT, data: { task_id: taskId, phase_index: 2, status: "running", round_index: 1 } },
    ])
    // A round is in flight again → the persisted status mirrors that (abortTask
    // must stay legal: it only accepts ready/running).
    expect(taskRow(db, taskId).status).toBe("running")
    expect(sseOf(TASK_STATUS_EVENT).at(-1)).toMatchObject({ data: { status: "running" } })
    expect(() => service.abortTask(taskId)).not.toThrow()
    expect(taskRow(db, taskId).status).toBe("aborted")
  })

  it("last-phase accepted → persisted archiving + 票 08 hook, no dispatch, no auto-done", async () => {
    let hookTaskId: string | null = null
    service.setArchivingHook((id) => { hookTaskId = id })
    const { taskId } = seedAwaitingReview({ phases: [TWO_PHASES[0]] })

    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { next_action: string; task: { derived: { taskStatus: string } } }

    expect(body.next_action).toBe("archiving")
    expect(stubService.create).not.toHaveBeenCalled()
    const row = taskRow(db, taskId)
    expect(row.status).toBe("archiving")
    // archiving is NOT terminal — completed_at stays NULL (done is 票 08's writer).
    expect(row.completed_at).toBeNull()
    expect(hookTaskId).toBe(taskId)
    expect(body.task.derived.taskStatus).toBe("archiving")
    expect(sseOf(PHASE_STATUS_UPDATE_EVENT)).toEqual([
      { event: PHASE_STATUS_UPDATE_EVENT, data: { task_id: taskId, phase_index: 1, status: "accepted", round_index: 1 } },
    ])
    expect(sseOf(TASK_STATUS_EVENT).at(-1)).toMatchObject({ data: { status: "archiving" } })
    // Ledger still exactly one row.
    expect(ledgerRows(db, taskId)).toHaveLength(1)
    // 票03: enqueueing/accepting never touches the scheduler's tables — a task has no
    // definition row of its own any more.
    expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)
  })
})

describe("AC3 — rejected: feedback artefact + next round on the same phase", () => {
  it("writes fix-feedback-r{N}.md into the batch dir and dispatches round N+1 (same phase, same ws)", async () => {
    const { taskId, home, wsPath, workspaceId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "登录跳转丢了 session，补 E2E",
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { next_action: string; dispatch: Record<string, unknown> }

    expect(body.next_action).toBe("dispatched")
    // 同一 phase 的下一轮（不是下一个 phase）。
    expect(body.dispatch).toMatchObject({ phase_index: 1, round_index: 2, workspace_id: workspaceId })

    // 账本一行：rejected + feedback 全文（可追溯）。
    expect(ledgerRows(db, taskId)).toEqual([
      { phase_index: 1, round_index: 1, decision: "rejected", feedback: "登录跳转丢了 session，补 E2E" },
    ])

    // K7 反馈产物化 — N = 被打回的那一轮。
    const artifact = path.join(home, batchRel("p1"), "fix-feedback-r1.md")
    expect(fs.existsSync(artifact), artifact).toBe(true)
    const text = fs.readFileSync(artifact, "utf-8")
    expect(text).toContain("登录跳转丢了 session，补 E2E")
    expect(text).toContain("Round 1")
    // 同一次派发把它 seed 进了 ws（K9 下行 — 执行侧 agent 读得到）。
    expect(fs.existsSync(path.join(wsPath, batchRel("p1"), "fix-feedback-r1.md"))).toBe(true)

    // 新 round 落在同一 ws、打标 (1,2)，feedback 同时走 input_values。
    const tagged = db
      .prepare("SELECT phase_index, round_index, workspace_id, status FROM executions WHERE round_index = 2")
      .all() as Array<{ phase_index: number; round_index: number; workspace_id: string; status: string }>
    expect(tagged).toHaveLength(1)
    expect(tagged[0].phase_index).toBe(1)
    expect(tagged[0].workspace_id).toBe(workspaceId)
    const iv = stubService.create.mock.calls.at(-1)![1].input_values as Record<string, string>
    expect(iv.feedback).toBe("登录跳转丢了 session，补 E2E")
    expect(iv._phase_index).toBe("1")
    expect(iv._round_index).toBe("2")
    // 票03: 轮次坐标同样长在行上（派生视图/账本按键取行，不再从 config 反查）。
    expect([launchedRow(taskId).phase_index, launchedRow(taskId).round_index]).toEqual([1, 2])

    expect(sseOf(PHASE_STATUS_UPDATE_EVENT)).toEqual([
      { event: PHASE_STATUS_UPDATE_EVENT, data: { task_id: taskId, phase_index: 1, status: "running", round_index: 2 } },
    ])
  })

  it("round index follows the ledger (rejects+1) and the whole rejection chain stays traceable", async () => {
    const { taskId, home } = seedAwaitingReview()
    // r1 rejected → round 2 dispatches.
    const r1 = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "first" })
    const d1 = ((await r1.json()) as { dispatch: { execution_id: string } }).dispatch
    completeDispatchedRound(d1.execution_id, "completed")

    // r2 rejected → round 3 (2 rejected rows + 1).
    const r2 = await postAcceptance(taskId, { phase_index: 1, round_index: 2, decision: "rejected", feedback: "second" })
    const d2 = ((await r2.json()) as { dispatch: { round_index: number } }).dispatch
    expect(d2.round_index).toBe(3)
    expect(fs.existsSync(path.join(home, batchRel("p1"), "fix-feedback-r2.md"))).toBe(true)
    completeDispatchedRound((
      db.prepare("SELECT id FROM executions WHERE round_index = 3 AND phase_index = 1").get() as { id: string }
    ).id, "failed")

    // r3 (a FAILED round — US8: 失败进待验收，不是红死状态) accepted → 账本三行可追溯 + 进 phase 2.
    const r3 = await postAcceptance(taskId, { phase_index: 1, round_index: 3, decision: "accepted" })
    expect(r3.status, await r3.clone().text()).toBe(200)
    const body = (await r3.json()) as {
      next_action: string
      dispatch: { phase_index: number }
      task: { derived: { phaseViews: unknown[] } }
    }
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch.phase_index).toBe(2)
    expect(ledgerRows(db, taskId).map((r) => [r.phase_index, r.round_index, r.decision])).toEqual([
      [1, 1, "rejected"],
      [1, 2, "rejected"],
      [1, 3, "accepted"],
    ])
    const p1 = phaseOf(body.task.derived as never, 1)
    expect(p1.status).toBe("accepted")
    expect(p1.acceptedRound).toBe(3)
    // 轮次历史完整（票 11 时间线吃的就是这张表）。
    expect(p1.rounds.map((r) => [r.roundIndex, r.state, r.decision])).toEqual([
      [1, "succeeded", "rejected"],
      [2, "succeeded", "rejected"],
      [3, "failed", "accepted"],
    ])
  })
})

describe("AC3.5 — ADR-0018 打回二分路由 (next_flow)", () => {
  const posix = (p: string): string => p.split(path.sep).join("/")

  it("default (no next_flow) = rerun: 这一轮跑 phase 绑定流，行为与基线一致", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "范围没做全",
    })
    expect(res.status, await res.clone().text()).toBe(200)
    // 票03 之后没有信封可读：本轮实际跑的流就是行上的 workflow_ref。
    expect(launchedRow(taskId).workflow_ref).toBe("built-in/flow-p1")
    expect(specPhasesOf(taskId)[0].workflowRef).toBe("built-in/flow-p1") // K16 绑定不被改写
    // 派生轮次视图带上实际执行流（round 徽标数据源 — ADR-0018 审计线）。
    const body = (await res.json()) as { task: { derived: never } }
    const p1 = phaseOf(body.task.derived, 1)
    expect(p1.rounds.at(-1)!.exec).toMatchObject({ workflow_ref: "built-in/flow-p1" })
  })

  it("next_flow=fix: 本轮行上换成 built-in/task-fix + server 合成输入（home 绑定不变）", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "小错直接修", next_flow: "fix",
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const row = launchedRow(taskId)
    expect(row.workflow_ref).toBe("built-in/task-fix")
    expect(specPhasesOf(taskId)[0].workflowRef).toBe("built-in/flow-p1") // 只作用本轮的 round 级 override
    // 合成输入长在这一轮的行上（旧断言读的是信封 chain[0].input_values）。
    const iv = launchedIV(taskId)
    // ws 同构相对位（执行侧在 ws 操作，collect 回流 home — ADR-0018）
    expect(iv.phase_spec_dir).toBe(posix(batchRel("p1")))
    expect(iv.feedback_path).toBe(posix(path.join(batchRel("p1"), "fix-feedback-r1.md")))
    expect(iv.task_artifacts_dir).toBe(taskHome.artifactsDir(taskId))
    expect(iv.feedback).toBe("小错直接修")
    expect(iv._phase_index).toBe("1")
    expect(iv._round_index).toBe("2")
    // 行上的轮次坐标与 input_values 的 stamps 同段共存。
    expect([row.phase_index, row.round_index]).toEqual([1, 2])
  })

  it("非法 next_flow → 400（zod enum 拦截，账本不脏）", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "x", next_flow: "yolo",
    })
    expect(res.status).toBe(400)
    expect(ledgerRows(db, taskId)).toHaveLength(0)
  })
})

describe("AC4 — guards (409/404/400)", () => {
  it("round_index that is not the awaiting round → 409, nothing written", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 2, decision: "accepted" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/不匹配/) })
    expect(ledgerRows(db, taskId)).toEqual([])
    expect(stubService.create).not.toHaveBeenCalled()
  })

  it("a phase that is not awaiting_review (not yet started) → 409", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 2, round_index: 1, decision: "accepted" })
    expect(res.status).toBe(409)
    expect(ledgerRows(db, taskId)).toEqual([])
  })

  it("a phase index outside spec.phases → 409", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 9, round_index: 1, decision: "accepted" })
    expect(res.status).toBe(409)
    expect(ledgerRows(db, taskId)).toEqual([])
  })

  it("re-submitting an already-decided round → 409 (一次决定)", async () => {
    const { taskId } = seedAwaitingReview()
    expect((await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })).status).toBe(200)
    const dup = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ error: expect.stringMatching(/已验收/) })
    // Still ONE row (append-only + one decision per round).
    expect(ledgerRows(db, taskId)).toHaveLength(1)
  })

  it("non-v4 (v3) task → 409 with an explainable message", async () => {
    const now = new Date().toISOString()
    const id = `e2e-ac-v3-${taskSeq++}`
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'running', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, `E2E_AC v3 ${id}`, JSON.stringify({ goal: "g", ac: ["a"], task_type: "coding" }), now, now)
    const res = await postAcceptance(id, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/v4/) })
  })

  it("unknown task → 404", async () => {
    const res = await postAcceptance("e2e-ac-nope", { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status).toBe(404)
  })

  it("malformed bodies → 400 (bad decision, 0-based index, rejected without feedback)", async () => {
    const { taskId } = seedAwaitingReview()
    expect((await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "maybe" })).status).toBe(400)
    expect((await postAcceptance(taskId, { phase_index: 0, round_index: 1, decision: "accepted" })).status).toBe(400)
    const noFb = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected" })
    expect(noFb.status).toBe(400)
    expect(await noFb.json()).toMatchObject({ error: expect.stringMatching(/feedback/) })
    // and the white-space-only variant
    expect((await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "   " })).status).toBe(400)
    expect(ledgerRows(db, taskId)).toEqual([])
  })

  it("a rejected decision is STILL recorded when the retry dispatch fails (contract broke out of band)", async () => {
    const { taskId, specDirs } = seedAwaitingReview()
    // 票03 换了失败面：deriveView 按 executions.task_id 取轮次（不再 join 工作区/信封），
    // 所以工作区消失也照样看得见轮次、闸门照开；而 arm 每次都从 task_spec + home 现算
    // 启动计划 ⇒ 带外删掉批次的 spec.md 就是「决定能落、派发被拒」的现实来源。
    fs.rmSync(path.join(specDirs.get(1)!, "spec.md"))
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "x" })
    expect(res.status, await res.clone().text()).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/phase:1:spec-missing/)
    // 人的决定是历史事实：账本保留，只是没有新轮次。
    expect(ledgerRows(db, taskId)).toHaveLength(1)
    expect((db.prepare("SELECT COUNT(*) c FROM executions WHERE round_index = 2").get() as { c: number }).c).toBe(0)
    // 派生态退到 pending（无在跑 round、最新轮已 rejected）— 重试由人发起。
    const detail = service.getTask(taskId)
    expect(phaseOf(detail.derived, 1).status).toBe("pending")
  })
})

describe("derived view on GET /:id + board visibility", () => {
  it("embeds deriveTaskView's output (rounds, currentRound, awaitingRound)", async () => {
    const { taskId, execIds } = seedAwaitingReview()
    const detail = service.getTask(taskId)
    expect(detail.derived.isV4).toBe(true)
    expect(detail.derived.taskStatus).toBe("awaiting_review")
    const p1 = phaseOf(detail.derived, 1)
    expect(p1.currentRound).toBe(1)
    expect(p1.awaitingRound).toBe(1)
    expect(p1.acceptedRound).toBe(null)
    expect(p1.rounds[0].exec.id).toBe(execIds[0])
    expect(phaseOf(detail.derived, 2).status).toBe("pending")
    // The route serves the same shape.
    const res = await app.request(`/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { derived: { isV4: boolean } }).derived.isV4).toBe(true)
  })

  it("rounds of ANOTHER task never leak into the view (task_id scoping replaces the envelope join)", () => {
    const a = seedAwaitingReview()
    const b = seedAwaitingReview()
    expect(phaseOf(service.getTask(a.taskId).derived, 1).rounds.map((r) => r.exec.id))
      .toEqual([a.execIds[0]])
    expect(phaseOf(service.getTask(b.taskId).derived, 1).rounds.map((r) => r.exec.id))
      .toEqual([b.execIds[0]])
  })

  it("a v3 task keeps the verbatim mirror (isV4 false, no phases, 'failed' legal — K13)", () => {
    const now = new Date().toISOString()
    const id = `e2e-ac-v3view-${taskSeq++}`
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'failed', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, `E2E_AC v3 ${id}`, JSON.stringify({ goal: "g", ac: ["a"], task_type: "coding" }), now, now)
    const detail = service.getTask(id)
    expect(detail.derived).toEqual({ taskStatus: "failed", isV4: false, phaseViews: [] })
  })

  it("the unfiltered board scan surfaces v4-only statuses (awaiting_review / archiving)", () => {
    const { taskId } = seedAwaitingReview({ status: "awaiting_review" })
    const { taskId: archivingId } = seedAwaitingReview({ status: "archiving", phases: [TWO_PHASES[0]] })
    const items = service.listTasks({ org: ORG }).items.map((t) => t.id)
    expect(items).toContain(taskId)
    expect(items).toContain(archivingId)
    expect(service.listTasks({ status: "archiving", org: ORG }).items.map((t) => t.id)).toEqual([archivingId])
  })
})

describe("AC5 — spec-field field=phases (whole-array PUT + optimistic lock)", () => {
  function seedDraftV4(): string {
    const now = new Date().toISOString()
    const id = `e2e-ac-draft-${taskSeq++}`
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, `E2E_AC draft ${id}`, JSON.stringify({ format: "v4", task_type: "coding" }), now, now)
    return id
  }

  const phaseBody = (index: number, slug: string) => ({
    index, name: `Phase ${index}`, slug,
    specPath: `.scratch/${BATCH_DATE}/${slug}/spec.md`,
    workflowRef: "built-in/task-dev", inputValues: { idea: "$" + "{phase.slug}" },
  })

  function postSpecField(taskId: string, field: string, value: unknown) {
    return app.request(`/api/tasks/${taskId}/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field, value }),
    })
  }

  it("writes the whole phases array, bumps version, emits spec_field_update", async () => {
    const taskId = seedDraftV4()
    const res = await postSpecField(taskId, "phases", [phaseBody(1, "p1"), phaseBody(2, "p2")])
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { version: number }).version).toBe(2)

    const specJson = (db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(taskId) as
      { task_spec: string }).task_spec
    const parsed = JSON.parse(specJson).phases as Array<Record<string, unknown>>
    expect(parsed.map((p) => p.slug)).toEqual(["p1", "p2"])
    expect(parsed[0].inputValues).toEqual({ idea: "${phase.slug}" })

    const sseEvent = sseOf("spec_field_update").at(-1)
    expect(sseEvent).toMatchObject({ data: { task_id: taskId, field: "phases", version: 2 } })
  })

  it("re-setting phases REPLACES the list (PUT semantics, not per-phase merge)", async () => {
    const taskId = seedDraftV4()
    await postSpecField(taskId, "phases", [phaseBody(1, "p1"), phaseBody(2, "p2")])
    await postSpecField(taskId, "phases", [phaseBody(1, "solo")])
    const spec = JSON.parse((db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(taskId) as
      { task_spec: string }).task_spec)
    expect(spec.phases.map((p: { slug: string }) => p.slug)).toEqual(["solo"])
    // other task_spec keys survive the merge (format is untouched).
    expect(spec.format).toBe("v4")
    expect(taskRow(db, taskId).version).toBe(3)
  })

  it("rejects malformed phase payloads with 400 (empty array, path-unsafe slug)", async () => {
    const taskId = seedDraftV4()
    expect((await postSpecField(taskId, "phases", [])).status).toBe(400)
    expect((await postSpecField(taskId, "phases", [phaseBody(1, "../escape")])).status).toBe(400)
    // unchanged
    const spec = JSON.parse((db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(taskId) as
      { task_spec: string }).task_spec)
    expect(spec.phases).toBeUndefined()
    expect(taskRow(db, taskId).version).toBe(1)
  })

  it("a draft's phases round-trip through the ready gate (v4 contract holds end-to-end)", async () => {
    const taskId = seedDraftV4()
    await postSpecField(taskId, "phases", [phaseBody(1, "p1")])
    fs.mkdirSync(path.join(taskHome.homePath(taskId), batchRel("p1")), { recursive: true })
    fs.writeFileSync(path.join(taskHome.homePath(taskId), batchRel("p1"), "spec.md"), "# p1\n")
    const res = await app.request(`/api/tasks/${taskId}/ready`, { method: "POST" })
    // The stub built-in set does not contain built-in/task-dev → the gate reports the
    // phase's workflow_ref as unresolvable (never a 500, never the v3 keys).
    expect(res.status).toBe(409)
    expect(((await res.json()) as { missing: string[] }).missing).toEqual(["phase:1:workflow-ref"])
    // 票03: enqueue is a CHECK + a status write — it used to park an envelope row too.
    expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)
  })
})

describe("AC2 — autoAdvance=false parks at the human gate", () => {
  it("accepted does not start the next phase and reports awaiting_manual_trigger", async () => {
    const { taskId } = seedAwaitingReview({ autoAdvance: false })
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { next_action: string; dispatch?: unknown; task: { derived: never } }

    expect(body.next_action).toBe("awaiting_manual_trigger")
    expect(body.dispatch).toBeUndefined()
    expect(stubService.create).not.toHaveBeenCalled()
    // 账本仍落行（人的决定是历史事实）。
    expect(ledgerRows(db, taskId)).toEqual([
      { phase_index: 1, round_index: 1, decision: "accepted", feedback: null },
    ])
    // phase 2 保持 pending；派生 task 态 = ready（derive 的「accepted 中段等待
    // 下一轮」），持久态与之对齐（可 abort）。
    expect(phaseOf(body.task.derived as never, 2).status).toBe("pending")
    expect(taskRow(db, taskId).status).toBe("ready")
    // 只发 accepted 一帧（没有派发就不发 running）。
    expect(sseOf(PHASE_STATUS_UPDATE_EVENT)).toHaveLength(1)
  })
})

// ── Phase 2 review fixes ─────────────────────────────────────────────
// P3: a tagged round reaching terminal fires phase_status_update
//     {status:'awaiting_review'} on BOTH finalize paths (dispatch + claim).
// M2: K16 edit window — a v4 spec stays editable until done/archiving/aborted.
//
// 原 review C1（TaskScheduleStatusListener 不做 v4 done/failed 镜像）随该 listener 在
// 票03 一起删除：镜像 tasks.status 的职责回到 task-lifecycle job 自己身上，K3 那条规则
// 「一轮跑完不决定任务」现在钉在
// packages/server/src/services/tasks/__tests__/task-lifecycle.test.ts
// （"a v4 round ending does NOT decide the task"）。本文件不再重造那个 listener，只在
// 真实派发路径上验它的可观察面（见 P3 的 failed 用例）。

describe("review P3 — dispatched round terminal fires awaiting_review", () => {
  it("rejected → round 2 dispatches → round completes → awaiting_review frame (1,2)", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "x" })
    const dispatch = ((await res.json()) as { dispatch: { execution_id: string } }).dispatch
    completeDispatchedRound(dispatch.execution_id, "completed")
    const frames = sseOf(PHASE_STATUS_UPDATE_EVENT)
    expect(frames.some((f) => (f.data as { status?: string }).status === "awaiting_review"
      && (f.data as { phase_index?: number }).phase_index === 1
      && (f.data as { round_index?: number }).round_index === 2)).toBe(true)
    // 卡片进「待验收」是派生态：没有新行被持久化成终态。
    expect(taskRow(db, taskId).status).toBe("running")
    expect(service.getTask(taskId).derived.taskStatus).toBe("awaiting_review")
  })

  it("failed round also fires awaiting_review (terminal ≠ success)", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "rejected", feedback: "x" })
    const dispatch = ((await res.json()) as { dispatch: { execution_id: string } }).dispatch
    completeDispatchedRound(dispatch.execution_id, "failed")
    const frames = sseOf(PHASE_STATUS_UPDATE_EVENT)
    expect(frames.some((f) => (f.data as { status?: string }).status === "awaiting_review")).toBe(true)
    // K3（原 C1 的规则，换了写者）：一轮失败不是机器可以写进 tasks.status 的事实，
    // 否则卡片离开「待验收」列，acceptance 就再也点不动了。
    expect(taskRow(db, taskId).status).toBe("running")
    expect(sseOf(TASK_STATUS_EVENT).filter((e) => e.data.status === "failed")).toHaveLength(0)
    const res2 = await postAcceptance(taskId, { phase_index: 1, round_index: 2, decision: "accepted" })
    expect(res2.status, await res2.clone().text()).toBe(200)
  })
})

describe("review M2 — K16 v4 spec edit window (running editable, terminal frozen)", () => {
  const putPhases = (taskId: string) =>
    app.request(`/api/tasks/${taskId}/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "phases", value: [
        { index: 1, name: "P1", slug: "p1", specPath: `./.scratch/${BATCH_DATE}/p1/spec.md`, workflowRef: "built-in/flow-p1", inputValues: {} },
        { index: 2, name: "P2", slug: "p2", specPath: `./.scratch/${BATCH_DATE}/p2/spec.md`, workflowRef: "built-in/flow-p2", inputValues: {} },
      ] }),
    })

  it("v4 running (mid-review): phases PUT accepted, version bumps", async () => {
    const { taskId } = seedAwaitingReview()
    const res = await putPhases(taskId)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { version: number }).version).toBe(2)
  })

  it("v4 done: frozen (409)", async () => {
    const { taskId } = seedAwaitingReview({ status: "done" })
    expect((await putPhases(taskId)).status).toBe(409)
  })

  it("v3 running: still frozen (K13 byte-stable)", async () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at, workspace_id)
      VALUES (?, ?, 'E2E_AC v3-edit', 'running', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)
    `).run("e2e-ac-v3-edit", ORG, JSON.stringify({ goal: "g", ac: ["a"] }), now, now)
    const res = await app.request(`/api/tasks/e2e-ac-v3-edit/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "new" }),
    })
    expect(res.status).toBe(409)
  })

  it("cycle-2 belt: whole-spec PUT cannot strip or empty the v4 discriminant/ledger", async () => {
    const { taskId } = seedAwaitingReview()
    // Omitted format/phases → merge-preserved (the PUT's legit edit path).
    const om = await app.request(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ task_spec: { goal: "g2", ac: ["a"] } }),
    })
    expect(om.status, await om.clone().text()).toBe(200)
    const row = db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(taskId) as { task_spec: string }
    const specNow = JSON.parse(row.task_spec) as { format?: string; phases?: unknown[] }
    expect(specNow.format).toBe("v4")
    expect(specNow.phases).toHaveLength(2)
    // Explicitly emptying phases → 400 (taskPhaseSchema min(1)).
    const empty = await app.request(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": "2" },
      body: JSON.stringify({ task_spec: { format: "v4", phases: [] } }),
    })
    expect(empty.status).toBe(400)
  })
})
