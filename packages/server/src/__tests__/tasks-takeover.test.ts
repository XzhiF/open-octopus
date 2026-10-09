// packages/server/src/__tests__/tasks-takeover.test.ts
//
// taskboard-modal-v2 票08 — 人工接管聚合端点（三分支的服务端两条）。
//
//   POST /api/tasks/:id/takeover          ② 停流·接管：abort 绑定执行 → 执行行
//                                          takeover_at 标记 → doer 会话就绪。
//   POST /api/tasks/:id/takeover/deliver  「✓ 确认本 Round 交付 · 转待验收」：
//                                          takeover_delivered_at + 现场 HEAD 快照
//                                          进 end_commit_id —— 派生链随即放行 awaiting_review。
//   POST /api/tasks/:id/fix-round         ③ 派 task-fix（运行中·非验收决策）：
//                                          abort 当前轮 → fix-feedback-r{N+1}.md →
//                                          恒 built-in/task-fix 新轮派发；不写账本决策行。
//
// 期望值来源（防自证）：ADR-0025 三条后果（abort 不留 paused 半程 / 交付仍过 Gate /
// 无复检不加机器闸）+ spec.md 三分支段 + 票05 已钉的 fix 路由契约（override 只进
// workflow_chain，信封 phases[] 冻结 K16）。不测内部调用次序。
//
// 真 better-sqlite3 + applySchema + 真 tmp task home + stub 执行服务注册表
// （tasks-v4-pause-resume.test.ts 惯例）+ 真 TaskDoerService（01 现成，doer 会话
// 断言走它自己的读面）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { execFileSync } from "child_process"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskDoerService } from "../services/tasks/task-doer-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService } from "../services/tasks/round-evidence-service"
import { ChatService } from "../services/chat"
import { WorkspaceService } from "../services/workspace"
import { ChatDAO, WorkspaceDAO } from "../db/dao"
import { createTasksRoutes } from "../routes/tasks"
import { TASK_EXECUTION_EVENT } from "@octopus/shared"

const ORG = "e2e-tk"
const BATCH_DATE = "20261008"

// ── 执行服务注册表 stub（cancel 写真实终态行，与 ExecutionLifecycle.cancel 同形状）──

const stubCalls: string[] = []
let cancelBehavior: "success" | "fail" = "success"

const stubService = {
  cancel: vi.fn(async (id: string) => {
    stubCalls.push(`cancel:${id}`)
    if (cancelBehavior === "fail") {
      throw Object.assign(new Error("Cannot cancel in current status"), { status: 400 })
    }
    const now = new Date().toISOString()
    mockHooks.db!
      .prepare("UPDATE executions SET status='cancelled', completed_at=? WHERE id=?")
      .run(now, id)
    return mockHooks.db!.prepare("SELECT * FROM executions WHERE id=?").get(id)
  }),
  pause: vi.fn(async () => ({ success: true })),
  resume: vi.fn(async () => ({ success: true })),
  registerExternalCallbacks: vi.fn(),
  clearExternalCallbacks: vi.fn(),
  hasLiveEngine: () => false,
  create: vi.fn((_workspaceId: string, _input: Record<string, unknown>) => ({ id: "unused" })),
  start: vi.fn(async (_id: string) => {}),
}
const mockHooks: { db: Database.Database | null } = { db: null }

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = mockHooks.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    return ws ? { service: stubService, wsPath: ws.path } : undefined
  },
}))

