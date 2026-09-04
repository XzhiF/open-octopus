// packages/server/src/__tests__/tasks-v4-archiving.test.ts
//
// task-phase-redesign ticket 08 — archiving 编排 (ADR 顺延 / 术语 append /
// 归档 commit+push / project 粒度幂等重试 / advance 端点)。
//
// Seam 1 (pure): planAdrMerge / parseContextNotesSections / parseTermEntries /
// planGlossaryAppend — table-driven, no fs.
// Seam 2 (integration): TasksService default archiver + POST /:id/archive/retry
// + POST /:id/advance over REAL better-sqlite3 + REAL git (local bare repos as
// origin, real worktrees under a fake ~/.octopus) — R1-R7 honest fixtures,
// E2E_AR_ prefix, tmp dirs cleaned after.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { execFileSync } from "child_process"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { createTasksRoutes } from "../routes/tasks"
import {
  planAdrMerge,
  parseAdrFileName,
  parseContextNotesSections,
  parseTermEntries,
  planGlossaryAppend,
} from "../services/tasks/archiving-service"

// ── Harness ──────────────────────────────────────────────────────────

const ORG = "e2e-archive"

// ExecutionService registry stub (mirror of tasks-v4-acceptance.test.ts) — the
// archiver never touches it (it resolves worktrees through the workspaces row
// + ws config.json); only the advance/dispatch tests below need it.
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-ar-exec-dispatch-${stubSeq++}`
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
let stubSeq = 0
const mockHooks: { db: Database.Database | null } = { db: null }

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = mockHooks.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    return ws ? { service: stubService, wsPath: ws.path } : undefined
  },
}))

function newDb(): Database.Database {
  const d = new Database(":memory:")
  applySchema(d)
  d.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  return d
}

// ── Pure-function units ──────────────────────────────────────────────

describe("ADR 顺延（纯函数）", () => {
  it("parses numbered ADR file names, 3 or 4 digits, rejects junk", () => {
    expect(parseAdrFileName("0003-use-sqlite.md")).toEqual({ num: 3, slug: "use-sqlite" })
    expect(parseAdrFileName("07-legacy.md")).toEqual({ num: 7, slug: "legacy" })
    expect(parseAdrFileName("notes.md")).toBeNull()
  })

  it("target has 0003 → incoming 0001/0002 renumbered 0004/0005, slugs kept, marker appended", () => {
    const existing = [{ file: "0003-use-git.md", content: "# 决定：用 git\n" }]
    const incoming = [
      { file: "0001-pick-db.md", content: "# 选 SQLite\n" },
      { file: "0002-add-adr.md", content: "# ADR 流程\n" },
    ]
    const plan = planAdrMerge(incoming, existing, "task-9", "20260903")
    expect(plan.writes.map((w) => w.file)).toEqual(["0004-pick-db.md", "0005-add-adr.md"])
    expect(plan.writes[0].sourceFile).toBe("0001-pick-db.md")
    // 尾行溯源（AC1）
    expect(plan.writes[0].content.endsWith("> Synced from task task-9 (20260903)\n")).toBe(true)
    expect(plan.writes[0].content.startsWith("# 选 SQLite")).toBe(true)
    expect(plan.skipped).toEqual([])
  })

  it("empty target starts at 0001; unnumbered incoming gets the next number with its basename as slug", () => {
    const plan = planAdrMerge([{ file: "0001-a.md", content: "a\n" }, { file: "loose note.md", content: "b\n" }], [], "t1", "20260903")
    expect(plan.writes.map((w) => w.file)).toEqual(["0001-a.md", "0002-loose note.md"])
  })

  it("retry is idempotent: target files already carrying this task's marker are skipped, numbering stable", () => {
    const synced = { file: "0004-pick-db.md", content: "# 选 SQLite\n\n> Synced from task task-9 (20260903)\n" }
    const other = { file: "0003-use-git.md", content: "# git\n" }
    const plan = planAdrMerge([{ file: "0001-pick-db.md", content: "# 选 SQLite\n" }], [other, synced], "task-9", "20260903")
    expect(plan.writes).toEqual([])
    expect(plan.skipped).toEqual(["0001-pick-db.md"])
    // Another task still sees 0004 taken (顺延 from 0005):
    const plan2 = planAdrMerge([{ file: "0001-new.md", content: "x\n" }], [other, synced], "task-OTHER", "20260903")
    expect(plan2.writes.map((w) => w.file)).toEqual(["0005-new.md"])
  })
})

describe("context-notes 分节与术语解析（纯函数）", () => {
  it("splits by '## ' headings and attributes sections by project name", () => {
    const sections = parseContextNotesSections(
      [" preamble ", "## repo-a", "| Term | Definition |", "| **Foo** | foo-def |", "", "## Repo B (附属)", "- **Bar** — bar-def"].join("\n"),
    )
    expect(sections.map((s) => s.heading)).toEqual(["", "repo-a", "Repo B (附属)"])
    expect(sections[1].body).toContain("foo-def")
  })

  it("parses terms from table rows and bullet forms", () => {
    const terms = parseTermEntries(
      [
        "| Term | Definition |",
        "|------|-----------|",
        "| **Widget** | 小部件 |",
        "| Plain | 裸行定义 |",
        "- **Gizmo** — 小工具",
        "- Doodad：中文冒号定义",
      ].join("\n"),
    )
    expect(terms).toEqual([
      { term: "Widget", definition: "小部件" },
      { term: "Plain", definition: "裸行定义" },
      { term: "Gizmo", definition: "小工具" },
      { term: "Doodad", definition: "中文冒号定义" },
    ])
  })
})

describe("CONTEXT 术语 append-only（纯函数）", () => {
  it("appends new terms, keeps existing lines byte-stable, flags same-term-different-def as conflict", () => {
    const target = [
      "# Context", "", "## Glossary", "", "| Term | Definition |", "|------|-----------|",
      "| **Widget** | 旧义 |", "", "## Other", "keep me",
    ].join("\n")
    const plan = planGlossaryAppend(target, [
      { term: "Widget", definition: "新义" },
      { term: "Gizmo", definition: "小工具" },
    ])
    expect(plan.conflicts).toEqual([{ term: "Widget", incoming: "新义", existing: "旧义" }])
    expect(plan.appended.map((t) => t.term)).toEqual(["Gizmo"])
    expect(plan.output).toContain("| **Widget** | 旧义 |")
    expect(plan.output).toContain("| **Gizmo** | 小工具 |")
    expect(plan.output).toContain("keep me") // 其余内容不动
    expect(plan.output.indexOf("| **Gizmo**")).toBeLessThan(plan.output.indexOf("## Other"))
  })

  it("same term same definition → unchanged (idempotent), nothing written", () => {
    const target = "## Glossary\n\n| Term | Definition |\n|---|---|\n| Gizmo | 小工具 |\n"
    const plan = planGlossaryAppend(target, [{ term: "Gizmo", definition: "小工具" }])
    expect(plan.appended).toEqual([])
    expect(plan.unchanged).toHaveLength(1)
    expect(plan.output).toBe(target)
  })

  it("missing file → bootstrapped with a Glossary table; missing section → section appended at EOF", () => {
    const boot = planGlossaryAppend(null, [{ term: "Foo", definition: "f" }])
    expect(boot.output).toContain("## Glossary")
    expect(boot.output).toContain("| **Foo** | f |")
    const sec = planGlossaryAppend("# Project\n\nno glossary here\n", [{ term: "Bar", definition: "b" }])
    expect(sec.output).toContain("# Project")
    expect(sec.output).toMatch(/## Glossary[\s\S]*\| \*\*Bar\*\* \| b \|/)
  })

  it("wider target tables (extra columns) get padded rows", () => {
    const target = "## Glossary\n\n| Term | Definition | Package |\n|---|---|---|\n| A | a | shared |\n"
    const plan = planGlossaryAppend(target, [{ term: "B", definition: "b" }])
    expect(plan.output).toMatch(/\| \*\*B\*\* \| b \|\s*\|/)
  })
})

// ── Integration: real git fixtures + TasksService archiver ───────────

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: "2026-09-03T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-09-03T00:00:00+00:00" }

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV }).toString()
}

/** A bare origin + a clone seeded with docs/adr + optional CONTEXT.md. */
interface RepoFixture {
  name: string
  bare: string
  main: string
  bareBak: string
}

function makeProjectRepo(name: string, opts: { adrs?: string[]; contextMd?: string } = {}): RepoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ar-repo-"))
  tracked.push(root)
  const bare = path.join(root, `${name}.git`)
  git(["init", "--bare", "-b", "main", bare], root)
  const main = path.join(root, "main")
  fs.mkdirSync(main)
  git(["init", "-b", "main"], main)
  git(["config", "user.email", "archive@test.local"], main)
  git(["config", "user.name", "Archive Test"], main)
  fs.writeFileSync(path.join(main, "README.md"), `# ${name}\n`)
  if ((opts.adrs ?? []).length > 0) {
    fs.mkdirSync(path.join(main, "docs", "adr"), { recursive: true })
    for (const adr of opts.adrs!) fs.writeFileSync(path.join(main, "docs", "adr", adr), `# ${adr}\n`)
  }
  if (opts.contextMd) fs.writeFileSync(path.join(main, "CONTEXT.md"), opts.contextMd)
  git(["add", "-A"], main)
  git(["commit", "-m", "seed"], main)
  git(["remote", "add", "origin", bare], main)
  git(["push", "-u", "origin", "main"], main)
  return { name, bare, main, bareBak: `${bare}.bak` }
}

