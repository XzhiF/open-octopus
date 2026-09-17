// packages/server/src/__tests__/tasks-v4-pause-resume.test.ts
//
// task-pause — the task-level pause/resume API.
//
// The design under test (see the plan + derive-task-view's header): the HOST of a pause
// is the execution, not the task. `POST /:id/pause` delegates to the bound run's
// ExecutionLifecycle.pause (hard-kill the in-flight node, land executions.status='paused')
// and the task's 已暂停 is DERIVED from that row — nothing writes a paused tasks.status.
// That is what keeps the execution layer unaware of tasks, since not every workflow has
// one bound.
//
// Verifies (real better-sqlite3 + applySchema + real tmp task homes + a stubbed
// ExecutionService registry that writes real executions rows):
//   AC1: pause delegates, the row lands 'paused', derived.taskStatus becomes 'paused',
//        tasks.status is NOT mirrored (still whatever it was), and one TASK_EXECUTION_EVENT
//        goes out on the taskpool channel.
//   AC2: the 409 ladder — nothing in flight / queued / parked at an approval gate /
//        terminal latest round / a refusal relayed from the execution service — each with
//        a message that names the actual situation.
//   AC3: resume re-registers the launch callbacks BEFORE delegating (the engine is
//        reconstructed during resume and EngineCallbacks has already consumed the entry),
//        then hands back to 'running'.
//   AC4: 暂停 ⟹ 不可验收 (flat rule, incl. the cross-phase case the per-phase gate misses),
//        while ABORT stays available — it is the only other exit from a pause.
//
// E2E_PR_ data prefix; fs assertions under mkdtemp tmp HOME (cleaned after).

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
import { TASK_EXECUTION_EVENT } from "@octopus/shared"
import { WorkspaceDAO } from "../db/dao"

const ORG = "e2e-pr"
const BATCH_DATE = "20260903"

// ── ExecutionService registry stub ───────────────────────────────────
// pause/resume mirror the REAL contract where it matters for this suite: pause flips the
// row and reports success only when the engine would have accepted it; both are async
// (the real ones await the engine settling).

const stubCalls: string[] = []

const stubService = {
  pause: vi.fn(async (id: string) => {
    stubCalls.push(`pause:${id}`)
    mockHooks.db!
      .prepare("UPDATE executions SET status='paused' WHERE id=?")
      .run(id)
    return { success: true }
  }),
  resume: vi.fn(async (id: string, intervention?: string) => {
    stubCalls.push(`resume:${id}${intervention ? `:${intervention}` : ""}`)
    mockHooks.db!
      .prepare("UPDATE executions SET status='running' WHERE id=?")
      .run(id)
    return { success: true }
  }),
  registerExternalCallbacks: vi.fn((hooks: { onComplete?: (s?: string) => void }, execId: string) => {
    stubCalls.push(`cb:${execId}`)
    capturedCallbacks.set(execId, hooks.onComplete ?? null)
  }),
  clearExternalCallbacks: vi.fn(),
  start: vi.fn(async () => {}),
  create: vi.fn(() => ({ id: "unused" })),
  cancel: vi.fn((id: string) => ({ id })),
  hasLiveEngine: () => false,
}
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

// ── Fixtures ─────────────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  return db
}

let taskSeq = 0
let fakeHome: string
let realHome: string | undefined
let realUserProfile: string | undefined

/** A v4 task with `phaseCount` phases, a bound workspace row, and one round per
 *  (phase, round, status) triple laid down as REAL executions rows — the read model
 *  deriveTaskView consumes. */
function seed(opts: {
  rounds?: Array<{ phase: number; round: number; status: string }>
  phaseCount?: number
  taskStatus?: string
  /** Lives in task_spec (NOT the acceptance body) — false keeps an accepted phase from
   *  dispatching, which is what isolates the acceptance-gate assertions. */
  autoAdvance?: boolean
  ledger?: Array<{ phase: number; round: number; decision: string }>
} = {}) {
  const db = mockHooks.db!
  const phaseCount = opts.phaseCount ?? 2
  const taskId = `e2e-pr-task-${taskSeq}`
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    index: i + 1,
    name: `Phase ${i + 1}`,
    slug: `p${i + 1}`,
    workflowRef: `built-in/flow-p${i + 1}`,
  }))
  const now = new Date().toISOString()

  const home = taskHome.homePath(taskId)
  for (const p of phases) {
    const dir = path.join(home, ".scratch", BATCH_DATE, p.slug)
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# ${p.name} scope\n`)
  }

  const workspaceId = `e2e-pr-ws-${taskSeq}`
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
      specPath: path.join(".scratch", BATCH_DATE, p.slug, "spec.md"),
      workflowRef: p.workflowRef,
      inputValues: {},
    })),
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_PR ${taskId}`, opts.taskStatus ?? "running", JSON.stringify(spec), now, now, workspaceId)

  const execIds: Record<string, string> = {}
  for (const r of opts.rounds ?? [{ phase: 1, round: 1, status: "running" }]) {
    const execId = `e2e-pr-exec-${taskSeq}-${r.phase}-${r.round}`
    execIds[`${r.phase}:${r.round}`] = execId
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
       VALUES (?, ?, '0', 0, ?, ?, ?, '{}', '{}', ?, datetime('now'), datetime('now'), ?, ?, ?)`,
    ).run(execId, workspaceId, `built-in/flow-p${r.phase}`, `built-in/flow-p${r.phase}`, r.status, ORG, taskId, r.phase, r.round)
  }

  for (const l of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))",
    ).run(`e2e-pr-acc-${taskSeq}-${l.phase}-${l.round}`, taskId, l.phase, l.round, l.decision)
  }

  return { taskId, workspaceId, wsPath, home, execIds }
}

