// packages/server/src/services/tasks/__tests__/archive-material-pack.test.ts
//
// P3 票02 — 素材包持久化（S1 服务层环级测试；spec 故事 1-2/7，票面清单 1-2 行）。
//
// Seam（票面钉死 S1，零新缝）：ArchiveIngestService.ingestTask(taskId) —
//   素材包落盘（六件+manifest）→ 总结生成（读包）→ 总结作包内一件 → 入队编译（读包）。
// 真 fs+tmpdir（知识根 / task home / 真 git 仓），内存 sqlite + applySchema，
// summarize/compilePack seam mock。涉 git 用例按本机纪律用 PowerShell 跑
// （Git-Bash 下 gitconfig Permission denied 假红，仓库已知）。
// expected 真相源：spec §Implementation Decisions「素材包」+ 票 02 票面，非实现反推。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import crypto from "crypto"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { TaskHomeService } from "../task-home-service"
import { RawIngestService } from "../../knowledge/raw"
import { CompileQueue } from "../../knowledge/wiki/compile-queue"
import { ArchiveIngestService, type ArchiveIngestDeps } from "../archive-ingest-service"

// ── Harness（archive-ingest.test.ts 同族制式）─────────────────────────

let tmpRoot: string
let knowledgeRoot: string
let db: Database.Database

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa02-pack-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  db = new Database(":memory:")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

let taskSeq = 0