function makeWorktree(fx: RepoFixture, wsPath: string, branch: string): string {
  const wt = path.join(wsPath, "projects", fx.name)
  fs.mkdirSync(path.join(wsPath, "projects"), { recursive: true })
  git(["worktree", "add", "-f", "-B", branch, wt], fx.main)
  git(["config", "user.email", "archive@test.local"], wt)
  git(["config", "user.name", "Archive Test"], wt)
  return wt
}

const BRANCH = "taskpool-e2e-ar-1"
const REPO_A_CONTEXT = [
  "# Context — repo-a",
  "",
  "## Glossary",
  "",
  "| Term | Definition |",
  "|------|-----------|",
  "| **Widget** | 旧义 |",
  "",
].join("\n")

/** Lay out an archiving-ready fixture: 1~2 project repos (+worktrees under a
 *  real ws dir with config.json), a task home holding docs/adr + context-notes,
 *  and the tasks/workspaces rows. `status` defaults to 'archiving' (the
 *  retry seam); AC3 instead seeds an awaitable acceptance state (envelope +
 *  tagged terminal execution + ledger-free) so the LAST-phase acceptance path
 *  drives the built-in archiver end to end. */
function seedArchiveFixture(opts: {
  projects?: Array<{ name: string; fx: RepoFixture }>
  homeAdrs: Array<{ rel: string; content: string }>
  notes?: string
  /** 'archiving' (retry seam) | 'awaiting' (acceptance end-to-end) */
  mode?: "archiving" | "awaiting"
}): { taskId: string; wsPath: string; home: string; wts: Record<string, string> } {
  const projects = opts.projects ?? [{ name: "repo-a", fx: repoA }]
  const db = mockHooks.db!
  const taskId = `e2e-ar-task-${seq++}`
  const wsId = `e2e-ar-ws-${seq}`
  const wsPath = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", wsId)
  fs.mkdirSync(wsPath, { recursive: true })

  const wts: Record<string, string> = {}
  const repos: Array<{ name: string; main_path: string; worktree_path: string; branch: string }> = []
  for (const p of projects) {
    const wt = makeWorktree(p.fx, wsPath, BRANCH)
    wts[p.name] = wt
    repos.push({ name: p.name, main_path: p.fx.main, worktree_path: wt, branch: BRANCH })
  }
  fs.writeFileSync(path.join(wsPath, "config.json"), JSON.stringify({ name: `ws-${taskId}`, org: ORG, repos }, null, 2))
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', datetime('now'), datetime('now'))",
  ).run(wsId, `task:${taskId}`, ORG, wsPath)

  const home = taskHome.homePath(taskId)
  fs.mkdirSync(home, { recursive: true })
  for (const adr of opts.homeAdrs) {
    const abs = path.join(home, "docs", "adr", adr.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, adr.content, "utf-8")
  }
  if (opts.notes) fs.writeFileSync(path.join(home, "context-notes.md"), opts.notes, "utf-8")

  const mode = opts.mode ?? "archiving"
  const phases = [{ index: 1, name: "Phase 1", slug: "p1", workflowRef: "built-in/flow-p1" }]
  const spec = {
    format: "v4",
    task_type: "coding",
    skill_groups: [],
    phases: phases.map((p) => ({
      index: p.index, name: p.name, slug: p.slug,
      specPath: path.join(".scratch", "20260903", p.slug, "spec.md"),
      workflowRef: p.workflowRef, inputValues: {},
    })),
  }
  const specDir = path.join(home, ".scratch", "20260903", "p1")
  fs.mkdirSync(specDir, { recursive: true })
  fs.writeFileSync(path.join(specDir, "spec.md"), "# p1\n")
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', ?, NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_AR ${taskId}`, mode === "awaiting" ? "running" : "archiving", JSON.stringify(spec), JSON.stringify(projects.map((p) => p.name)), now, now, wsId)

  if (mode === "awaiting") {
    // envelope + ONE terminal (1,1) execution via the schedule link → derive:
    // phase 1 awaiting_review → acceptance(i=1=n) → beginArchiving (built-in).
    const scheduleId = `e2e-ar-sched-${seq}`
    db.prepare(`
      INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
        job_type, config, parallel_policy, status, origin_type, origin_id, origin_role,
        scheduled_at, created_at, updated_at, max_retain)
      VALUES (?, ?, ?, NULL, 'UTC', 1, 'workflow', ?, 'skip', 'done', 'task', ?, 'primary', NULL, ?, ?, 10)
    `).run(
      scheduleId, ORG, `task-${taskId}-primary`,
      JSON.stringify({
        schema_version: "3.0", type: "workflow",
        workspace_spec: { org: ORG, branch_prefix: "taskpool-e2e-ar", projects: [] },
        workflow_chain: [{ workflow_ref: "built-in/flow-p1", input_values: {} }],
        max_retain: 10, format: "v4",
        phases: [{ index: 1, name: "Phase 1", slug: "p1", specPath: path.join(specDir, "spec.md"), specDir, workflowRef: "built-in/flow-p1", inputValues: {} }],
      }),
      taskId, now, now,
    )
    const seId = `e2e-ar-se-${seq}`
    db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org,
        phase_index, round_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, 1, 1, datetime('now'), datetime('now'))`,
    ).run(`e2e-ar-exec-${seq}`, wsId, "built-in/flow-p1", "built-in/flow-p1", ORG)
    db.prepare(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by, execution_id, workspace_id)
      VALUES (?, ?, 'completed', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler', ?, ?)
    `).run(seId, scheduleId, `e2e-ar-exec-${seq}`, wsId)
  }
  return { taskId, wsPath, home, wts }
}

