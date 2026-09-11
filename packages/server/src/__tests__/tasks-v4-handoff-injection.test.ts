// packages/server/src/__tests__/tasks-v4-handoff-injection.test.ts
//
// phase-handoff-chaining ticket 01 — `prev_handoff_paths` auto-injection.
//
// Verifies (real better-sqlite3 + applySchema + real tmp task homes + stubbed
// ExecutionService registry mirroring lifecycle.create's DB write — same
// harness family as tasks-v4-acceptance.test.ts, R1-R7):
//   AC1: accept phase 1 (handoff.md pre-placed in its batch dir) → the next
//        phase's round-1 LAUNCH carries prev_handoff_paths = {specDir}/handoff.md,
//        platform-native ABSOLUTE path (API↔DB↔fs).
//   AC2: predecessor without handoff.md → silently filtered; all-missing →
//        the key is absent and input_values match the baseline key set.
//   AC3: same-phase rerun NEVER injects (even with an accepted predecessor
//        holding a handoff); multiple predecessors → ascending index, "\n"-joined.
//   AC4: manual advance (/api/tasks/:id/advance) behaves identically to the
//        autoAdvance acceptance path.
//   AC5: v3 tasks refuse at both gates (no injection surface); a dispatch never
//        rewrites the author's phases[] binding.
//
// 票03 换了读点：注入值不再写进「信封 config 的 chain[0]」（那份冻结副本随票03 退役），
// 而是长在**这一轮的执行行**上（executions.input_values）—— 断言因此读行，且读的是
// 真 INSERT 出来的行（stub 直写 executions，ux_exec_task_active / task_id 都是真的）。
//
// 为什么这些用例特意钉「卡片仍是 running 时也能起下一轮」：v4 一轮跑完 job 不改
// tasks.status（K3：待验收是派生态，不是一次机器转移），而 acceptance 的
// rejected / autoAdvance 两支与 advance 都是**人在授权**，发生在卡片写着 running 的
// 时候。armTask 若只领 ready，整条 v4 流程就断在半路 —— 票03 复核抓到过一次，故
// 这里连同 ws-reuse/archiving 的用例一起当作回归锚点。
//
// E2E_HO_ data prefix; fs assertions under mkdtemp tmp HOME (cleaned after).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { ExecutionDAO, WorkspaceDAO } from "../db/dao"
import { WorkspaceService } from "../services/workspace"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { createTasksRoutes } from "../routes/tasks"

const ORG = "e2e-ho"
const BATCH_DATE = "20260905"

// ── ExecutionService registry stub (mirrors tasks-v4-acceptance.test.ts) ──
// A REAL 'pending' root row: the built-in job's claim loop, the one-instance latch
// and deriveView all read what is actually stored, not what this stub pretends.
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-ho-exec-${execSeq++}`
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
  registerExternalCallbacks: vi.fn(() => {}),
  clearExternalCallbacks: vi.fn(),
  cancel: vi.fn((id: string) => ({ id })),
  hasLiveEngine: () => false,
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
 * dirs (with optional pre-placed handoff.md), a bound workspace, per-phase tagged
 * terminal execution rows and pre-inserted ledger rows — so the derived view parks
 * exactly where each AC needs the gate to open.
 *
 * 票03: 没有「K5 信封」了。一轮就是一行 executions（task_id 直连 + parent_id='0' +
 * 轮次坐标），deriveView 读的就是它；启动计划每次 arm 从 task_spec + home 现算，
 * 所以批次 spec.md 必须真在盘上（arm 会重查 v4 契约）。
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
  `).run(taskId, ORG, `E2E_HO ${taskId}`, opts.status ?? "running", JSON.stringify(spec), now, now, workspaceId)

  // Seeded terminal rounds — 票03 起这就是全部的读模型（task_id + parent_id='0' +
  // (phase_index, round_index)）；终态行既不挡闩锁也不占算力槽。
  const roundsByPhase = opts.roundsByPhase ?? { 1: [{ round: 1, status: "completed" }] }
  const execIds: string[] = []
  for (const [phaseIdxStr, rounds] of Object.entries(roundsByPhase)) {
    const phaseIdx = Number(phaseIdxStr)
    for (const r of rounds) {
      const execId = `e2e-ho-exec-seeded-${taskSeq}-${phaseIdx}-${r.round}`
      execIds.push(execId)
      db.prepare(
        `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
           status, org, created_at, updated_at, task_id, phase_index, round_index, completed_at)
         VALUES (?, ?, '0', 0, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, datetime('now'))`,
      ).run(
        execId, workspaceId,
        phases.find((p) => p.index === phaseIdx)!.workflowRef,
        phases.find((p) => p.index === phaseIdx)!.workflowRef,
        r.status, ORG, taskId, phaseIdx, r.round,
      )
    }
  }

  for (const row of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))",
    ).run(`e2e-ho-acc-${taskSeq}-${row.phase_index}-${row.round_index}`, taskId, row.phase_index, row.round_index, row.decision)
  }

  return { db, taskId, workspaceId, home, specDirs, execIds }
}

