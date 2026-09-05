// packages/server/src/__tests__/tasks-v4-handoff-injection.test.ts
//
// phase-handoff-chaining ticket 01 — `prev_handoff_paths` auto-injection.
//
// Verifies (real better-sqlite3 + applySchema + real tmp task homes + stubbed
// ExecutionService registry mirroring lifecycle.create's DB write — same
// harness family as tasks-v4-acceptance.test.ts, R1-R7):
//   AC1: accept phase 1 (handoff.md pre-placed in its batch dir) → the next
//        phase's round-1 chain input_values carry prev_handoff_paths =
//        {specDir}/handoff.md, platform-native ABSOLUTE path (API↔DB↔fs).
//   AC2: predecessor without handoff.md → silently filtered; all-missing →
//        the key is absent and input_values match the baseline key set.
//   AC3: same-phase rerun NEVER injects (even with an accepted predecessor
//        holding a handoff); multiple predecessors → ascending index, "\n"-joined.
//   AC4: manual advance (/api/tasks/:id/advance) behaves identically to the
//        autoAdvance acceptance path.
//   AC5: v3 tasks refuse at both gates (no injection surface); envelopes'
//        frozen phases[] stay byte-identical (K16).
//
// E2E_HO_ data prefix; fs assertions under mkdtemp tmp HOME (cleaned after).

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
import { createTasksRoutes } from "../routes/tasks"

const ORG = "e2e-ho"
const BATCH_DATE = "20260905"