function archiveCommitSubjects(wtOrBare: string, ref = BRANCH): string[] {
  try {
    return git(["log", "--format=%s", ref], wtOrBare).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function commitCount(wt: string, regex: RegExp): number {
  return archiveCommitSubjects(wt).filter((s) => regex.test(s)).length
}

function taskRowOf(taskId: string) {
  return mockHooks.db!
    .prepare("SELECT status, completed_at, workspace_id FROM tasks WHERE id = ?")
    .get(taskId) as { status: string; completed_at: string | null; workspace_id: string }
}

function postRetry(taskId: string) {
  return app.request(`/api/tasks/${taskId}/archive/retry`, { method: "POST" })
}

function advance(taskId: string) {
  return app.request(`/api/tasks/${taskId}/advance`, { method: "POST" })
}

async function runToReport(taskId: string) {
  const p = service.awaitArchiving(taskId)
  expect(p, "no archiving run registered").toBeTruthy()
  return (await p!)!
}

let repoA: RepoFixture
const tracked: string[] = []
let db: Database.Database
let sse: SSEService
let service: TasksService
let app: Hono
let taskHome: TaskHomeService
let fakeHome: string
let realHome: string | undefined
let seq = 0

beforeEach(() => {
  db = newDb()
  mockHooks.db = db
  seq = 0
  vi.clearAllMocks()
  realHome = process.env.HOME
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ar-home-"))
  process.env.HOME = fakeHome
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  sse = new SSEService()
  service = new TasksService(db, sse, undefined, taskHome)
  app = new Hono().route("/api/tasks", createTasksRoutes(service, sse))
  repoA = makeProjectRepo("repo-a", { adrs: ["0001-one.md", "0002-two.md", "0003-three.md"], contextMd: REPO_A_CONTEXT })
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  for (const d of tracked) fs.rmSync(d, { recursive: true, force: true })
  if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true })
  db.close()
})