/** The input_values of the task's CURRENT instance — the row the run actually eats
 *  (replaces reading the envelope's materialized chain[0]). */
function launchedIV(taskId: string): Record<string, string> {
  const row = new ExecutionDAO(mockHooks.db!).findLatestTaskRoot(taskId)
  if (!row) throw new Error(`no launch row for ${taskId}`)
  return JSON.parse(row.input_values) as Record<string, string>
}

function launchedRow(taskId: string) {
  const row = new ExecutionDAO(mockHooks.db!).findLatestTaskRoot(taskId)
  if (!row) throw new Error(`no launch row for ${taskId}`)
  return row
}

function specPhasesOf(taskId: string): Array<Record<string, unknown>> {
  const { task_spec } = mockHooks.db!
    .prepare("SELECT task_spec FROM tasks WHERE id = ?")
    .get(taskId) as { task_spec: string }
  return (JSON.parse(task_spec) as { phases: Array<Record<string, unknown>> }).phases
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
  // arm 重查 v4 契约 ⇒ 需要能解析 built-in/*；派发⇒ job 的 prepareWorkspace ⇒ 需要
  // 真 WorkspaceService（绑定复用路径也要先拿到服务才查绑定）。
  const builtIn = {
    get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }),
  } as never
  service = new TasksService(
    db, sse, undefined, taskHome, undefined, builtIn, null,
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

describe("AC1 — accepted→下 phase round 1 注入 prev_handoff_paths（API↔DB↔fs 四方）", () => {
  it("phase1 accepted（预置 handoff.md）→ phase2 首轮的执行行带 home 绝对路径", async () => {
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

    // DB 面：注入值长在**这一轮的行**上（票03：没有信封 config 可读）。
    const iv = launchedIV(taskId)
    expect(iv.prev_handoff_paths).toBe(expected)
    // 执行 create() 拿到同一份 stepInputValues。
    const createCall = stubService.create.mock.calls.at(-1)!
    expect((createCall[1].input_values as Record<string, string>).prev_handoff_paths).toBe(expected)
    // 轮次坐标同段共存（行上 + input_values 双写：前者给 derive/账本，后者给 var pool）。
    expect(iv._phase_index).toBe("2")
    expect(iv._round_index).toBe("1")
    expect([launchedRow(taskId).phase_index, launchedRow(taskId).round_index]).toEqual([2, 1])
  })

  it("注入不重写作者的绑定：task_spec.phases[] 逐字段原样", async () => {
    const { taskId, specDirs } = seed({ handoffs: { 1: "h" } })
    const before = specPhasesOf(taskId)
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    // 先确认派发真的发生了 —— 否则「绑定没被改写」会因为什么都没做而空过。
    expect(res.status, await res.clone().text()).toBe(200)
    const after = specPhasesOf(taskId)
    // 票03 之后 phases[] 是绑定的唯一存放处 —— 旧版「信封冻结面不被改写」的同一条
    // K16 纪律，换了对象：派发（含注入）绝不回写 task_spec。
    expect(after).toEqual(before)
    expect(after[0].slug).toBe("p1")
    expect(after[0].specPath).toBe(path.join(batchRel("p1"), "spec.md"))
    void specDirs
  })
})

describe("AC2 — 存在性过滤 / 全空不注入键", () => {
  it("前序无 handoff.md → 键完全不出现，input_values 与基线键集一致", async () => {
    const { taskId } = seed()
    const res = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status, await res.clone().text()).toBe(200)
    const iv = launchedIV(taskId)
    expect("prev_handoff_paths" in iv).toBe(false)
    // phase.inputValues 为 {} ⇒ 基线只有「轮次 stamps + $vars 管理键」。管理键是
    // buildTaskLaunchConfig 对 v4 也注入的(D14/ADR-0018:工作流用 $vars.task_artifacts_dir
    // / task_workflows_dir),信封时代同样如此 —— 本条要钉的是交接注入**没有多加任何键**。
    expect(Object.keys(iv).sort()).toEqual([
      "_phase_index",
      "_round_index",
      "task_artifacts_dir",
      "task_workflows_dir",
    ])
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
    const iv = launchedIV(taskId)
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
    const iv = launchedIV(taskId)
    expect("prev_handoff_paths" in iv).toBe(false)
    // 既有信道不受影响：feedback + stamps 原样。
    expect(iv.feedback).toBe("接口漏了分页")
    expect(iv._phase_index).toBe("2")
    expect(iv._round_index).toBe("2")
    expect([launchedRow(taskId).phase_index, launchedRow(taskId).round_index]).toEqual([2, 2])
  })

  it("两个 accepted 前序（1+2）→ 开 phase3 首轮见两行、index 升序", async () => {
    const { taskId, specDirs } = seed({
      phases: THREE_PHASES,
      status: "ready", // autoAdvance=false 的合法落点：人在人工闸前，卡片就是已入队
      autoAdvance: false, // phase1/2 已 accepted ⇒ 停在人工闸，由 advance 起 phase3
      ledger: [
        { phase_index: 1, round_index: 1, decision: "accepted" },
        { phase_index: 2, round_index: 1, decision: "accepted" },
      ],
      roundsByPhase: { 1: [{ round: 1, status: "completed" }], 2: [{ round: 1, status: "completed" }] },
      handoffs: { 1: "one", 2: "two" },
    })
    const res = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(res.status, await res.clone().text()).toBe(200)
    const value = launchedIV(taskId).prev_handoff_paths
    expect(value.split("\n")).toEqual([handoffPathOf(specDirs, 1), handoffPathOf(specDirs, 2)])
  })
})