// ── ExecutionService registry stub (mirrors tasks-v4-acceptance.test.ts) ──
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-ho-exec-${execSeq++}`
    mockHooks.db!
      .prepare(
        `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`,
      )
      .run(id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""), ORG)
    return { id }
  }),
  start: vi.fn(async () => {}),
  registerExternalCallbacks: vi.fn(() => {}),
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

const THREE_PHASES: PhaseDef[] = [
  ...TWO_PHASES,
  { index: 3, name: "Phase 3", slug: "p3", workflowRef: "built-in/flow-p3" },
]

function batchRel(slug: string): string {
  return path.join(".scratch", BATCH_DATE, slug)
}

let taskSeq = 0

/**
 * Build a v4 task world for the handoff-channel tests: task home + phase batch
 * dirs (with optional pre-placed handoff.md), a bound workspace, the K5
 * envelope (materialized specDir shape, terminal status → active slot free),
 * per-phase tagged terminal executions and pre-inserted ledger rows — so the
 * derived view parks exactly where each AC needs the gate to open.
 */
function seed(opts: {
  phases?: PhaseDef[]
  autoAdvance?: boolean
  status?: string
  ledger?: Array<{ phase_index: number; round_index: number; decision: string }>
  /** phase index → its seeded (terminal) rounds. Default: phase 1 round 1. */
  roundsByPhase?: Record<number, Array<{ round: number; status: string }>>
  /** phase index → handoff.md content written into the batch dir (fs side). */
  handoffs?: Record<number, string>
} = {}) {
  const db = mockHooks.db!
  const phases = opts.phases ?? TWO_PHASES
  const taskId = `e2e-ho-task-${taskSeq++}`
  const now = new Date().toISOString()

  const home = taskHome.homePath(taskId)
  const specDirs = new Map<number, string>()
  for (const p of phases) {
    const dir = path.join(home, batchRel(p.slug))
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# ${p.name} scope\n`)
    const handoff = opts.handoffs?.[p.index]
    if (handoff !== undefined) fs.writeFileSync(path.join(dir, "handoff.md"), handoff)
    specDirs.set(p.index, dir)
  }

  const workspaceId = `e2e-ho-ws-${taskSeq}`
  const wsPath = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", `${taskId}-ws`)
  fs.mkdirSync(wsPath, { recursive: true })
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', datetime('now'), datetime('now'))",
  ).run(workspaceId, `task:${taskId}`, ORG, wsPath)

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
  `).run(taskId, ORG, `E2E_HO ${taskId}`, opts.status ?? "running", JSON.stringify(spec), now, now, workspaceId)

  const scheduleId = `e2e-ho-sched-${taskSeq}`
  db.prepare(`
    INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
      job_type, config, parallel_policy, status, origin_type, origin_id, origin_role,
      scheduled_at, created_at, updated_at, max_retain)
    VALUES (?, ?, ?, NULL, 'UTC', 1, 'workflow', ?, 'skip', 'done', 'task', ?, 'primary', NULL, ?, ?, 10)
  `).run(
    scheduleId, ORG, `task-${taskId}-primary`,
    JSON.stringify({
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "taskpool-e2e-ho", projects: [] },
      workflow_chain: [{ workflow_ref: phases[0].workflowRef, input_values: {} }],
      max_retain: 10,
      format: "v4",
      phases: phases.map((p) => ({
        index: p.index,
        name: p.name,
        slug: p.slug,
        specPath: path.join(specDirs.get(p.index)!, "spec.md"),
        specDir: specDirs.get(p.index),
        workflowRef: p.workflowRef,
        inputValues: {},
      })),
    }),
    taskId, now, now,
  )

  // Seeded terminal rounds — each execution rides a COMPLETED
  // schedule_executions row (deriveView scopes rounds THROUGH the schedule
  // link; a completed slot never blocks the dispatch's active index).
  const roundsByPhase = opts.roundsByPhase ?? { 1: [{ round: 1, status: "completed" }] }
  const execIds: string[] = []
  for (const [phaseIdxStr, rounds] of Object.entries(roundsByPhase)) {
    const phaseIdx = Number(phaseIdxStr)
    for (const r of rounds) {
      const execId = `e2e-ho-exec-seeded-${taskSeq}-${phaseIdx}-${r.round}`
      execIds.push(execId)
      db.prepare(
        `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org,
          phase_index, round_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        execId, workspaceId,
        phases.find((p) => p.index === phaseIdx)!.workflowRef,
        phases.find((p) => p.index === phaseIdx)!.workflowRef,
        r.status, ORG, phaseIdx, r.round,
      )
      db.prepare(`
        INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
          timezone_offset, timezone_iana, created_at, triggered_by, execution_id)
        VALUES (?, ?, 'completed', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler', ?)
      `).run(`e2e-ho-se-${taskSeq}-${phaseIdx}-${r.round}`, scheduleId, execId)
    }
  }

  for (const row of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))",
    ).run(`e2e-ho-acc-${taskSeq}-${row.phase_index}-${row.round_index}`, taskId, row.phase_index, row.round_index, row.decision)
  }

  return { db, taskId, scheduleId, workspaceId, home, specDirs, execIds }
}

/** Read the materialized chain[0] off the persisted envelope (DB side — what
 *  a crash re-claim replays). */
function envelopeCfg(taskId: string): {
  workflow_chain: Array<{ workflow_ref: string; input_values: Record<string, string> }>
  phases: Array<{ index: number; workflowRef: string; specDir?: string }>
} {
  const { config } = db
    .prepare("SELECT config FROM schedules WHERE origin_type='task' AND origin_id=? AND origin_role='primary'")
    .get(taskId) as { config: string }
  return JSON.parse(config)
}

function chainIV(taskId: string): Record<string, string> {
  return envelopeCfg(taskId).workflow_chain[0].input_values
}

const handoffPathOf = (specDirs: Map<number, string>, idx: number): string =>
  path.join(specDirs.get(idx)!, "handoff.md")

// ── Suite ────────────────────────────────────────────────────────────

let db: Database.Database
let sse: SSEService
let service: TasksService
let app: Hono
let taskHome: TaskHomeService
let fakeHome: string
let realHome: string | undefined
let realUserProfile: string | undefined