describe("AC1 — ADR 顺延 (git fixture: 目标已有 0003)", () => {
  it("home 0001/0002 归档后在目标从 0004 起编号、slug 保留、尾行含 task id", async () => {
    const { taskId, wts } = seedArchiveFixture({
      homeAdrs: [
        { rel: "0001-pick-db.md", content: "# 选 SQLite\n正文\n" },
        { rel: "0002-adr-flow.md", content: "# ADR 流程\n" },
      ],
    })
    expect((await postRetry(taskId)).status).toBe(202)
    const report = await runToReport(taskId)
    expect(report.ok).toBe(true)
    const wt = wts["repo-a"]
    const dir = path.join(wt, "docs", "adr")
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(["0001-one.md", "0002-two.md", "0003-three.md", "0004-pick-db.md", "0005-adr-flow.md"])
    const merged = fs.readFileSync(path.join(dir, "0004-pick-db.md"), "utf-8")
    expect(merged.startsWith("# 选 SQLite")).toBe(true)
    expect(merged.trimEnd().endsWith(`> Synced from task ${taskId} (${report.date})`)).toBe(true)
    // 归档 commit + push 到 origin
    expect(archiveCommitSubjects(wt)[0]).toMatch(/^chore\(archive\): E2E_AR .+ syncback \d{8}$/)
    expect(archiveCommitSubjects(repoA.bare, BRANCH).length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(taskHome.homePath(taskId), "archive", "report.md"))).toBe(true)
  })
})