function execStatus(execId: string): string {
  return (mockHooks.db!.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }).status
}

function taskStatus(taskId: string): string {
  return (mockHooks.db!.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status
}

function derivedStatus(taskId: string): string {
  const dto = service.getTask(taskId) as unknown as { derived: { taskStatus: string } }
  return dto.derived.taskStatus
}

// ── Suite ────────────────────────────────────────────────────────────

let db: Database.Database
let sse: SSEService
let service: TasksService
let app: Hono
let taskHome: TaskHomeService
let sseEvents: Array<{ event: string; data: Record<string, unknown> }>

function post(path: string, body?: Record<string, unknown>) {
  return app.request(`/api/tasks/${path}`, {
    method: "POST",
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  })
}

const builtInStub = { get: () => null } as never

beforeEach(() => {
  db = newDb()
  mockHooks.db = db
  taskSeq = 0
  stubCalls.length = 0
  capturedCallbacks.clear()
  vi.clearAllMocks()
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pr-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  sse = new SSEService()
  sseEvents = []
  sse.subscribe("taskpool", (e) => sseEvents.push({ event: e.event, data: e.data as Record<string, unknown> }))
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

describe("AC1 — pause delegates to the run and the task reflects it", () => {
  it("pauses the bound execution, derives 已暂停, and does NOT mirror a task status", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    const execId = execIds["1:1"]

    // Before: the round is live, so the task reads 执行中 (persisted status is 'running').
    expect(derivedStatus(taskId)).toBe("running")

    const res = await post(`${taskId}/pause`)
    expect(res.status).toBe(200)

    // The pause is an EXECUTION fact …
    expect(execStatus(execId)).toBe("paused")
    expect(stubCalls).toContain(`pause:${execId}`)
    // … and the task's 已暂停 is purely derived from it.
    expect(derivedStatus(taskId)).toBe("paused")
    // The persisted task status is untouched: no paused task row exists, by design.
    expect(taskStatus(taskId)).toBe("running")

    // One run-transition event, on the channel both the board and the console fold.
    const execs = sseEvents.filter((e) => e.event === TASK_EXECUTION_EVENT)
    expect(execs).toHaveLength(1)
    expect(execs[0].data).toMatchObject({ task_id: taskId, execution_id: execId, status: "paused" })
    // No task_status event — the persisted status did not change.
    expect(sseEvents.filter((e) => e.event === "task_status")).toHaveLength(0)
  })

  it("pauses only the live round, leaving earlier terminal rounds alone", async () => {
    const { taskId, execIds } = seed({
      rounds: [
        { phase: 1, round: 1, status: "completed" },
        { phase: 2, round: 1, status: "running" },
      ],
    })
    await post(`${taskId}/pause`)
    expect(execStatus(execIds["1:1"])).toBe("completed")
    expect(execStatus(execIds["2:1"])).toBe("paused")
    expect(derivedStatus(taskId)).toBe("paused")
  })
})

describe("AC2 — the 409 ladder names the actual situation", () => {
  it("409 when nothing is in flight", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "completed" }] })
    const res = await post(`${taskId}/pause`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("没有进行中的执行")
  })

  it("409 when the round is queued but not started", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "pending" }] })
    const res = await post(`${taskId}/pause`)
    expect(res.status).toBe(409)
    const msg = (await res.json()).error
    expect(msg).toContain("排队")
    // The way out is named — a bare "执行未在运行中" would tell the user nothing.
    expect(msg).toContain("中止")
  })

  it("409 when the round is parked at an approval node — and the to-do is not buried", async () => {
    // A run waiting for a human is the engine ALIVE, not paused. Calling it 已暂停 would
    // hide the real to-do («需要你审批»), so it must be refused with a message that says so.
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "pending_approval" }] })
    const res = await post(`${taskId}/pause`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("审批")
    expect(execStatus(execIds["1:1"])).toBe("pending_approval")
    // And it must NOT display as paused.
    expect(derivedStatus(taskId)).toBe("running")
  })

  it("relays a refusal from the execution service instead of inventing a success", async () => {
    // The between-nodes window: ExecutionLifecycle.pause refuses rather than leaving a
    // 'paused' row that resume() could never take back. The task route must surface that
    // reason verbatim and stay 409 — not report a pause that did not happen.
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    stubService.pause.mockImplementationOnce(async () => ({
      success: false,
      error: "执行当前没有运行中的节点，无法暂停",
    }))

    const res = await post(`${taskId}/pause`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("没有运行中的节点")
    expect(execStatus(execIds["1:1"])).toBe("running")
    expect(derivedStatus(taskId)).toBe("running")
    expect(sseEvents.filter((e) => e.event === TASK_EXECUTION_EVENT)).toHaveLength(0)
  })

  it("404 for an unknown task", async () => {
    const res = await post("nope/pause")
    expect(res.status).toBe(404)
  })
})

