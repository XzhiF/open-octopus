// packages/server/src/services/tasks/__tests__/archive-ingest.test.ts
//
// 知识中心票10 — 归档自动投喂（S1 服务层环级测试，spec Testing Decisions「归档投喂」行）。
//
// Seam（全部既有缝，零新缝）：
//   * ArchiveIngestService.ingestTask(taskId) — 一次 LLM 调用（summarize seam mock 捕获）
//     → raw/archives/task-{id}-summary.md 冻结（票02 同契约：front-matter hash/origin）
//     → wikiWriteQueue.enqueue("archive-compile")（走锁，compile seam 整包）。
//   * TasksService.beginArchiving（经 acceptance API 末 phase accepted 真入口）—
//     archiveIngestHook 触发与失败吞掉（不阻塞 done 判定语义）。
//
// 真 fs+tmpdir（知识根 / task home），内存 sqlite + applySchema，R1-R7 诚实 fixture。
// 基线红档案与本文件无关（不碰 archive-routes/clone-file-mgmt）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { applySchema } from "../../../db/schema"
import { SSEService } from "../../sse"
import { TasksService } from "../tasks-service"
import { createTasksRoutes } from "../../../routes/tasks"
import { TaskHomeService } from "../task-home-service"
import { RawIngestService } from "../../knowledge/raw"
import { CompileQueue } from "../../knowledge/wiki/compile-queue"
import {
  ArchiveIngestService,
  archiveCompileTaskId,
  archiveSummaryFileName,
  type ArchiveIngestDeps,
} from "../archive-ingest-service"

// 归档流程派单面不触达执行服务（末 phase accepted 无 dispatch），mock 只为把
// tasks 域装配从真注册表隔开（tasks-v4-acceptance 同族纪律）。
vi.mock("../../execution-service-registry", () => ({
  getExecutionService: () => undefined,
}))

// ── Harness ──────────────────────────────────────────────────────────

let tmpRoot: string
let knowledgeRoot: string
let db: Database.Database

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kc-t10-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  db = new Database(":memory:")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

interface SeedOpts {
  /** phase 计划（v4 spec）；默认两个 phase。 */
  phases?: Array<{ index: number; name: string; slug: string }>
  /** 验收账本行。 */
  ledger?: Array<{ phase_index: number; round_index: number; decision: string; feedback?: string }>
  /** home docs/adr 草稿件（关键决策素材）。 */
  adrs?: Array<{ file: string; content: string }>
  /** home context-notes.md 内容。 */
  contextNotes?: string
  /** 持久化状态（流程 fixture 用 'running'，默认 'archiving'）。 */
  status?: string
  /** true ⇒ 铺「末 phase 一轮已终态未验收」的读模型（executions 行 + batch spec.md）。 */
  awaiting?: boolean
}

let taskSeq = 0