describe("AC2 — 术语 append-only + 冲突只报不写", () => {
  it("新术语 append、同名不同义不写且进报告、既有条目原样", async () => {
    const { taskId, wts, home } = seedArchiveFixture({
      homeAdrs: [],
      notes: [
        "## repo-a",
        "",
        "| Term | Definition |",
        "|------|-----------|",
        "| **Widget** | 全新定义 |",
        "| **Gizmo** | 小工具 |",
        "",
      ].join("\n"),
    })
    await postRetry(taskId)
    const report = await runToReport(taskId)
    expect(report.ok).toBe(true)
    const ctx = fs.readFileSync(path.join(wts["repo-a"], "CONTEXT.md"), "utf-8")
    expect(ctx).toContain("| **Widget** | 旧义 |") // 原样未动
    expect(ctx).toContain("| **Gizmo** | 小工具 |") // append
    const pr = report.projects[0]
    expect(pr.termConflicts).toEqual([{ term: "Widget", incoming: "全新定义", existing: "旧义" }])
    const reportMd = fs.readFileSync(path.join(home, "archive", "report.md"), "utf-8")
    expect(reportMd).toContain("Widget")
  })
})

describe("AC3 — 双 project：各自归档 commit/push → done（末 phase accepted 全链路）", () => {
  it("acceptance(末 phase) 自动编排：两仓库各 1 归档 commit、push 成功、task done；未归属 ADR 进报告不阻塞", async () => {
    const repoB = makeProjectRepo("repo-b", { adrs: ["0001-x.md"] })
    const { taskId, wts } = seedArchiveFixture({
      mode: "awaiting",
      projects: [
        { name: "repo-a", fx: repoA },
        { name: "repo-b", fx: repoB },
      ],
      homeAdrs: [
        { rel: "repo-a/0001-dec-a.md", content: "# 决定 A\n" },
        { rel: "repo-b/0001-dec-b.md", content: "# 决定 B\n" },
        { rel: "0009-ambiguous.md", content: "# 说不清归谁\n" },
      ],
    })
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    sse.subscribe("taskpool", (e) => events.push({ event: e.event, data: e.data as Record<string, unknown> }))

    const res = await app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 1, decision: "accepted" }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { next_action: string }).next_action).toBe("archiving")

    const report = await runToReport(taskId)
    expect(report.ok).toBe(true)
    expect(report.unattributedAdrs).toEqual(["0009-ambiguous.md"])
    expect(fs.existsSync(path.join(wts["repo-b"], "docs", "adr", "0002-dec-b.md"))).toBe(true) // repo-b 已有 0001 → 顺延 0002
    expect(fs.existsSync(path.join(wts["repo-a"], "docs", "adr", "0004-dec-a.md"))).toBe(true)
    for (const p of report.projects) {
      expect(p.commit, p.project).toBeTruthy()
      expect(p.pushed, p.project).toBe(true)
      expect(p.pr?.action).toBe("skipped") // 本地 bare origin → 非 GitHub，push 即落地
    }
    expect(commitCount(wts["repo-a"], /^chore\(archive\): .+ syncback \d{8}$/)).toBe(1)
    expect(commitCount(wts["repo-b"], /^chore\(archive\): .+ syncback \d{8}$/)).toBe(1)
    expect(archiveCommitSubjects(repoA.bare, BRANCH)[0]).toMatch(/^chore\(archive\): .+ syncback \d{8}$/)
    const row = taskRowOf(taskId)
    expect(row.status).toBe("done")
    expect(row.completed_at).toBeTruthy()
    expect(events.filter((e) => e.event === "task_status").at(-1)?.data).toMatchObject({ task_id: taskId, status: "done" })
  })
})