// review-cycle-1（Completeness-C8）：存在性过滤的两个边界 —— 目录形态与同批次去重。
describe("边界硬化 — handoff.md 非文件不算交接；同 specDir 去重", () => {
  it("前序 handoff.md 位是目录（异常形态）→ isFile 过滤，键不出现", async () => {
    // 卡片 ready + phase1 已 accepted（人工闸后的世界）⇒ advance 起 phase2 首轮。
    const { taskId, specDirs } = seed({
      status: "ready",
      ledger: [{ phase_index: 1, round_index: 1, decision: "accepted" }],
    })
    // 不写文件，改在 handoff.md 期望位建目录（existsSync 会放行、isFile 必须挡下）。
    fs.rmSync(handoffPathOf(specDirs, 1), { force: true })
    fs.mkdirSync(handoffPathOf(specDirs, 1), { recursive: true })
    const res = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(res.status, await res.clone().text()).toBe(200)
    expect("prev_handoff_paths" in launchedIV(taskId)).toBe(false)
  })

  it("两个 accepted 前序共享同一批次目录（同 slug）→ 注入去重，只出现一行", async () => {
    const shared: PhaseDef[] = [
      { index: 1, name: "Phase 1", slug: "p1", workflowRef: "built-in/flow-p1" },
      { index: 2, name: "Phase 2", slug: "p1", workflowRef: "built-in/flow-p2" },
      { index: 3, name: "Phase 3", slug: "p3", workflowRef: "built-in/flow-p3" },
    ]
    const { taskId, specDirs } = seed({
      phases: shared,
      status: "ready",
      autoAdvance: false, // 同上：accepted×2 ∧ phase3 pending ⇒ 人工 advance 起轮
      ledger: [
        { phase_index: 1, round_index: 1, decision: "accepted" },
        { phase_index: 2, round_index: 1, decision: "accepted" },
      ],
      roundsByPhase: { 1: [{ round: 1, status: "completed" }], 2: [{ round: 1, status: "completed" }] },
      handoffs: { 1: "one" }, // 同目录 ⇒ phase2 的 handoff 位即同一文件
    })
    const res = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(launchedIV(taskId).prev_handoff_paths.split("\n"))
      .toEqual([handoffPathOf(specDirs, 1)])
  })
})

describe("AC4 — 手动推进与 autoAdvance 行为一致", () => {
  it("autoAdvance=false 停闸 → /advance 起 phase2 首轮，注入值与 auto 路径同形", async () => {
    const { taskId, specDirs } = seed({ autoAdvance: false, handoffs: { 1: "h1" } })
    const parked = await postAcceptance(taskId, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(parked.status, await parked.clone().text()).toBe(200)
    expect(((await parked.json()) as { next_action: string }).next_action).toBe("awaiting_manual_trigger")
    // 未派发 ⇒ 没有任何注入发生（最新一行仍是那轮终态行，键不在其上）。
    expect("prev_handoff_paths" in launchedIV(taskId)).toBe(false)

    const adv = await app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
    expect(adv.status, await adv.clone().text()).toBe(200)
    const body = (await adv.json()) as { next_action: string; dispatch: Record<string, unknown> }
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch).toMatchObject({ phase_index: 2, round_index: 1 })
    // 与 AC1 auto 路径同值：同一判定源 ⇒ 同一 home 绝对路径。
    expect(launchedIV(taskId).prev_handoff_paths).toBe(handoffPathOf(specDirs, 1))
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
    // 末 phase accepted → 不开新轮 ⇒ 最新行仍是那轮终态行，键不泄漏。
    expect(stubService.create).not.toHaveBeenCalled()
    expect("prev_handoff_paths" in launchedIV(taskId)).toBe(false)
  })
})