/** v4 任务最小诚实 fixture：tasks 行 + 账本行 + 真 task home（ADR/context-notes）。 */
function seedV4Task(taskHome: TaskHomeService, opts: {
  ledger?: Array<{ phase_index: number; round_index: number; decision: string; feedback?: string }>
  adrs?: Array<{ file: string; content: string }>
  contextNotes?: string
} = {}): { taskId: string; home: string } {
  const taskId = `aa02-task-${taskSeq++}`
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
    goal: "把登录流程改为 session 制",
    ac: ["登录成功写 session"],
    decisions: ["D1: 服务端 session"],
    branch: "feat-login-session-20261013",
    phases: [
      { index: 1, name: "登录改造", slug: "login" },
      { index: 2, name: "回归收尾", slug: "wrap" },
    ],
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, 'archiving', NULL, ?, '[]', '[]', '[]', '["authsvc"]', NULL, 1, NULL, ?, ?, NULL, NULL)
  `).run(taskId, "aa02-org", `踢下线改造 ${taskId}`, JSON.stringify(spec), now, now)
  for (const row of opts.ledger ?? []) {
    db.prepare(
      "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(`aa02-acc-${taskId}-${row.phase_index}-${row.round_index}`, taskId, row.phase_index, row.round_index, row.decision, row.feedback ?? null)
  }
  return { taskId, home }
}

const SUMMARY_FIXTURE = "# 归档总结\n\n## 踩坑\n- 强制下线漏清 cookie → 打回\n"

interface Captured {
  prompts: string[]
  compilePack: Array<{ taskId: string; opts: { focus?: string } | undefined }>
}

function makeDeps(overrides: Partial<ArchiveIngestDeps> = {}): { service: ArchiveIngestService; cap: Captured; queue: CompileQueue } {
  const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
  const queue = new CompileQueue()
  const cap: Captured = { prompts: [], compilePack: [] }
  const deps: ArchiveIngestDeps = {
    db,
    taskHomeService: taskHome,
    rawIngest: new RawIngestService({ root: knowledgeRoot }),
    queue,
    compilePack: async (taskId, opts) => { cap.compilePack.push({ taskId, opts }) },
    summarize: async (prompt) => { cap.prompts.push(prompt); return SUMMARY_FIXTURE },
    ...overrides,
  }
  return { service: new ArchiveIngestService(deps), cap, queue }
}

function readManifest(taskId: string): any {
  return JSON.parse(fs.readFileSync(path.join(knowledgeRoot, "raw", "archives", `task-${taskId}`, "manifest.json"), "utf-8"))
}

function itemPayload(rootFile: string): string {
  const file = fs.readFileSync(rootFile, "utf-8")
  const m = /^---\r?\n([\S\s]*?)\r?\n---\r?\n?/.exec(file)
  return m ? file.slice(m[0].length) : file
}

// ── Slice 1：素材包落盘契约（票面第 1 行）──────────────────────────────

describe("素材包整体落 raw/archives/task-{id}/（S1·票02）", () => {
  it("归档投喂落包目录 + manifest：六类素材件齐（验收台账/phase 打回/执行 JSONL 摘录/PR diff/matt 产物指针/ADR·context-notes），每件 kind/origin/path/bytes/sha256", async () => {
    const { service } = makeDeps()
    const { taskId } = seedV4Task(
      new TaskHomeService(path.join(tmpRoot, "homes")),
      {
        ledger: [
          { phase_index: 1, round_index: 1, decision: "accepted" },
          { phase_index: 2, round_index: 1, decision: "rejected", feedback: "session 过期未清 cookie" },
        ],
        adrs: [{ file: "0001-use-session.md", content: "# 决定：服务端 session\n" }],
        contextNotes: "- **session**: 服务端会话记录",
      },
    )

    const outcome = await service.ingestTask(taskId)
    expect(outcome.status).toBe("ingested")

    const manifest = readManifest(taskId)
    expect(manifest.v).toBe(1)
    expect(manifest.taskId).toBe(taskId)
    const kinds: string[] = manifest.items.map((i: any) => i.kind)
    // spec「素材包」契约六件逐字（总结是第七件，见下一例）
    for (const k of ["acceptance-ledger", "phase-rejections", "exec-jsonl-excerpt", "pr-diff", "matt-artifacts", "adr-context-notes"]) {
      expect(kinds, `素材件 ${k} 必须在包内`).toContain(k)
    }
    // 旧单文件钉名不再产生（总结降级为包内一件，不迁移不并存）
    expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", `task-${taskId}-summary.md`))).toBe(false)
  })

  it("每件 hash 冻结契约与既有单文件 raw 一致：front-matter 五件套，manifest.sha256 = 正文实算 sha256，bytes 对得上；origin 可定位回源", async () => {
    const { service } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")), {
      ledger: [{ phase_index: 2, round_index: 1, decision: "rejected", feedback: "cookie 未清" }],
    })
    await service.ingestTask(taskId)

    const manifest = readManifest(taskId)
    for (const item of manifest.items) {
      // path = 知识根相对 POSIX，且在包目录内
      expect(item.path.startsWith(`raw/archives/task-${taskId}/`)).toBe(true)
      const abs = path.join(knowledgeRoot, item.path)
      expect(fs.existsSync(abs), `件 ${item.kind} 必须在盘`).toBe(true)

      const file = fs.readFileSync(abs, "utf-8")
      const m = /^---\r?\n([\S\s]*?)\r?\n---\r?\n?/.exec(file)
      expect(m, `${item.kind} 必须带 raw front-matter（冻结契约同单文件通道）`).not.toBeNull()
      const header = m![1]
      const payload = file.slice(m![0].length)
      // 五件套 origin/title/ingestedAt/bytes/hash
      for (const key of ["origin", "title", "ingestedAt", "bytes", "hash"]) {
        expect(header).toContain(`${key}:`)
      }
      expect(Buffer.byteLength(payload, "utf-8")).toBe(item.bytes)
      expect(crypto.createHash("sha256").update(payload, "utf-8").digest("hex")).toBe(item.sha256)
      expect(header).toContain(`hash: "${item.sha256}"`)
      expect(header).toContain(`origin: "${item.origin}"`)
      // origin 可定位（spec 故事2 溯源链）：六类源素材=源型前缀（db/task-home/exec/git），
      // 总结件=派生源标记 task-archive:（票10 既有 origin 标延续）
      expect(item.origin).toContain(taskId)
      if (item.kind === "archive-summary") {
        expect(item.origin).toBe(`task-archive:${taskId}`)
      } else {
        expect(item.origin).toMatch(/^(db|task-home|exec|git):/)
      }
    }
  })

  it("总结生成读包：summarize prompt 含包内一手素材（打回反馈/ADR 正文/context-notes 逐类在场，来自刚落盘的件）；总结冻结为包内第七件 archive-summary", async () => {
    const { service, cap } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")), {
      ledger: [{ phase_index: 2, round_index: 1, decision: "rejected", feedback: "session 过期未清 cookie" }],
      adrs: [{ file: "0001.md", content: "# 决定：服务端 session 替代 JWT" }],
      contextNotes: "服务端会话记录",
    })

    const outcome = await service.ingestTask(taskId)
    expect(cap.prompts).toHaveLength(1)
    const prompt = cap.prompts[0]
    expect(prompt).toContain("session 过期未清 cookie")
    expect(prompt).toContain("# 决定：服务端 session 替代 JWT")
    expect(prompt).toContain("服务端会话记录")
    // 读包：prompt 里素材以包件形态出现（manifest 清单行含包内路径）
    expect(prompt).toContain(`raw/archives/task-${taskId}/`)

    const manifest = readManifest(taskId)
    const summary = manifest.items.find((i: any) => i.kind === "archive-summary")
    expect(summary, "总结降级为包内一件").toBeTruthy()
    expect(itemPayload(path.join(knowledgeRoot, summary.path))).toBe(SUMMARY_FIXTURE)
    expect(outcome.rawPath).toBe(summary.path)
    expect(outcome.rawHash).toBe(summary.sha256)
  })

  it("入队编译读包：archive-compile kind、id=arc-{taskId}、编译入口收 taskId+焦点缺省（compilePack seam）", async () => {
    const { service, cap, queue } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    const outcome = await service.ingestTask(taskId)

    expect(outcome.queueTaskId).toBe(`arc-${taskId}`)
    const view = queue.get(`arc-${taskId}`)!
    expect(view.opKind).toBe("archive-compile")
    expect(view.label).toBe(`raw/archives/task-${taskId}/manifest.json`)
    for (let i = 0; i < 200 && !cap.compilePack.length; i++) await new Promise((r) => setTimeout(r, 5))
    expect(cap.compilePack).toEqual([{ taskId, opts: undefined }])
  })

  it("素材包卡通告（Lane A 生产者 seam）：包冻结+入队后 emit material-pack 卡事件（件清单=名/类/大小，id=mdp-{taskId}）；通告失败不毁回执", async () => {
    const announced: any[] = []
    const { service } = makeDeps({ announcePack: (ev) => { announced.push(ev) } })
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")), {
      ledger: [{ phase_index: 2, round_index: 1, decision: "rejected", feedback: "cookie 未清" }],
    })
    const outcome = await service.ingestTask(taskId)
    expect(outcome.status).toBe("ingested")

    expect(announced).toHaveLength(1)
    const ev = announced[0]
    expect(ev.id).toBe(`mdp-${taskId}`)
    expect(ev.kind).toBe("material-pack")
    expect(ev.data.taskId).toBe(taskId)
    expect(ev.data.packPath).toBe(`raw/archives/task-${taskId}`)
    expect(ev.data.summaryIncluded).toBe(true)
    expect(ev.data.queueTaskId).toBe(`arc-${taskId}`)
    // 件清单（票面「名/类/大小」）：7 件齐（六素材 + 总结）
    expect(ev.data.items).toHaveLength(7)
    const ledgerView = ev.data.items.find((i: any) => i.kind === "acceptance-ledger")
    expect(ledgerView.name).toBe("验收台账")
    expect(ledgerView.bytes).toBeGreaterThan(0)
    expect(ledgerView.path).toMatch(/^raw\/archives\/task-/)

    // 通告炸了（无知识中心会话/DAO 抖动）⇒ 投喂回执照常（失败语义不破）
    const { service: s2 } = makeDeps({ announcePack: () => { throw new Error("session exploded") } })
    const { taskId: t2 } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    await expect(s2.ingestTask(t2)).resolves.toMatchObject({ status: "ingested" })
  })

  it("总结失败 ⇒ skipped 且不产卡（包在、编译不投，素材卡留待重投时通告）", async () => {
    const announced: any[] = []
    const { service } = makeDeps({ announcePack: (ev) => announced.push(ev), summarize: async () => "" })
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    const outcome = await service.ingestTask(taskId)
    expect(outcome).toEqual({ status: "skipped", reason: "SUMMARIZE_EMPTY" })
    expect(announced).toHaveLength(0)
  })
})

// ── Slice 2：摘录纪律（票面第 2 行 / 故事7）───────────────────────────

/** 真 git 仓 fixture（本文件涉 git ⇒ 按纪律用 PowerShell 跑，Git-Bash 有 gitconfig 假红史）。 */
function makeGitRepo(dir: string): { start: string; end: string } {
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=aa02", "-c", "user.email=aa02@test", ...args], { cwd: dir, encoding: "utf-8" })
  git("init", "-b", "main")
  fs.writeFileSync(path.join(dir, "login.ts"), "export function login() { return old }\n", "utf-8")
  fs.writeFileSync(path.join(dir, "README.md"), "# authsvc\n", "utf-8")
  git("add", "-A")
  git("commit", "-m", "init")
  const start = git("rev-parse", "HEAD").trim()
  fs.writeFileSync(path.join(dir, "login.ts"), "export function login(user: string) {\n  const s = createSession(user)\n  db.save(s)\n  return s\n}\n", "utf-8")
  fs.writeFileSync(path.join(dir, "README.md"), "# authsvc\n\nsession 制。\n", "utf-8")
  git("add", "-A")
  git("commit", "-m", "feat: session 制登录")
  const end = git("rev-parse", "HEAD").trim()
  return { start, end }
}

/** 执行 JSONL fixture：关键事件（error/tool 失败/重试/fix-commit）+ 噪声行（不得进摘录）。 */
function seedExecLog(wsPath: string, execId: string): void {
  const logDir = path.join(wsPath, "logs", execId)
  fs.mkdirSync(logDir, { recursive: true })
  const lines = [
    { timestamp: "2026-10-14T01:00:00Z", nodeId: "do-task", event: "start" },
    { timestamp: "2026-10-14T01:00:10Z", nodeId: "do-task", event: "node_log", message: "例行进度噪声AAA" },
    { timestamp: "2026-10-14T01:00:20Z", nodeId: "do-task", event: "error", error: "登录接口 500：cookie 未清" },
    { timestamp: "2026-10-14T01:00:30Z", nodeId: "do-task", event: "tool_call", toolName: "Bash", isError: true, input: { command: "pnpm test" }, result: "FAIL 3 tests" },
    { timestamp: "2026-10-14T01:00:40Z", nodeId: "do-task", event: "text_delta", text: "无关正文噪声CCC" },
    { timestamp: "2026-10-14T01:00:50Z", nodeId: "do-task", event: "end" },
    { timestamp: "2026-10-14T01:01:00Z", nodeId: "do-task", event: "start" }, // 重试 ⇒ 同节点二次 start
    { timestamp: "2026-10-14T01:01:30Z", nodeId: "do-task", event: "bash_log", output: "git commit -m 'fix: 补 cookie 清理'" },
    { timestamp: "2026-10-14T01:02:00Z", nodeId: "do-task", event: "end" },
  ]
  fs.writeFileSync(path.join(logDir, "do-task.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf-8")
}

function seedExecution(f: { taskId: string; wsId: string; wsPath: string; start: string; end: string; execId: string }): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, 'aa02-org', ?, 'task', 'archived', ?, datetime('now'), datetime('now'))",
  ).run(f.wsId, `task:${f.taskId}`, f.wsPath, f.taskId)
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index, completed_at,
      start_commit_id, end_commit_id)
    VALUES (?, ?, '0', 0, 'login', 'task-dev', 'completed', '{}', '{}', 'aa02-org', datetime('now'), datetime('now'), ?, 1, 1, datetime('now'), ?, ?)
  `).run(f.execId, f.wsId, f.taskId, JSON.stringify({ authsvc: f.start }), JSON.stringify({ authsvc: f.end }))
}