describe("AC4 — push 失败停 archiving；retry project 粒度幂等续跑", () => {
  it("B push 失败 → A done B 挂；retry 后 A 不重复 commit、B 续跑 → done", async () => {
    const repoB = makeProjectRepo("repo-b")
    const { taskId, wts, home } = seedArchiveFixture({
      projects: [
        { name: "repo-a", fx: repoA },
        { name: "repo-b", fx: repoB },
      ],
      homeAdrs: [
        { rel: "repo-a/0001-dec-a.md", content: "# A\n" },
        { rel: "repo-b/0001-dec-b.md", content: "# B\n" },
      ],
    })
    // 模拟 project B push 失败：origin bare 目录暂时消失
    fs.renameSync(repoB.bare, repoB.bareBak)

    await postRetry(taskId)
    const report = await runToReport(taskId)
    fs.renameSync(repoB.bareBak, repoB.bare)

    expect(report.ok).toBe(false)
    expect(report.projects.find((p) => p.project === "repo-a")!.ok).toBe(true)
    const b = report.projects.find((p) => p.project === "repo-b")!
    expect(b.ok).toBe(false)
    expect(b.error).toMatch(/push origin .+ failed/)
    expect(taskRowOf(taskId).status).toBe("archiving")
    const state = JSON.parse(fs.readFileSync(path.join(home, "archive", "state.json"), "utf-8"))
    expect(state.projects["repo-a"].status).toBe("done")
    expect(state.projects["repo-b"]).toBeUndefined()

    const retry = await postRetry(taskId)
    expect(retry.status).toBe(202)
    const report2 = await runToReport(taskId)
    expect(report2.ok).toBe(true)
    const a2 = report2.projects.find((p) => p.project === "repo-a")!
    expect(a2.skippedByState).toBe(true) // A 跳过 — 不重复 commit
    expect(commitCount(wts["repo-a"], /^chore\(archive\): /)).toBe(1)
    expect(commitCount(wts["repo-b"], /^chore\(archive\): /)).toBe(1)
    expect(archiveCommitSubjects(repoB.bare, BRANCH)[0]).toMatch(/^chore\(archive\): E2E_AR .+ syncback \d{8}$/)
    expect(taskRowOf(taskId).status).toBe("done")
    expect(taskRowOf(taskId).completed_at).toBeTruthy()
  })

  it("retry 前置校验：非 archiving → 409；未知任务 → 404", async () => {
    const { taskId } = seedArchiveFixture({ homeAdrs: [] })
    mockHooks.db!.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId)
    const res = await postRetry(taskId)
    expect(res.status).toBe(409)
    const missing = await postRetry("e2e-ar-nope")
    expect(missing.status).toBe(404)
  })
})