describe("AC3 — resume re-registers the callbacks before delegating", () => {
  it("restores the round and hands the intervention through", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "paused" }] })
    const execId = execIds["1:1"]
    expect(derivedStatus(taskId)).toBe("paused")

    const res = await post(`${taskId}/resume`, { intervention: "跳过迁移脚本" })
    expect(res.status).toBe(200)
    expect(execStatus(execId)).toBe("running")
    expect(stubCalls).toContain(`resume:${execId}:跳过迁移脚本`)
    expect(derivedStatus(taskId)).toBe("running")

    const execs = sseEvents.filter((e) => e.event === TASK_EXECUTION_EVENT)
    expect(execs).toHaveLength(1)
    expect(execs[0].data).toMatchObject({ status: "running" })
  })

  it("has the callbacks registered BEFORE resume is delegated", async () => {
    // Load-bearing ordering. EngineCallbacks fires onComplete and then DELETES the
    // external entry, so a round that ended in 'paused' burned its callback while
    // finalizeLaunch correctly declined to finalize (isWaiting). Resume rebuilds the
    // engine from persisted state — if the re-register came after, the round would later
    // complete with nobody listening and silently lose collectRound / 待验收 / the red
    // round's reason. Order is the only thing that makes the re-register work.
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "paused" }] })
    const execId = execIds["1:1"]

    const order: string[] = []
    stubService.registerExternalCallbacks.mockImplementationOnce((h: { onComplete?: (s?: string) => void }, id: string) => {
      order.push(`cb:${id}`)
      capturedCallbacks.set(id, h.onComplete ?? null) // write through, so the wiring is checked too
    })
    stubService.resume.mockImplementationOnce(async (id: string) => {
      order.push(`resume:${id}`)
      mockHooks.db!.prepare("UPDATE executions SET status='running' WHERE id=?").run(id)
      return { success: true }
    })

    await post(`${taskId}/resume`)
    expect(order).toEqual([`cb:${execId}`, `resume:${execId}`])
    // And the re-registered callback really is wired back to this round.
    expect(capturedCallbacks.get(execId)).toBeTruthy()
  })

  it("409 when the round is not paused", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    const res = await post(`${taskId}/resume`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("无法恢复")
  })

  it("400 on a non-string or oversized intervention", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "paused" }] })
    expect((await post(`${taskId}/resume`, { intervention: 42 })).status).toBe(400)
    expect((await post(`${taskId}/resume`, { intervention: "x".repeat(4001) })).status).toBe(400)
    // A body-less resume is the normal case, not an error.
    expect((await post(`${taskId}/resume`)).status).toBe(200)
  })
})

describe("AC4 — 暂停期间不可验收，但中止仍然可用", () => {
  it("409s an acceptance targeting a round on another phase while the task is suspended", async () => {
    // The per-phase gate alone cannot catch this: phase 1's round is genuinely
    // awaiting_review and phase 1 is the requested phase. Only the task-level
    // suspension check stops it.
    const { taskId } = seed({
      rounds: [
        { phase: 1, round: 1, status: "completed" },
        { phase: 2, round: 1, status: "paused" },
      ],
    })
    expect(derivedStatus(taskId)).toBe("paused")

    const res = await post(`${taskId}/acceptance`, {
      phase_index: 1, round_index: 1, decision: "accepted",
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("已暂停")
    // Nothing was appended to the ledger.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_phase_acceptances WHERE task_id = ?").get(taskId) as { n: number }
    expect(rows.n).toBe(0)
  })

  it("still allows an acceptance once the round is resumed", async () => {
    // Guards the test above against a false green: the same request must SUCCEED when the
    // task is not suspended.
    const { taskId } = seed({
      autoAdvance: false,
      rounds: [
        { phase: 1, round: 1, status: "completed" },
        { phase: 2, round: 1, status: "running" },
      ],
    })
    const res = await post(`${taskId}/acceptance`, {
      phase_index: 1, round_index: 1, decision: "accepted",
    })
    expect(res.status).toBe(200)
  })

  it("keeps abort available while paused — it is the only other exit", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "paused" }] })
    const res = await post(`${taskId}/abort`)
    expect(res.status).toBe(200)
    expect(taskStatus(taskId)).toBe("aborted")
    expect(execStatus(execIds["1:1"])).toBe("aborted")
  })
})