describe("摘录纪律（S1·票02 第2行/故事7）", () => {
  it("执行 JSONL 摘录 = 关键事件提取（error/tool 失败/retry 节点/fix-commit 进摘录；噪声行不进）+ exec 指针可回源全量", async () => {
    const { service } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    const wsPath = path.join(tmpRoot, "ws", "w1")
    seedExecution({ taskId, wsId: "aa02-ws-1", wsPath, start: "0000000000000000000000000000000000000000", end: "1111111111111111111111111111111111111111", execId: "aa02-exec-1" })
    seedExecLog(wsPath, "aa02-exec-1")

    await service.ingestTask(taskId)
    const manifest = readManifest(taskId)
    const jsonlItem = manifest.items.find((i: any) => i.kind === "exec-jsonl-excerpt")
    const payload = itemPayload(path.join(knowledgeRoot, jsonlItem.path))

    // 关键事件在场
    expect(payload).toContain("登录接口 500：cookie 未清") // error 行
    expect(payload).toContain("pnpm test") // tool_call isError 行
    expect(payload).toContain("fix: 补 cookie 清理") // fix-commit 关联行
    expect(payload).toContain("重试痕迹节点：do-task") // retry（同节点多 start）
    // 噪声不在场（非全量拷贝）
    expect(payload).not.toContain("例行进度噪声AAA")
    expect(payload).not.toContain("无关正文噪声CCC")
    // exec 指针可回源
    expect(payload).toContain("aa02-exec-1")
    expect(payload).toContain(path.join(wsPath, "logs", "aa02-exec-1"))
  })

  it("PR diff 件 = stat 级 + 关键 hunk（真 git 区间）；全量指回 git（锚区间原样可复现）", async () => {
    const { service } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    const wsPath = path.join(tmpRoot, "ws", "w2")
    const { start, end } = makeGitRepo(path.join(wsPath, "projects", "authsvc"))
    seedExecution({ taskId, wsId: "aa02-ws-2", wsPath, start, end, execId: "aa02-exec-2" })

    await service.ingestTask(taskId)
    const manifest = readManifest(taskId)
    const diffItem = manifest.items.find((i: any) => i.kind === "pr-diff")
    const payload = itemPayload(path.join(knowledgeRoot, diffItem.path))

    expect(payload).toContain(`## 仓 authsvc（${start}..${end}）`) // 区间锚=全量回源 git
    expect(payload).toContain("- commits=1 files=2") // stat 级
    expect(payload).toContain("login.ts")
    expect(payload).toContain("### hunk: login.ts") // 关键 hunk（变更量 top）
    expect(payload).toContain("+  const s = createSession(user)")
    expect(payload).toContain("feat-login-session-20261013") // 分支指针
  })

  it("matt 产物件 = 仓库内路径指针（.scratch 逐件列名+大小，正文不拷；已随 phase PR 持久）", async () => {
    const taskHome = new TaskHomeService(path.join(tmpRoot, "homes"))
    const { service } = makeDeps()
    const { taskId, home } = seedV4Task(taskHome)
    const batchDir = path.join(home, ".scratch", "login")
    fs.mkdirSync(path.join(batchDir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(batchDir, "spec.md"), "# phase1 spec\n正文标记EEE不应进指针件\n", "utf-8")
    fs.writeFileSync(path.join(batchDir, "issues", "01-x.md"), "# issue 正文标记FFF\n", "utf-8")

    await service.ingestTask(taskId)
    const manifest = readManifest(taskId)
    const mattItem = manifest.items.find((i: any) => i.kind === "matt-artifacts")
    const payload = itemPayload(path.join(knowledgeRoot, mattItem.path))

    expect(payload).toContain(".scratch/login/spec.md")
    expect(payload).toContain(".scratch/login/issues/01-x.md")
    expect(payload).not.toContain("正文标记EEE") // 指针不拷正文
    expect(payload).not.toContain("正文标记FFF")
  })
})

// ── Slice 6：历史单文件兼容 + 幂等补面（票面第 6/7 行）────────────────

describe("历史兼容与幂等（S1·票02 第6行）", () => {
  it("旧单文件 task-{id}-summary.md 归档在前 ⇒ ingestTask deduped 回旧路径（不迁移不报错、不建包、零 LLM）", async () => {
    fs.mkdirSync(path.join(knowledgeRoot, "raw", "archives"), { recursive: true })
    fs.writeFileSync(
      path.join(knowledgeRoot, "raw", "archives", "task-old1-summary.md"),
      "---\norigin: \"task-archive:old1\"\ntitle: \"旧总结\"\ningestedAt: \"2026-10-13T00:00:00.000Z\"\nbytes: 9\nhash: \"x\"\n---\n旧内容\n",
      "utf-8",
    )
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
      VALUES ('old1', 'aa02-org', '历史任务', 'archiving', '{"format":"v4","goal":"g","ac":[],"phases":[]}', '[]', '[]', '[]', '[]', 1, datetime('now'), datetime('now'))
    `).run()

    const { service, cap } = makeDeps()
    const outcome = await service.ingestTask("old1")
    expect(outcome).toEqual({ status: "deduped", rawPath: "raw/archives/task-old1-summary.md" })
    expect(cap.prompts).toHaveLength(0)
    expect(cap.compilePack).toHaveLength(0)
    // 不迁移：旧任务名下不建包目录
    expect(fs.existsSync(path.join(knowledgeRoot, "raw", "archives", "task-old1"))).toBe(false)
  })

  it("重归档幂等：包 manifest 已冻结 ⇒ deduped 回总结件指针（零 LLM、零入队、不产第二包）", async () => {
    const { service, cap, queue } = makeDeps()
    const { taskId } = seedV4Task(new TaskHomeService(path.join(tmpRoot, "homes")))
    const first = await service.ingestTask(taskId)
    for (let i = 0; i < 200 && !cap.compilePack.length; i++) await new Promise((r) => setTimeout(r, 5))

    const second = await service.ingestTask(taskId)
    expect(second.status).toBe("deduped")
    expect(second.rawPath).toBe(first.rawPath)
    expect(cap.prompts).toHaveLength(1)
    expect(cap.compilePack).toHaveLength(1)
    expect(queue.list()).toHaveLength(1)
    expect(fs.readdirSync(path.join(knowledgeRoot, "raw", "archives"))).toEqual([`task-${taskId}`])
  })
})