describe("AC5 — done 解除 retention 豁免", () => {  it("done 后 executor 豁免谓词 (row && status!=='done') 为 false → 可回收", async () => {
    const { taskId } = seedArchiveFixture({ homeAdrs: [{ rel: "0001-only.md", content: "# 只有我\n" }] })
    await postRetry(taskId)
    await runToReport(taskId)
    const wsId = taskRowOf(taskId).workspace_id
    // 与 WorkflowExecutor.isTaskWorkspaceUnarchived (workflow-executor.ts:1180)
    // 同一条谓词 SQL：task done ⇒ 查询无行 ⇒ 豁免 false ⇒ retention 扫描可删 ws。
    const unarchived = mockHooks.db!
      .prepare("SELECT status FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL AND status != 'done'")
      .all(wsId)
    expect(unarchived).toEqual([])
    expect(taskRowOf(taskId).status).toBe("done")
  })
})

// ── advance (票 07 移交裁决): POST /:id/advance ──────────────────────

/** Two-phase v4 task. `p1`: phase-1 round-1 terminal exec, optionally with the
 *  accepted ledger row; `p2Terminal`: give phase 2 a terminal (2,1) exec. */
function seedTwoPhase(opts: {
  autoAdvance?: boolean
  p1?: "none" | "awaiting" | "accepted"
  p2Terminal?: boolean
  status?: string
}): { taskId: string; wsId: string } {
  const d = mockHooks.db!
  const taskId = `e2e-ar-adv-${seq++}`
  const wsId = `e2e-ar-advws-${seq}`
  const wsPath = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", wsId)
  fs.mkdirSync(wsPath, { recursive: true })
  d.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', datetime('now'), datetime('now'))",
  ).run(wsId, `task:${taskId}`, ORG, wsPath)
  const now = new Date().toISOString()
  const defs = [
    { index: 1, name: "Phase 1", slug: "p1", workflowRef: "built-in/flow-p1" },
    { index: 2, name: "Phase 2", slug: "p2", workflowRef: "built-in/flow-p2" },
  ]
  const spec = {
    format: "v4", task_type: "coding", skill_groups: [],
    ...(opts.autoAdvance === undefined ? {} : { autoAdvance: opts.autoAdvance }),
    phases: defs.map((p) => ({
      index: p.index, name: p.name, slug: p.slug,
      specPath: path.join(".scratch", "20260903", p.slug, "spec.md"),
      workflowRef: p.workflowRef, inputValues: {},
    })),
  }
  d.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_AR ${taskId}`, opts.status ?? "running", JSON.stringify(spec), now, now, wsId)
  const scheduleId = `e2e-ar-advsched-${seq}`
  d.prepare(`
    INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
      job_type, config, parallel_policy, status, origin_type, origin_id, origin_role,
      scheduled_at, created_at, updated_at, max_retain)
    VALUES (?, ?, ?, NULL, 'UTC', 1, 'workflow', ?, 'skip', 'done', 'task', ?, 'primary', NULL, ?, ?, 10)
  `).run(
    scheduleId, ORG, `task-${taskId}-primary`,
    JSON.stringify({
      schema_version: "3.0", type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "taskpool-e2e-ar", projects: [] },
      workflow_chain: [{ workflow_ref: "built-in/flow-p1", input_values: {} }],
      max_retain: 10, format: "v4",
      phases: defs.map((p) => ({ ...p, specPath: path.join(taskHome.homePath(taskId), ".scratch", "20260903", p.slug, "spec.md"), specDir: path.join(taskHome.homePath(taskId), ".scratch", "20260903", p.slug), inputValues: {} })),
    }),
    taskId, now, now,
  )
  let seSeq = 0
  const layExec = (phaseIdx: number, status: string): void => {
    const execId = `e2e-ar-advexec-${seq}-${phaseIdx}-${seSeq}`
    d.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, phase_index, round_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    ).run(execId, wsId, `built-in/flow-p${phaseIdx}`, `built-in/flow-p${phaseIdx}`, status, ORG, phaseIdx)
    d.prepare(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by, execution_id)
      VALUES (?, ?, 'completed', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler', ?)
    `).run(`e2e-ar-advse-${seq}-${seSeq++}`, scheduleId, execId)
  }
  if (opts.p1 && opts.p1 !== "none") {
    layExec(1, "completed")
    if (opts.p1 === "accepted") {
      d.prepare(
        "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, 1, 1, 'accepted', NULL, datetime('now'))",
      ).run(`e2e-ar-advacc-${seq}`, taskId)
    }
  }
  if (opts.p2Terminal) layExec(2, "completed")
  return { taskId, wsId }
}