/** v4 任务最小诚实 fixture：tasks 行 + 账本行 + 真 task home（ADR/context-notes）。 */
function seedV4Task(taskHome: TaskHomeService, opts: SeedOpts = {}): { taskId: string; home: string } {
  const taskId = `kc10-task-${taskSeq++}`
  const phases = opts.phases ?? [
    { index: 1, name: "登录改造", slug: "login" },
    { index: 2, name: "回归收尾", slug: "wrap" },
  ]
  const now = new Date().toISOString()
  const home = taskHome.homePath(taskId)
  for (const adr of opts.adrs ?? []) {
    const abs = path.join(home, "docs", "adr", adr.file)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, adr.content, "utf-8")
  }
  if (opts.contextNotes !== undefined) fs.writeFileSync(path.join(home, "context-notes.md"), opts.contextNotes, "utf-8")

  const spec = {
    format: "v4",
    goal: "把登录流程改为 session 制，支持踢下线",
    ac: ["登录成功写 session", "后台可强制下线"],
    decisions: ["D1: 采用服务端 session 而非 JWT"],
    branch: "feat-login-session-20261013",
    phases: phases.map((p) => ({ index: p.index, name: p.name, slug: p.slug, specPath: `./.scratch/kc10/${p.slug}/spec.md`, workflowRef: "built-in/task-dev", inputValues: {} })),
  }
  const workspaceId = opts.awaiting ? `kc10-ws-${taskSeq}` : null
  if (workspaceId) {
    const wsPath = path.join(tmpRoot, "ws", workspaceId)
    fs.mkdirSync(wsPath, { recursive: true })
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'task', 'active', ?, datetime('now'), datetime('now'))",
    ).run(workspaceId, `task:${taskId}`, "kc10-org", wsPath, taskId)
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '["authsvc"]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, "kc10-org", `踢下线改造 ${taskId}`, opts.status ?? "archiving", JSON.stringify(spec), now, now, workspaceId)
  for (const row of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(`kc10-acc-${taskId}-${row.phase_index}-${row.round_index}`, taskId, row.phase_index, row.round_index, row.decision, row.feedback ?? null)
  }
  if (opts.awaiting) {
    for (const p of phases) {
      const dir = path.join(home, ".scratch", "kc10", p.slug)
      fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
      fs.writeFileSync(path.join(dir, "spec.md"), `# ${p.name}\n`, "utf-8")
    }
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index, completed_at)
       VALUES (?, ?, '0', 0, ?, ?, 'completed', '{}', '{}', ?, datetime('now'), datetime('now'), ?, ?, 1, datetime('now'))`,
    ).run(`kc10-exec-${taskId}`, workspaceId, phases[0].slug, phases[0].slug, "kc10-org", taskId, phases[0].index)
  }
  return { taskId, home }
}

/** 独立真相源的总结 fixture（票 AC1 四段形态，手工样例非实现反推）。 */
const SUMMARY_FIXTURE = [
  "# 踢下线改造 — 归档总结",
  "",
  "## 验收台账",
  "- phase 1「登录改造」round 1 accepted",
  "- phase 2「回归收尾」round 1 打回一次（session 过期未清 cookie），round 2 accepted",
  "",
  "## 关键决策",
  "- 服务端 session 替代 JWT（ADR 0001）",
  "",
  "## 踩坑",
  "- 强制下线漏清 cookie → 验收打回，修复后 E2E 通过",
  "",
  "## 产出指针",
  "- 分支 feat-login-session-20261013；项目 authsvc；home docs/adr/0001-use-session.md",
  "",
].join("\n")

function makeDeps(overrides: Partial<ArchiveIngestDeps> = {}) {
  const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
  const rawIngest = new RawIngestService({ root: knowledgeRoot })
  const queue = new CompileQueue()
  const calls: Array<{ prompt: string }> = []
  const compiled: string[] = []
  const deps: ArchiveIngestDeps = {
    db,
    taskHomeService: taskHome,
    rawIngest,
    queue,
    compile: async (raw) => {
      compiled.push(raw.path)
    },
    summarize: async (prompt) => {
      calls.push({ prompt })
      return SUMMARY_FIXTURE
    },
    ...overrides,
  }
  return { deps, service: new ArchiveIngestService(deps), taskHome, queue, calls, compiled }
}

// ── Slice 2：编译入队（AC2 — archive-compile kind + 走锁 + 异步）────

/** 队列泵在 setImmediate 上起跑；测试需要一个显式的排空汇合点（轮询终态）。 */
async function settleQueue(queue: CompileQueue, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const t = queue.get(taskId)
    if (t && (t.state === "committed" || t.state === "failed")) return t
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`queue task ${taskId} did not settle`)
}

describe("归档编译入全局串行队列（AC2）", () => {
  it("落 raw 后入队 kind=archive-compile、id=arc-{taskId}、label=raw 路径；编译在队列内执行且带锁", async () => {
    const acquired: Array<{ opKind: string; taskId: string }> = []
    let released = 0
    const fakeLock = {
      acquire: async (meta: { opKind: string; taskId: string }) => {
        acquired.push(meta)
        return () => { released++ }
      },
    }
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome)
    const queue = new CompileQueue({ lock: fakeLock })
    const rawIngest = new RawIngestService({ root: knowledgeRoot })
    const compiled: Array<{ path: string; hash: string }> = []
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest,
      queue,
      compile: async (raw) => { compiled.push({ path: raw.path, hash: raw.hash }) },
      summarize: async () => SUMMARY_FIXTURE,
    })

    const outcome = await service.ingestTask(taskId)
    expect(outcome.status).toBe("ingested")

    // 队列视图：kind/id/label 三项契约（GET /queue/task/arc-{id} 的可查面）
    const view = queue.get(archiveCompileTaskId(taskId))!
    expect(view).toBeTruthy()
    expect(view.opKind).toBe("archive-compile")
    expect(view.label).toBe(`raw/archives/${archiveSummaryFileName(taskId)}`)

    const settled = await settleQueue(queue, archiveCompileTaskId(taskId))
    expect(settled.state).toBe("committed")
    // 走锁（票06 两级机制的进程内级由队列持锁；编译整包在锁后执行）
    expect(acquired).toEqual([{ opKind: "archive-compile", taskId: archiveCompileTaskId(taskId) }])
    expect(released).toBe(1)
    // compile 收到的是冻结后的 RawPointer（路径 + hash 与落盘一致）
    expect(compiled).toHaveLength(1)
    expect(compiled[0].path).toBe(`raw/archives/${archiveSummaryFileName(taskId)}`)
    expect(compiled[0].hash).toBe(outcome.rawHash)
  })

  it("编译慢于投喂回执（异步解耦——ingestTask 不等编译完成）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome)
    const queue = new CompileQueue()
    let compileDone = false
    let releaseCompile: () => void = () => {}
    const gate = new Promise<void>((r) => { releaseCompile = r })
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      compile: async () => { await gate; compileDone = true },
      summarize: async () => SUMMARY_FIXTURE,
    })

    const outcome = await service.ingestTask(taskId)
    // 回执返回时编译尚未完成（done 判定更不可能等它——归档与编译解耦）
    expect(outcome.status).toBe("ingested")
    expect(compileDone).toBe(false)
    expect(queue.get(archiveCompileTaskId(taskId))!.state).not.toBe("committed")
    releaseCompile()
    const settled = await settleQueue(queue, archiveCompileTaskId(taskId))
    expect(settled.state).toBe("committed")
    expect(compileDone).toBe(true)
  })
})

// ── Slice 3：同任务重归档幂等（AC1 尾注）─────────────────────────────

describe("重归档幂等（AC1）", () => {
  it("同任务二次 ingestTask：不调 LLM、不落第二份、不再入队，回 deduped 指针", async () => {
    const { service, taskHome, queue, calls, compiled } = makeDeps()
    const { taskId } = seedV4Task(taskHome)

    const first = await service.ingestTask(taskId)
    await settleQueue(queue, archiveCompileTaskId(taskId))
    expect(first.status).toBe("ingested")

    const second = await service.ingestTask(taskId)
    expect(second.status).toBe("deduped")
    expect(second.rawPath).toBe(first.rawPath)

    // LLM 只调过一次（幂等闸在 summarize 之前）
    expect(calls).toHaveLength(1)
    // raw 只有一份（钉名位无 -2 后缀孪生文件）
    const archivedDir = path.join(knowledgeRoot, "raw", "archives")
    expect(fs.readdirSync(archivedDir)).toEqual([`task-${taskId}-summary.md`])
    // 队列只有一条任务，且仍是第一次的 committed（无第二次入队）
    expect(queue.list()).toHaveLength(1)
    expect(compiled).toHaveLength(1)

    await settleQueue(queue, archiveCompileTaskId(taskId))
  })
})

// ── Slice 4：失败不阻塞（AC2 两路 + 离线闸）──────────────────────────

describe("投喂失败不阻塞归档（AC2）", () => {
  it("总结 LLM 抛错 ⇒ skipped（零落盘、零入队、永不向调用方抛错）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome)
    const queue = new CompileQueue()
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      compile: async () => {},
      summarize: async () => { throw new Error("provider exploded") },
    })

    await expect(service.ingestTask(taskId)).resolves.toEqual({ status: "skipped", reason: "SUMMARIZE_FAILED" })
    // 零痕迹：raw 不落半成品（票02 AC4 同律）、队列不参与
    expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", archiveSummaryFileName(taskId)))).toBe(false)
    expect(queue.list()).toHaveLength(0)
  })

  it("总结返回空串（离线闸/provider 缺席）⇒ skipped SUMMARIZE_EMPTY，归档照常", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome)
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue: new CompileQueue(),
      compile: async () => {},
      summarize: async () => "",
    })
    await expect(service.ingestTask(taskId)).resolves.toEqual({ status: "skipped", reason: "SUMMARIZE_EMPTY" })
  })

  it("编译抛错 ⇒ 队列记 failed、ingestTask 回执早已返回、raw 件保持冻结", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome)
    const queue = new CompileQueue()
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      compile: async () => { throw Object.assign(new Error("boom"), { code: "LLM_UNAVAILABLE" }) },
      summarize: async () => SUMMARY_FIXTURE,
    })

    const outcome = await service.ingestTask(taskId)
    expect(outcome.status).toBe("ingested")
    const settled = await settleQueue(queue, archiveCompileTaskId(taskId))
    expect(settled.state).toBe("failed")
    expect(settled.error?.code).toBe("LLM_UNAVAILABLE")
    // 编译失败不回滚投喂成果：raw 件仍在（幂等闸下次仍命中，不会重烧 LLM）
    expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", archiveSummaryFileName(taskId)))).toBe(true)
  })

  it("队列里一路 archive-compile 失败不堵死后续任务（票06 失败语义在此链路成立）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const first = seedV4Task(taskHome)
    const second = seedV4Task(taskHome)
    const queue = new CompileQueue()
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      // 按任务身份判成败（与队列调度时序无关的确定性 fixture）
      compile: async (raw) => {
        if (raw.path.includes(first.taskId)) throw new Error("first fails")
      },
      // 内容按任务 id 去重标记——同 hash 会被票02 幂等闸并成同一个源，破坏双任务前提
      summarize: async (prompt) => SUMMARY_FIXTURE + `\n- 素材对质号 ${/- task id: (\S+)/.exec(prompt)?.[1] ?? ""}\n`,
    })
    await service.ingestTask(first.taskId)
    await service.ingestTask(second.taskId)
    const s1 = await settleQueue(queue, archiveCompileTaskId(first.taskId))
    const s2 = await settleQueue(queue, archiveCompileTaskId(second.taskId))
    expect(s1.state).toBe("failed")
    expect(s2.state).toBe("committed")
  })
})

// ── Slice 5：总结 prompt 契约（AC1 四段素材，mock 捕获）──────────────

describe("总结 prompt 捕获（AC1 四段素材）", () => {
  it("prompt 恰调一次，含验收台账/关键决策/踩坑/产出指针四段指令与一手素材（账本反馈/ADR 正文/notes/分支）", async () => {
    const { service, taskHome, calls } = makeDeps()
    const { taskId } = seedV4Task(taskHome, {
      ledger: [
        { phase_index: 1, round_index: 1, decision: "accepted" },
        { phase_index: 2, round_index: 1, decision: "rejected", feedback: "session 过期未清 cookie" },
        { phase_index: 2, round_index: 2, decision: "accepted" },
      ],
      adrs: [{ file: "0001-use-session.md", content: "# 决定：服务端 session\n\n替代 JWT，理由……\n" }],
      contextNotes: "## authsvc\n- **session**: 服务端会话记录",
    })

    await service.ingestTask(taskId)
    expect(calls).toHaveLength(1)
    const prompt = calls[0].prompt
    // 四段输出契约（票面措辞）
    for (const section of ["验收台账", "关键决策", "踩坑", "产出指针"]) {
      expect(prompt).toContain(`## ${section}`)
    }
    // 一手素材逐类在场（断言素材面而非实现反推）
    expect(prompt).toContain("session 过期未清 cookie") // 打回反馈 = 踩坑素材
    expect(prompt).toContain("# 决定：服务端 session") // ADR 正文 = 关键决策素材
    expect(prompt).toContain("服务端会话记录") // context-notes = 术语素材
    expect(prompt).toContain("feat-login-session-20261013") // 产出指针：分支
    expect(prompt).toContain("authsvc") // 产出指针：项目
    expect(prompt).toContain(taskId)
    expect(prompt).toContain("踢下线改造") // 任务名
    expect(prompt).toContain("把登录流程改为 session 制") // goal
  })

  it("非 v4 任务/缺任务 ⇒ skipped，零 LLM 调用", async () => {
    const { service, taskHome, calls } = makeDeps()
    await expect(service.ingestTask("kc10-does-not-exist")).resolves.toMatchObject({ status: "skipped", reason: "TASK_NOT_FOUND" })
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
      VALUES ('kc10-v3-task', 'kc10-org', 'legacy v3', 'archiving', '{"goal":"x","ac":[]}', '[]', '[]', '[]', '[]', 1, datetime('now'), datetime('now'))
    `).run()
    await expect(service.ingestTask("kc10-v3-task")).resolves.toMatchObject({ status: "skipped", reason: "NOT_V4" })
    expect(calls).toHaveLength(0)
  })
})

// ── Slice 1：总结 fixture → raw 冻结落盘（票02 同契约）────────────────

describe("归档总结落 raw/archives（AC1）", () => {
  it("一次 LLM 调用产出的总结冻结落 raw/archives/task-{id}-summary.md，front-matter hash 与正文实算一致", async () => {
    const { service, taskHome } = makeDeps()
    const { taskId } = seedV4Task(taskHome)

    const outcome = await service.ingestTask(taskId)

    expect(outcome.status).toBe("ingested")
    expect(outcome.rawPath).toBe(`raw/archives/${archiveSummaryFileName(taskId)}`)

    const abs = path.join(knowledgeRoot, "raw", "archives", `task-${taskId}-summary.md`)
    expect(fs.existsSync(abs), `summary file must be frozen at ${abs}`).toBe(true)
    const file = fs.readFileSync(abs, "utf-8")
    // 票02 冻结契约：front-matter 五件套，正文原样 = LLM 产出（独立 fixture 对质）
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(file)
    expect(m, "raw file must carry front-matter").not.toBeNull()
    const header = m![1]
    expect(header).toContain(`origin: "task-archive:${taskId}"`)
    expect(outcome.rawHash).toBeDefined()
    const payload = file.slice(m![0].length)
    expect(payload).toBe(SUMMARY_FIXTURE)
    const recalc = crypto.createHash("sha256").update(payload, "utf-8").digest("hex")
    expect(header).toContain(`hash: "${recalc}"`)
    expect(outcome.rawHash).toBe(recalc)
  })
})

// ── Slice 6：挂载点 = beginArchiving（AC2/AC5 流程面，不碰 K11 本体）──

describe("archiving 态自动触发投喂（beginArchiving 挂载点）", () => {
  function flowSetup(ingestHook: (taskId: string) => void | Promise<void>) {
    const sse = new SSEService()
    const svc = new TasksService(db, sse, undefined, new TaskHomeService(path.join(tmpRoot, "homes")))
    // 归档编排以替换钩子隔离（K11 本体另有回归套件，零触碰断言在彼处）
    const archiveCalls: string[] = []
    svc.setArchivingHook((id) => { archiveCalls.push(id) })
    svc.setArchiveIngestHook(ingestHook)
    const app = new Hono()
    app.route("/api/tasks", createTasksRoutes(svc, sse))
    return { svc, app, archiveCalls }
  }

  async function acceptLastPhase(app: Hono, taskId: string, phaseIndex: number) {
    return app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: phaseIndex, round_index: 1, decision: "accepted" }),
    })
  }

  function taskStatusRow(taskId: string) {
    return db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(taskId) as
      { status: string; completed_at: string | null }
  }

  it("末 phase accepted → 投喂钩子与归档钩子都触发；真投喂落 raw + 入队；状态停 archiving（done 仍只归归档编排）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome, {
      phases: [{ index: 1, name: "唯一 phase", slug: "only" }],
      status: "running",
      awaiting: true,
    })
    const queue = new CompileQueue()
    const ingest = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      compile: async () => {},
      summarize: async () => SUMMARY_FIXTURE,
    })
    const { svc, app, archiveCalls } = flowSetup((id) => void ingest.ingestTask(id))

    const res = await acceptLastPhase(app, taskId, 1)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { next_action: string }
    expect(body.next_action).toBe("archiving")
    expect(archiveCalls).toEqual([taskId])
    expect(taskStatusRow(taskId).status).toBe("archiving")
    // 投喂在 enter-archiving 一刻起跑（异步：等队列汇合点确认全链落定）
    const settled = await settleQueue(queue, archiveCompileTaskId(taskId))
    expect(settled.state).toBe("committed")
    expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", archiveSummaryFileName(taskId)))).toBe(true)
    // beginArchiving 只翻状态——done/completed_at 不归它管（K3 保险不松动）
    expect(taskStatusRow(taskId).completed_at).toBeNull()
    void svc
  })

  it("投喂钩子同步抛错 / 异步 reject ⇒ 归档流程照常（仍翻 archiving、仍触发归档钩子、响应 200）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))

    // 路 1：同步抛错
    const t1 = seedV4Task(taskHome, {
      phases: [{ index: 1, name: "P1", slug: "p1" }], status: "running", awaiting: true,
    })
    const s1 = flowSetup(() => { throw new Error("ingest boom") })
    const r1 = await acceptLastPhase(s1.app, t1.taskId, 1)
    expect(r1.status).toBe(200)
    expect(s1.archiveCalls).toEqual([t1.taskId])
    expect(taskStatusRow(t1.taskId).status).toBe("archiving")

    // 路 2：异步 reject（unhandledRejection 保险：catch 必须挂在 promise 上）
    const t2 = seedV4Task(taskHome, {
      phases: [{ index: 1, name: "P1", slug: "p1" }], status: "running", awaiting: true,
    })
    const s2 = flowSetup(async () => { await Promise.resolve(); throw new Error("ingest async boom") })
    const r2 = await acceptLastPhase(s2.app, t2.taskId, 1)
    expect(r2.status).toBe(200)
    expect(s2.archiveCalls).toEqual([t2.taskId])
    expect(taskStatusRow(t2.taskId).status).toBe("archiving")
    await new Promise((r) => setTimeout(r, 30)) // 让 rejection 回调落地（若有未捕获会炸测试）
  })

  it("未注入投喂钩子（测试/嵌入方缺省态）⇒ beginArchiving 行为与票08 现状逐字一致", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { taskId } = seedV4Task(taskHome, {
      phases: [{ index: 1, name: "P1", slug: "p1" }], status: "running", awaiting: true,
    })
    const sse = new SSEService()
    const svc = new TasksService(db, sse, undefined, taskHome)
    const archiveCalls: string[] = []
    svc.setArchivingHook((id) => { archiveCalls.push(id) })
    const app = new Hono()
    app.route("/api/tasks", createTasksRoutes(svc, sse))
    const res = await acceptLastPhase(app, taskId, 1)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(archiveCalls).toEqual([taskId])
    expect(taskStatusRow(taskId).status).toBe("archiving")
  })
})

// ── Slice 7：离线闸（OCTOPUS_KNOWLEDGE_LLM_DISABLED 同款兜底）────────

describe("离线闸兜底（AC3 精神：总结失败=跳过投喂，归档照常）", () => {
  it("OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 ⇒ 生产 summarizer 恒空串；经 ingestTask 收敛为 skipped，零落盘", async () => {
    const prev = process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
    process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = "1"
    try {
      const { createProductionArchiveSummarizer } = await import("../archive-ingest-llm")
      const summarizer = createProductionArchiveSummarizer()
      await expect(summarizer("anything")).resolves.toBe("")

      const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
      const { taskId } = seedV4Task(taskHome)
      const queue = new CompileQueue()
      const service = new ArchiveIngestService({
        db,
        taskHomeService: taskHome,
        rawIngest: new RawIngestService({ root: knowledgeRoot }),
        queue,
        compile: async () => {},
        summarize: summarizer,
      })
      const outcome = await service.ingestTask(taskId)
      expect(outcome).toEqual({ status: "skipped", reason: "SUMMARIZE_EMPTY" })
      expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", archiveSummaryFileName(taskId)))).toBe(false)
      expect(queue.list()).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
      else process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = prev
    }
  })
})