// 派发路径（fix-round 的新轮）经 task-lifecycle armAndLaunch → 静态注册表拿执行服务，
// 与上面同一 stub。create 落真实 pending 行，start 翻 running —— 镜像
// tasks-v4-acceptance.test.ts 的写法（读模型看的是真行）。
function seedLaunchRows() {
  stubService.create.mockImplementation((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-tk-exec-${launchSeq++}`
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
  })
  stubService.start.mockImplementation(async (id: string) => {
    mockHooks.db!
      .prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?")
      .run(id)
  })
}
let launchSeq = 0

const KNOWN_REFS = new Set(["built-in/flow-p1", "built-in/flow-p2", "built-in/task-fix"])
const builtInStub = {
  get: (ref: string) => (KNOWN_REFS.has(ref) ? { ref, content: "name: demo\nnodes: []\n", name: "demo" } : null),
} as never

// ── Fixture ────────────────────────────────────────────────────────

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

/** v4 两 phase 任务 + 绑定 ws + （可选）一轮真实形状的执行行。 */
function seed(opts: {
  rounds?: Array<{ phase: number; round: number; status: string }>
  taskStatus?: string
  autoAdvance?: boolean
} = {}) {
  const db = mockHooks.db!
  taskSeq += 1
  const taskId = `e2e-tk-task-${taskSeq}`
  const phases = [
    { index: 1, name: "Phase 1", slug: "p1", workflowRef: "built-in/flow-p1" },
    { index: 2, name: "Phase 2", slug: "p2", workflowRef: "built-in/flow-p2" },
  ]
  const now = new Date().toISOString()

  const home = taskHome.homePath(taskId)
  for (const p of phases) {
    const dir = path.join(home, ".scratch", BATCH_DATE, p.slug)
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# ${p.name} scope\n`)
  }

  const workspaceId = `e2e-tk-ws-${taskSeq}`
  const wsPath = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", `${taskId}-ws`)
  fs.mkdirSync(path.join(wsPath, "projects"), { recursive: true })
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'task', 'active', ?, datetime('now'), datetime('now'))",
  ).run(workspaceId, `task:${taskId}`, ORG, wsPath, taskId)

  const spec = {
    format: "v4",
    task_type: "coding",
    skill_groups: [],
    ...(opts.autoAdvance === undefined ? {} : { autoAdvance: opts.autoAdvance }),
    phases: phases.map((p) => ({
      index: p.index, name: p.name, slug: p.slug,
      specPath: path.join(".scratch", BATCH_DATE, p.slug, "spec.md"),
      workflowRef: p.workflowRef, inputValues: {},
    })),
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_TK ${taskId}`, opts.taskStatus ?? "running", JSON.stringify(spec), now, now, workspaceId)

  const execIds: Record<string, string> = {}
  for (const r of opts.rounds ?? [{ phase: 1, round: 1, status: "running" }]) {
    const execId = `e2e-tk-exec-seeded-${taskSeq}-${r.phase}-${r.round}`
    execIds[`${r.phase}:${r.round}`] = execId
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index, start_commit_id)
       VALUES (?, ?, '0', 0, ?, ?, ?, '{}', '{}', ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`,
    ).run(
      execId, workspaceId, `built-in/flow-p${r.phase}`, `built-in/flow-p${r.phase}`, r.status, ORG,
      taskId, r.phase, r.round, JSON.stringify({ app: "deadbeef00000000000000000000000000000000" }),
    )
  }

  return { taskId, workspaceId, wsPath, home, execIds }
}

function execRow(execId: string): Record<string, unknown> {
  return mockHooks.db!.prepare("SELECT * FROM executions WHERE id = ?").get(execId) as Record<string, unknown>
}
function taskRow(id: string): Record<string, unknown> {
  return mockHooks.db!.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>
}
function derived(taskId: string) {
  return service.getTask(taskId).derived
}
function ledgerRows(taskId: string): Array<Record<string, unknown>> {
  return mockHooks.db!
    .prepare("SELECT * FROM task_phase_acceptances WHERE task_id = ?")
    .all(taskId) as Array<Record<string, unknown>>
}

// ── Suite ──────────────────────────────────────────────────────────

let db: Database.Database
let sse: SSEService
let service: TasksService
let doer: TaskDoerService
let app: Hono
let taskHome: TaskHomeService
let sseEvents: Array<{ event: string; data: Record<string, unknown> }>