describe("POST /:id/advance — 人工起下一 phase (票 07 移交裁决)", () => {
  it("autoAdvance=false 全旅程：acceptance→awaiting_manual_trigger→advance 派发 (2,1)", async () => {
    const { taskId } = seedTwoPhase({ autoAdvance: false, p1: "awaiting" })
    const acc = await app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 1, decision: "accepted" }),
    })
    expect(acc.status).toBe(200)
    expect(((await acc.json()) as { next_action: string }).next_action).toBe("awaiting_manual_trigger")
    expect(taskRowOf(taskId).status).toBe("ready")

    const before = stubService.create.mock.calls.length
    const res = await advance(taskId)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as {
      next_action: string
      dispatch: Record<string, unknown>
      task: { derived: { phaseViews: Array<{ index: number; status: string }> } }
    }
    expect(body.next_action).toBe("dispatched")
    expect(body.dispatch).toMatchObject({ phase_index: 2, round_index: 1 })
    expect(stubService.create.mock.calls.length).toBe(before + 1)
    expect(taskRowOf(taskId).status).toBe("running")
    expect(body.task.derived.phaseViews.find((p) => p.index === 2)!.status).toBe("running")
  })

  it("派发失败后的窗口（phase1 accepted ∧ phase2 pending）advance 续跑成功", async () => {
    // ledger accepted without dispatch ever happening == the exact observable
    // world after 「上 phase 已 accepted 未派发」.
    const { taskId } = seedTwoPhase({ p1: "accepted" })
    const res = await advance(taskId)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { dispatch: Record<string, unknown> }).dispatch).toMatchObject({ phase_index: 2, round_index: 1 })
  })

  it("负例：phase1 未 accepted → 409；phase2 已 awaiting_review → 409；v3 → 409；未知 → 404", async () => {
    const a = seedTwoPhase({ p1: "awaiting" })
    expect((await advance(a.taskId)).status).toBe(409)
    const b = seedTwoPhase({ p1: "accepted", p2Terminal: true })
    expect((await advance(b.taskId)).status).toBe(409) // phase2 是 awaiting_review 非 pending
    const c = seedTwoPhase({})
    mockHooks.db!.prepare("UPDATE tasks SET task_spec = ? WHERE id = ?").run(JSON.stringify({ goal: "g", ac: ["x"] }), c.taskId)
    expect((await advance(c.taskId)).status).toBe(409)
    expect((await advance("e2e-ar-adv-missing")).status).toBe(404)
  })
})