function postAcceptance(taskId: string, body: Record<string, unknown>) {
  return app.request(`/api/tasks/${taskId}/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  db = newDb()
  mockHooks.db = db
  execSeq = 0
  taskSeq = 0
  vi.clearAllMocks()
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ho-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome // os.homedir() on Windows reads USERPROFILE
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  sse = new SSEService()
  service = new TasksService(db, sse, undefined, taskHome)
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

describe("AC1 — accepted→下 phase round 1 注入 prev_handoff_paths（API↔DB↔fs 四方）", () => {
  it("phase1 accepted（预置 handoff.md）→ phase2 首轮 chain input_values 带 home 绝对路径", async () => {
    const { taskId, specDirs } = seed({ handoffs: { 1: "# handoff p1\n" } })

    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { next_action: string; dispatch?: Record<string, unknown> }
    // API 面：确实开的是 phase2 首轮。
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch).toMatchObject({ phase_index: 2, round_index: 1 })

    const expected = handoffPathOf(specDirs, 1)
    // fs 面：路径指向真实存在的文件（注入的是 home 绝对位）。
    expect(fs.existsSync(expected)).toBe(true)
    expect(path.isAbsolute(expected)).toBe(true)

    // DB 面：materialized chain[0]（崩溃 re-claim 可复现的持久化位）。
    const iv = chainIV(taskId)
    expect(iv.prev_handoff_paths).toBe(expected)
    // 执行 create() 拿到同一份 stepInputValues。
    const createCall = stubService.create.mock.calls.at(-1)!
    expect((createCall[1].input_values as Record<string, string>).prev_handoff_paths).toBe(expected)
    // 恢复 stamps 同段共存。
    expect(iv._phase_index).toBe("2")
    expect(iv._round_index).toBe("1")
  })

  it("注入不触碰信封冻结面：phases[] 的 workflowRef/specDir 原样（K16）", async () => {
    const { taskId, specDirs } = seed({ handoffs: { 1: "h" } })
    const before = envelopeCfg(taskId).phases
    await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    const after = envelopeCfg(taskId).phases
    expect(after.map((p) => ({ index: p.index, workflowRef: p.workflowRef, specDir: p.specDir })))
      .toEqual(before.map((p) => ({ index: p.index, workflowRef: p.workflowRef, specDir: p.specDir })))
    expect(after[0].specDir).toBe(specDirs.get(1))
  })
})

describe("AC2 — 存在性过滤 / 全空不注入键", () => {
  it("前序无 handoff.md → 键完全不出现，input_values 与基线键集一致", async () => {
    const { taskId } = seed()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const iv = chainIV(taskId)
    expect("prev_handoff_paths" in iv).toBe(false)
    // phase.inputValues 为 {} ⇒ 基线只有恢复 stamps 两键（无新键泄漏）。
    expect(Object.keys(iv).sort()).toEqual(["_phase_index", "_round_index"])
  })

  it("多前序中缺 handoff 的被静默跳过，存在的那条仍注入（不 fail）", async () => {
    // phase1 accepted 但无 handoff；phase2 待验收且带 handoff → accepted 后
    // phase3 首轮只见 phase2 一行。
    const { taskId, specDirs } = seed({
      phases: THREE_PHASES,
      ledger: [{ phase_index: 1, round_index: 1, decision: "accepted" }],
      roundsByPhase: { 1: [{ round: 1, status: "completed" }], 2: [{ round: 1, status: "completed" }] },
      handoffs: { 2: "# handoff p2\n" },
    })
    const res = await postAcceptance(taskId, { phase_index: 2, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const iv = chainIV(taskId)
    expect(iv.prev_handoff_paths).toBe(handoffPathOf(specDirs, 2))
    expect(iv.prev_handoff_paths).not.toContain(handoffPathOf(specDirs, 1))
  })
})

describe("AC3 — rerun 不注入；多前序按 index 升序换行连接", () => {
  it("打回 rerun 同 phase 不注入（即便存在带 handoff 的 accepted 前序）", async () => {
    const { taskId } = seed({
      phases: THREE_PHASES,
      ledger: [{ phase_index: 1, round_index: 1, decision: "accepted" }],
      roundsByPhase: { 1: [{ round: 1, status: "completed" }], 2: [{ round: 1, status: "completed" }] },
      handoffs: { 1: "# handoff p1\n" },
    })
    const res = await postAcceptance(taskId, {
      phase_index: 2, round_index: 1, decision: "rejected", feedback: "接口漏了分页",
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const iv = chainIV(taskId)
    expect("prev_handoff_paths" in iv).toBe(false)
    // 既有信道不受影响：feedback + stamps 原样。
    expect(iv.feedback).toBe("接口漏了分页")
    expect(iv._phase_index).toBe("2")
    expect(iv._round_index).toBe("2")
  })

  it("两个 accepted 前序（1+2）→ 开 phase3 首轮见两行、index 升序", async () => {
    const { taskId, specDirs } = seed({
      phases: THREE_PHASES,
      ledger: [
        { phase_index: 1, round_index: 1, decision: "accepted" },
        { phase_index: 2, round_index: 1, decision: "accepted" },
      ],
      roundsByPhase: { 1: [{ round: 1, status: "completed" }], 2: [{ round: 1, status: "completed" }] },
      handoffs: { 1: "one", 2: "two" },
    })
    const res = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(res.status, await res.clone().text()).toBe(200)
    const value = chainIV(taskId).prev_handoff_paths
    expect(value.split("\n")).toEqual([handoffPathOf(specDirs, 1), handoffPathOf(specDirs, 2)])
  })
})

describe("AC4 — 手动推进与 autoAdvance 行为一致", () => {
  it("autoAdvance=false 停闸 → /advance 起 phase2 首轮，注入值与 auto 路径同形", async () => {
    const { taskId, specDirs } = seed({ autoAdvance: false, handoffs: { 1: "h1" } })
    const parked = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(parked.status, await parked.clone().text()).toBe(200)
    expect(((await parked.json()) as { next_action: string }).next_action).toBe("awaiting_manual_trigger")
    // 未派发 ⇒ 没有任何注入发生（chain 仍是信封基线）。
    expect("prev_handoff_paths" in chainIV(taskId)).toBe(false)

    const adv = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(adv.status, await adv.clone().text()).toBe(200)
    const body = (await adv.json()) as { next_action: string; dispatch: Record<string, unknown> }
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch).toMatchObject({ phase_index: 2, round_index: 1 })
    // 与 AC1 auto 路径同值：同一判定源 ⇒ 同一 home 绝对路径。
    expect(chainIV(taskId).prev_handoff_paths).toBe(handoffPathOf(specDirs, 1))
  })
})

describe("AC5 — v3 任务零影响（回归）", () => {
  it("v3 任务 acceptance/advance 双双 409，注入面无泄漏，无新执行", async () => {
    const now = new Date().toISOString()
    const id = `e2e-ho-v3-${taskSeq++}`
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'running', NULL, ?, '[]', '[]', '[]', '[]', 'built-in/task-dev', 1, NULL, ?, ?, NULL)
    `).run(id, ORG, `E2E_HO v3 ${id}`, JSON.stringify({ goal: "g", ac: ["a"], task_type: "coding" }), now, now)

    const acc = await postAcceptance(id, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(acc.status).toBe(409)
    const adv = await app.request(`/api/tasks/${id}/advance`, { method: "POST" })
    expect(adv.status).toBe(409)
    expect(stubService.create).not.toHaveBeenCalled()
  })

  it("v4 首 phase 派发不经 dispatchPhaseRound（trigger 域零改动）：accept 末 phase 无派发无注入", async () => {
    const { taskId } = seed({ phases: [TWO_PHASES[0]], handoffs: { 1: "h" } })
    // Stub the 票 08 hook so the built-in archiver (git/fs) never runs here.
    service.setArchivingHook(() => {})
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { next_action: string }).next_action).toBe("archiving")
    // 末 phase accepted → 不开新轮 ⇒ chain 保持信封基线，无键泄漏。
    expect("prev_handoff_paths" in chainIV(taskId)).toBe(false)
    expect(stubService.create).not.toHaveBeenCalled()
  })
})