async function post(pathname: string, body?: Record<string, unknown>) {
  return app.request(`/api/tasks/${pathname}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  db = newDb()
  mockHooks.db = db
  taskSeq = 0
  launchSeq = 0
  stubCalls.length = 0
  cancelBehavior = "success"
  vi.clearAllMocks()
  seedLaunchRows()
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tk-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  sse = new SSEService()
  sseEvents = []
  sse.subscribe("taskpool", (e) => sseEvents.push({ event: e.event, data: e.data as Record<string, unknown> }))
  const wsSvc = new WorkspaceService(new WorkspaceDAO(db))
  service = new TasksService(
    db, sse, undefined, taskHome, undefined, builtInStub, null, wsSvc,
  )
  doer = new TaskDoerService({
    db, sse, tasksService: service,
    chatService: new ChatService(new ChatDAO(db), sse),
    workspaceService: wsSvc, taskHomeService: taskHome,
  })
  const evidence = new RoundEvidenceService(db, sse, service, wsSvc, taskHome)
  app = new Hono().route("/api/tasks", createTasksRoutes(service, sse, undefined, evidence, doer))
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(fakeHome, { recursive: true, force: true })
  db.close()
})

// ── AC1 ② takeover：abort + 标记 + 会话，原子且不留 paused 半程 ──────────

describe("POST /:id/takeover — 停流·人工接管（ADR-0025）", () => {
  it("成功：绑定执行 cancelled（⏹ 现场保留）、takeover_at 落行、任务态仍 running、派生 takeover、doer 会话就绪", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    const execId = execIds["1:1"]

    const res = await post(`${taskId}/takeover`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    // abort 走的是执行服务既有 cancel 路径（节点终止、不回滚工作区 —— ⏹ 现场保留）。
    expect(stubCalls).toContain(`cancel:${execId}`)
    expect(execRow(execId).status).toBe("cancelled")
    // takeover 来源标记落执行行（最小落点；票09 台账读它）。
    expect(typeof execRow(execId).takeover_at).toBe("string")
    expect(execRow(execId).takeover_delivered_at).toBeNull()
    // 任务态 running(takeover)：持久行不动（无 paused 半程、无新 TaskStatus）。
    expect(taskRow(taskId).status).toBe("running")
    expect(derived(taskId).taskStatus).toBe("running")
    expect(derived(taskId).phaseViews[0].status).toBe("takeover")
    // 交付前 Gate 不开：待验收轮不存在。
    expect(derived(taskId).phaseViews[0].awaitingRound).toBeNull()

    // doer 会话就绪（01 的 ensureSession；「做」面指针落 tasks 行）。
    expect(body.session.session_id).toBeTruthy()
    expect(body.takeover.execution_id).toBe(execId)
    expect(body.takeover.phase_index).toBe(1)
    expect(body.takeover.round_index).toBe(1)
    expect(taskRow(taskId).doer_session_id).toBe(body.session.session_id)

    // 执行级 SSE 一帧（看板/壳折叠用）；无 task_status 帧（持久态未变）。
    const execs = sseEvents.filter((e) => e.event === TASK_EXECUTION_EVENT)
    expect(execs).toHaveLength(1)
    expect(execs[0].data).toMatchObject({ task_id: taskId, execution_id: execId, status: "cancelled" })
    expect(sseEvents.filter((e) => e.event === "task_status")).toHaveLength(0)
  })

  it("abort 失败 → 不产生接管态（执行仍 running、无标记、派生仍 running）", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    cancelBehavior = "fail"

    const res = await post(`${taskId}/takeover`)
    expect(res.status).toBe(409)
    const exec = execRow(execIds["1:1"])
    expect(exec.status).toBe("running")
    expect(exec.takeover_at).toBeNull()
    expect(derived(taskId).taskStatus).toBe("running")
    expect((await res.json()).error).toContain("接管未产生")
  })

  it("无在飞执行 = 409（待验收轮/已交付/排队中各说各话）", async () => {
    const noLive = seed({ rounds: [{ phase: 1, round: 1, status: "completed" }] })
    const res1 = await post(`${noLive.taskId}/takeover`)
    expect(res1.status).toBe(409)
    expect((await res1.json()).error).toContain("没有进行中的执行")

    const queued = seed({ rounds: [{ phase: 1, round: 1, status: "pending" }] })
    const res2 = await post(`${queued.taskId}/takeover`)
    expect(res2.status).toBe(409)
    expect((await res2.json()).error).toContain("排队")
  })

  it("二次接管 409（现场已在接管中，不再 abort 第二刀）", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    expect((await post(`${taskId}/takeover`)).status).toBe(200)
    const res = await post(`${taskId}/takeover`)
    expect(res.status).toBe(409)
    expect(stubCalls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1)
  })

  it("暂停的轮也可直接接管（不留 paused 半程 —— ADR-0025 反悔由修复轮覆盖）", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "paused" }] })
    expect((await post(`${taskId}/takeover`)).status).toBe(200)
    expect(execRow(execIds["1:1"]).status).toBe("cancelled")
    expect(derived(taskId).phaseViews[0].status).toBe("takeover")
  })

  it("未知任务 404", async () => {
    expect((await post("nope/takeover")).status).toBe(404)
  })
})

// ── 交付事件：接管轮进 awaiting_review（派生规则已钉，服务侧补钥匙）──────

describe("POST /:id/takeover/deliver — 确认本 Round 交付 · 转待验收", () => {
  it("交付后：takeover_delivered_at 落行 + 现场 HEAD 快照进 end_commit_id + 派生 awaiting_review（Gate 开门）", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)

    const res = await post(`${taskId}/takeover/deliver`)
    expect(res.status).toBe(200)
    const exec = execRow(execIds["1:1"])
    expect(typeof exec.takeover_delivered_at).toBe("string")
    // 交付即现场快照：end_commit_id 写成 JSON 映射（本 fixture 无真 git 仓 →
    // 逐仓诚实降级为空映射；真仓 HEAD 进映射的用例在 tasks-round-diff.test.ts）。
    expect(typeof exec.end_commit_id).toBe("string")
    expect(() => JSON.parse(String(exec.end_commit_id))).not.toThrow()
    // 接管件仍留 takeover_at —— 「自动复检未跑（接管件）」证据语义（票09 读这两列）。
    expect(exec.takeover_at).toBeTruthy()

    const view = derived(taskId)
    expect(view.phaseViews[0].status).toBe("awaiting_review")
    expect(view.phaseViews[0].awaitingRound).toBe(1)
    expect(view.taskStatus).toBe("awaiting_review")
  })

  it("交付即现场快照：接管期新落的 commit HEAD 进 end_commit_id（票09 台账/走查实物的锚）", async () => {
    const { taskId, execIds, wsPath } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    // 真 git 仓（tasks-round-diff 惯例）：接管前 k0，接管对话里快改落 k1。
    const repo = path.join(wsPath, "projects", "app")
    fs.mkdirSync(repo, { recursive: true })
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim()
    g("init", "-b", "main")
    g("config", "user.email", "t@t.io")
    g("config", "user.name", "T")
    fs.writeFileSync(path.join(repo, "f.txt"), "0\n")
    g("add", "-A"); g("commit", "-m", "k0")
    const k0 = g("rev-parse", "HEAD")
    // start 锚改指真仓（fixture 默认 deadbeef 占位；区间探针要求两端可达）。
    db.prepare("UPDATE executions SET start_commit_id = ? WHERE id = ?")
      .run(JSON.stringify({ app: k0 }), execIds["1:1"])
    await post(`${taskId}/takeover`)
    fs.writeFileSync(path.join(repo, "f.txt"), "0\ntakeover edit\n")
    g("add", "-A"); g("commit", "-m", "[quick-edit] 接管期快改")
    const head = g("rev-parse", "HEAD")

    // 停流未交付：round-diff 按 live 口径供接管轮（AC3 服务端半 —— 接管改动实时进「≡ 变更」）。
    const mid = (await (await app.request(`/api/tasks/${taskId}/round-diff`)).json()) as Record<string, unknown>
    expect(mid.available).toBe(true)
    expect((mid.repos as Array<{ name: string; commits: number }>).find((r) => r.name === "app")!.commits).toBe(1)

    const res = await post(`${taskId}/takeover/deliver`)
    expect(res.status).toBe(200)
    const ends = JSON.parse(String(execRow(execIds["1:1"]).end_commit_id)) as Record<string, string>
    // 期望值来自 git 本体（独立事实）：交付快照认的就是当时 HEAD。
    expect(ends.app).toBe(head)
    // 交付后轮走 awaiting 解析 —— round-diff 用这份存锚供货（不再漂移）。
    const diff = (await (await app.request(`/api/tasks/${taskId}/round-diff`)).json()) as Record<string, unknown>
    expect(diff.available).toBe(true)
    const repos = diff.repos as Array<{ name: string; commits: number }>
    expect(repos.find((r) => r.name === "app")!.commits).toBe(1) // k0..k1 之间只一枚快改 commit

    // 交付 = 时间点快照：交付后再落的 commit 不属于这件接管件（Gate 实物逐字不变）。
    fs.writeFileSync(path.join(repo, "f.txt"), "0\ntakeover edit\npost-delivery\n")
    g("add", "-A"); g("commit", "-m", "[quick-edit] 交付后补刀")
    const after = (await (await app.request(`/api/tasks/${taskId}/round-diff`)).json()) as Record<string, unknown>
    expect((after.repos as Array<{ name: string; commits: number }>).find((r) => r.name === "app")!.commits).toBe(1)
  })

  it("交付不写账本决策行（决策仍是人的通过/打回，交付只是来源事件）", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    await post(`${taskId}/takeover/deliver`)
    expect(ledgerRows(taskId)).toHaveLength(0)
  })

  it("无人接管中 → 409；重复交付 → 409", async () => {
    const plain = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    const res = await post(`${plain.taskId}/takeover/deliver`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("接管")

    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    expect((await post(`${taskId}/takeover/deliver`)).status).toBe(200)
    const res2 = await post(`${taskId}/takeover/deliver`)
    expect(res2.status).toBe(409)
  })

  it("AC5 接管件不加机器闸：交付后 acceptance accepted 正常放行（既有 ✗ 硬闸行为不变）", async () => {
    const { taskId } = seed({ autoAdvance: false, rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    await post(`${taskId}/takeover/deliver`)
    const res = await post(`${taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(res.status).toBe(200)
    // 交付前想直接验收 = Gate 未开（takeover 态不是 awaiting_review）。
    const again = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${again.taskId}/takeover`)
    const blocked = await post(`${again.taskId}/acceptance`, { phase_index: 1, round_index: 1, decision: "accepted" })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toContain("takeover")
  })
})

// ── 分支③：运行中改派 task-fix（恒修复轮，不写验收决策行）────────────────

describe("POST /:id/fix-round — 三分支 ③ / 接管中「改派 task-fix」", () => {
  it("运行中派 ③：abort 当前轮 → fix-feedback-r2.md 落批次目录 → 恒 task-fix 新轮 2 开跑；零账本行", async () => {
    const { taskId, execIds, home } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    const res = await post(`${taskId}/fix-round`, { instruction: "剩余收敛为：行号对齐 + hover 描边" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    expect(stubCalls).toContain(`cancel:${execIds["1:1"]}`)
    // 反馈产物化（复用 05 路由的落点约定：批次目录内 fix-feedback-rN.md）
    const fb = path.join(home, ".scratch", BATCH_DATE, "p1", "fix-feedback-r2.md")
    expect(fs.existsSync(fb)).toBe(true)
    expect(fs.readFileSync(fb, "utf-8")).toContain("行号对齐 + hover 描边")

    // 新轮 = 当前轮+1，恒 built-in/task-fix override + 合成输入。
    const execs = mockHooks.db!
      .prepare("SELECT * FROM executions WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as Array<Record<string, unknown>>
    const fix = execs[execs.length - 1]
    expect(fix.workflow_ref).toBe("built-in/task-fix")
    expect(fix.round_index).toBe(2)
    expect(fix.phase_index).toBe(1)
    const inputs = JSON.parse(String(fix.input_values)) as Record<string, string>
    expect(inputs.feedback).toContain("行号对齐")
    expect(inputs.feedback_path).toContain("fix-feedback-r2.md")
    expect(inputs.phase_spec_dir).toContain("p1")
    expect(body.dispatch.execution_id).toBe(fix.id)
    expect(body.dispatch.round_index).toBe(2)

    // 不写 acceptance 决策行（③ 是运行中决策，不是验收决策）。
    expect(ledgerRows(taskId)).toHaveLength(0)
    // K16：信封 phases[] 冻结不动（override 只进本轮 launch）。
    const spec = JSON.parse(String(taskRow(taskId).task_spec)) as { phases: Array<{ workflowRef: string }> }
    expect(spec.phases[0].workflowRef).toBe("built-in/flow-p1")
    // 盘面随即 = 修复轮在跑。
    expect(derived(taskId).taskStatus).toBe("running")
    expect(derived(taskId).phaseViews[0].status).toBe("running")
  })

  it("接管中改派（无 live 轮）：不重复 abort，直接派新轮 2；takeover 标记保留在原轮", async () => {
    const { taskId, execIds } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    const res = await post(`${taskId}/fix-round`, { instruction: "活不适合对话干，交通用流收尾" })
    expect(res.status).toBe(200)
    expect(stubCalls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1) // 只有接管那一刀
    expect(execRow(execIds["1:1"]).takeover_at).toBeTruthy()
    expect(execRow(execIds["1:1"]).takeover_delivered_at).toBeNull()
    expect(derived(taskId).phaseViews[0].status).toBe("running")
  })

  it("指令必填：缺失/空/纯空白 → 400；未知字段 strict → 400", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    expect((await post(`${taskId}/fix-round`, {})).status).toBe(400)
    expect((await post(`${taskId}/fix-round`, { instruction: "   " })).status).toBe(400)
    expect((await post(`${taskId}/fix-round`, { instruction: "x", phase_index: 1 })).status).toBe(400)
    // 被拒的请求没有派任何轮、没有 abort。
    const execs = mockHooks.db!.prepare("SELECT COUNT(*) n FROM executions WHERE task_id=?").get(taskId) as { n: number }
    expect(execs.n).toBe(1)
    expect(stubCalls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0)
  })

  it("待验收轮不走 ③（那是打回的领地）→ 409 指路", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "completed" }] })
    const res = await post(`${taskId}/fix-round`, { instruction: "试试直接派" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("打回")
  })

  it("接管交付后不走 ③（Gate 已开 —— 通过/打回各就各位）", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    await post(`${taskId}/takeover/deliver`)
    const res = await post(`${taskId}/fix-round`, { instruction: "回马枪" })
    expect(res.status).toBe(409)
  })
})

// ── 接管期间的变更供货（AC3 服务端半）────────────────────────────────────

describe("takeover 轮 = 变更页签可供货的现场（round-diff 解析补一支）", () => {
  // 解析规则本体在 round-evidence（tasks-round-diff.test.ts 真 git 面钉内容），
  // 这里只锁「无 awaiting、无 live、但有未交付 takeover 轮」时不再裸 409。
  it("停流未交付：round-diff 不再回「无待验收 round」—— 按 live 口径（end=HEAD）供货", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    const res = await app.request(`/api/tasks/${taskId}/round-diff`)
    // stub ws 无 git 仓 → 数据面诚实 available:false，但解析必须命中接管轮（非 409）。
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.available).toBe(false)
    expect(payload.reason).toBe("no_commits")
  })

  it("交付之后：awaiting 优先解析接管轮（既有规则，回归锁）", async () => {
    const { taskId } = seed({ rounds: [{ phase: 1, round: 1, status: "running" }] })
    await post(`${taskId}/takeover`)
    await post(`${taskId}/takeover/deliver`)
    const res = await app.request(`/api/tasks/${taskId}/round-diff`)
    expect(res.status).toBe(200)
  })
})
