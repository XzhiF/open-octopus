// packages/server/src/__tests__/tasks-round-diff.test.ts
//
// 验货台 (acceptance v2) — GET /api/tasks/:id/round-diff(+ /patch)。
// 实物 = executions.start/end_commit_id 圈出的真实 git 区间（GitOperations 在
// launch/terminal 捕获）；本套建真 git 库（git-ops.test.ts 惯例）× 真路由
// （tasks-home-file.test.ts 惯例），断言 numstat/分组/过期三态与 patch 懒拉。
// workspaceService 用 {getById} stub —— 服务只读 ws.path（装配同
// tasks-batch-tree harness）。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService, type RoundDiffPayload } from "../services/tasks/round-evidence-service"

const ORG = "e2e-td-rounddiff"
const WS_ID = "ws-rd-1"

let db: Database.Database
let app: Hono
let tmp: string
let wsDir: string
let repoDir: string
let taskHome: TaskHomeService
let c1 = ""
let c2 = ""
let c1b = "" // R3 重建后的等价区间（R4 需要「目录在、SHA 不可达」的分支）
let seq = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/** v4 任务行（draft，无 exec 行）——「无任何轮可供货」的 409 对照组。 */
async function newBareTask(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      org: ORG,
      name: `E2E_TD rd ${seq++}`,
      task_spec: {
        format: "v4",
        goal: "g",
        ac: ["a1"],
        phases: [
          { index: 1, name: "P1", slug: "p-1", specPath: "./.scratch/20260916/p-1/spec.md", workflowRef: "task-dev", inputValues: {} },
        ],
      },
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/** v4 任务 + completed phase1/round1 exec 行（awaiting_review 态）。返回 [taskId, execId]。
 *  票03：status 可给 'running'/'paused'（live 轮），end 显式 null = 未终态行形状。 */
async function newAwaitingTask(opts: {
  start?: Record<string, string>
  end?: Record<string, string> | null
  status?: string
  /** 单轮路径的 round_index（缺省 1）。票03 L5：当前轮给 2，首轮另行插入。 */
  round?: number
  /** undefined = 默认 '{"totalInterventions":2}'；显式 null = 在跑行尚无账目。 */
  harnessSummary?: string | null
  /** S3 fixture：多轮各插一行 (phase1,round_n)，awaiting 落最高轮；给定时
   *  覆盖 start/end/status 的单轮形状。 */
  rounds?: Array<{ round: number; start: Record<string, string>; end: Record<string, string> }>
} = {}): Promise<[string, string]> {
  const taskId = await newBareTask()
  const execId = `exec-rd-${seq}`
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, harness_summary,
      started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'task-dev', 'rd', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  if (opts.rounds?.length) {
    for (const r of opts.rounds) {
      insert.run(`${execId}-r${r.round}`, WS_ID, ORG, "completed", taskId, r.round,
        JSON.stringify(r.start), JSON.stringify(r.end), null, now, now, now, now)
    }
  } else {
    insert.run(execId, WS_ID, ORG, opts.status ?? "completed", taskId, opts.round ?? 1,
      JSON.stringify(opts.start ?? { app: c1 }),
      opts.end === null ? null : JSON.stringify(opts.end ?? { app: c2 }),
      opts.harnessSummary === undefined ? '{"totalInterventions":2}' : opts.harnessSummary,
      now, opts.status === "running" || opts.status === "paused" ? null : now, now, now)
  }
  return [taskId, execId]
}

/** 独立新仓（projects/<name>）三提交 k0<k1<k2。 */
function freshRepo(name: string): [string, string, string] {
  const dir = path.join(wsDir, "projects", name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "t@t.io")
  git(dir, "config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "seed.txt"), "s\n")
  git(dir, "add", "-A"); git(dir, "commit", "-m", "k0")
  const k0 = git(dir, "rev-parse", "HEAD")
  fs.writeFileSync(path.join(dir, "r1.txt"), "1a\n1b\n1c\n")
  git(dir, "add", "-A"); git(dir, "commit", "-m", "k1")
  const k1 = git(dir, "rev-parse", "HEAD")
  fs.writeFileSync(path.join(dir, "r2.txt"), "2a\n")
  git(dir, "add", "-A"); git(dir, "commit", "-m", "k2")
  const k2 = git(dir, "rev-parse", "HEAD")
  return [k0, k1, k2]
}

function commitMore(repoName: string, file: string, content: string): string {
  const dir = path.join(wsDir, "projects", repoName)
  fs.writeFileSync(path.join(dir, file), content)
  git(dir, "add", "-A"); git(dir, "commit", "-m", `+${file}`)
  return git(dir, "rev-parse", "HEAD")
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-rounddiff-"))
  wsDir = path.join(tmp, "ws1")
  repoDir = path.join(wsDir, "projects", "app")
  fs.mkdirSync(repoDir, { recursive: true })

  // 真 git 库：c1 = a.txt(3行)+old.ts(20行)；c2 = a.txt 改 1 行 + old→new 改名
  //      + 追加行 + 二进制 png.dat。
  git(repoDir, "init", "-b", "main")
  git(repoDir, "config", "user.email", "t@t.io")
  git(repoDir, "config", "user.name", "T")
  fs.writeFileSync(path.join(repoDir, "a.txt"), "l1\nl2\nl3\n")
  fs.writeFileSync(path.join(repoDir, "old.ts"), Array.from({ length: 20 }, (_, i) => `// line ${i}`).join("\n"))
  git(repoDir, "add", "-A")
  git(repoDir, "commit", "-m", "c1")
  c1 = git(repoDir, "rev-parse", "HEAD")
  fs.writeFileSync(path.join(repoDir, "a.txt"), "l1\nl2-edited\nl3\n")
  git(repoDir, "mv", "old.ts", "new.ts")
  fs.appendFileSync(path.join(repoDir, "new.ts"), "\n// tail added\n")
  fs.writeFileSync(path.join(repoDir, "png.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x00, 0x02]))
  git(repoDir, "add", "-A")
  git(repoDir, "commit", "-m", "c2")
  c2 = git(repoDir, "rev-parse", "HEAD")

  db.prepare(`
    INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
    VALUES (?, 'rd-ws', ?, ?, ?, ?)
  `).run(WS_ID, ORG, wsDir, new Date().toISOString(), new Date().toISOString())

  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const tasksService = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never,
  )
  const workspaceService = { getById: (id: string) => (id === WS_ID ? { id, path: wsDir } : undefined) } as never
  const evidence = new RoundEvidenceService(db, sse, tasksService, workspaceService, taskHome)
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse, undefined, evidence))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function diffOf(taskId: string): Promise<RoundDiffPayload> {
  const r = await app.request(`/api/tasks/${taskId}/round-diff`)
  expect(r.status).toBe(200)
  return (await r.json()) as RoundDiffPayload
}

describe("round-diff — 实物 numstat / 分组 / 汇总", () => {
  it("R1: 真区间 → 提交数/+−行/文件数/首段分组/interventions 全对", async () => {
    const [taskId] = await newAwaitingTask()
    const d = await diffOf(taskId)
    expect(d.available).toBe(true)
    expect(d.interventions).toBe(2)
    expect(d.aggregate.commits).toBe(1)
    const repo = d.repos.find((r) => r.name === "app")!
    expect(repo).toBeTruthy()
    expect(repo.expired).toBeFalsy()
    expect(repo.files).toBe(3) // a.txt(M) new.ts(R from old.ts) png.dat(A)
    expect(repo.truncated).toBe(false)
    const byPath = new Map(repo.groups.flatMap((g) => g.files.map((f) => [f.path, f])))
    expect(byPath.get("a.txt")).toMatchObject({ status: "M", adds: 1, dels: 1 })
    const ren = byPath.get("new.ts")!
    expect(ren.status).toBe("R")
    expect(ren.oldPath).toBe("old.ts")
    expect(ren).toMatchObject({ adds: 2, dels: 1 }) // -M 把 20 行平移，只数追加的 tail 两行/删一尾行
    const bin = byPath.get("png.dat")!
    expect(bin.binary).toBe(true)
    expect(bin.adds).toBe(0)
    // 根目录文件 → 「(根)」组
    expect(repo.groups.some((g) => g.dir === "(根)")).toBe(true)
  })

  it("R2: patch 懒拉 — a.txt 含 -l2/+l2-edited；未知 repo → 409；缺参 → 400", async () => {
    const [taskId] = await newAwaitingTask()
    const pr = await app.request(
      `/api/tasks/${taskId}/round-diff/patch?repo=app&path=${encodeURIComponent("a.txt")}`,
    )
    expect(pr.status).toBe(200)
    const patch = (await pr.json()) as { patch: string; truncated: boolean }
    expect(patch.patch).toContain("-l2")
    expect(patch.patch).toContain("+l2-edited")
    expect(patch.truncated).toBe(false)
    expect((await app.request(`/api/tasks/${taskId}/round-diff/patch?repo=nope&path=x`)).status).toBe(409)
    expect((await app.request(`/api/tasks/${taskId}/round-diff/patch`)).status).toBe(400)
  })

  it("R3: worktree 目录删光 → 诚实过期（expired + available:false，绝不 500）", async () => {
    const [taskId] = await newAwaitingTask()
    fs.rmSync(path.join(wsDir, "projects", "app"), { recursive: true, force: true })
    const d = await diffOf(taskId)
    expect(d.available).toBe(false)
    expect(d.repos[0]!.expired).toBe(true)
    expect(d.repos[0]!.reason).toBe("worktree_gone")
    // 重建等价仓库（R4/R6 的分支需要「目录存在」）—— 新 HEAD 对旧 exec 行是
    // 陌生对象，正合 R4；R6 用新鲜 c1b..c1b 空区间。
    fs.mkdirSync(repoDir, { recursive: true })
    git(repoDir, "init", "-b", "main")
    git(repoDir, "config", "user.email", "t@t.io")
    git(repoDir, "config", "user.name", "T")
    fs.writeFileSync(path.join(repoDir, "a.txt"), "l1\n")
    git(repoDir, "add", "-A")
    git(repoDir, "commit", "-m", "rebuild")
    c1b = git(repoDir, "rev-parse", "HEAD")
  })

  it("R4: SHA 不可达（伪造 hash）→ no_commits 过期", async () => {
    const [taskId] = await newAwaitingTask({
      start: { app: "0000000000000000000000000000000000000000" },
      end: { app: "1111111111111111111111111111111111111111" },
    })
    const d = await diffOf(taskId)
    expect(d.available).toBe(false)
    expect(d.repos[0]!.reason).toBe("no_commits")
  })

  it("R5(票03 改判): running 轮（无 awaiting）→ live 口径 200，锚不可达时诚实 expired 绝不 500；无任何轮 → 409；未知任务 → 404", async () => {
    const [taskId] = await newAwaitingTask({ status: "running" })
    const r = await app.request(`/api/tasks/${taskId}/round-diff`)
    expect(r.status).toBe(200)
    const d = (await r.json()) as RoundDiffPayload
    // 此刻 app 仓已被 R3 重建：start 锚 c1 不可达 → 诚实过期，端点不崩。
    expect(d.available).toBe(false)
    expect(d.repos[0]?.expired).toBe(true)
    // 无 exec 行的任务 —— 既无 awaiting 也无 live 轮 → 409 依旧。
    const bare = await newBareTask()
    expect((await app.request(`/api/tasks/${bare}/round-diff`)).status).toBe(409)
    expect((await app.request(`/api/tasks/e2e-td-no-such/round-diff`)).status).toBe(404)
  })

  it("R6: start==end（rollback_on_error 轮）→ 空区间 available（零变更也是答案）", async () => {
    const [taskId] = await newAwaitingTask({ start: { app: c1b }, end: { app: c1b } })
    const d = await diffOf(taskId)
    expect(d.available).toBe(true)
    expect(d.aggregate).toEqual({ commits: 0, additions: 0, dels: 0, files: 0 })
  })
})

// ── S3 (2026-09-20): scope=cumulative — 本 phase 首轮 start 锚 .. 本轮 end 锚 ──
describe("round-diff — cumulative 口径", () => {
  it("C1: 两轮 fixture → cumulative=2 commits ⊇ 本轮=1；显式 scope=round 与缺省逐字一致（回归）", async () => {
    const [k0, k1, k2] = freshRepo("acc")
    const [taskId] = await newAwaitingTask({ rounds: [
      { round: 1, start: { acc: k0 }, end: { acc: k1 } },
      { round: 2, start: { acc: k1 }, end: { acc: k2 } },
    ] })
    const round = await diffOf(taskId) // 缺省 = round，锚 = 本轮 k1..k2
    expect(round.available).toBe(true)
    expect(round.aggregate.commits).toBe(1)
    const cum = (await (await app.request(`/api/tasks/${taskId}/round-diff?scope=cumulative`)).json()) as RoundDiffPayload
    expect(cum.available).toBe(true)
    expect(cum.aggregate.commits).toBe(2)
    expect(cum.aggregate.commits).toBeGreaterThanOrEqual(round.aggregate.commits)
    expect(cum.aggregate.additions).toBeGreaterThanOrEqual(round.aggregate.additions)
    // payload 形状零新字段：与 round 口径同 key 集合
    expect(Object.keys(cum).sort()).toEqual(Object.keys(round).sort())
    // 显式 scope=round → 与缺省响应逐字一致
    const explicit = await (await app.request(`/api/tasks/${taskId}/round-diff?scope=round`)).json()
    expect(explicit).toEqual(round)
  })

  it("C2: 首轮行 start 锚缺失 → 回落本轮口径（诚实降级，绝不报错）", async () => {
    const [k0, k1, k2] = freshRepo("acc2")
    void k0
    const [taskId] = await newAwaitingTask({ rounds: [
      { round: 1, start: {}, end: { acc2: k1 } }, // 首轮无 start 锚（老行形状）
      { round: 2, start: { acc2: k1 }, end: { acc2: k2 } },
    ] })
    const round = await diffOf(taskId)
    const cum = (await (await app.request(`/api/tasks/${taskId}/round-diff?scope=cumulative`)).json()) as RoundDiffPayload
    expect(cum).toEqual(round)
    expect(cum.aggregate.commits).toBe(1)
  })
})

// ── 票03 (taskboard-modal-v2「≡ 变更」): 执行中轮 live 供货 ──────────────────
// 同一端点（/round-diff、/round-diff/patch）、同一 payload 形状：awaiting 优先
// （上面所有用例即回归），无 awaiting 时回落任务当前 live 轮（running/paused），
// end 锚 = 各仓当前 HEAD。端点无状态 → 「新 commit 落库即出现在下一次 GET」
// 就是 web 端 ≤10s 观测口径的服务端保证；不新增任何路由。
describe("round-diff — 票03 执行中轮 live 供货", () => {
  it("L1: running 轮 start..HEAD — 零变更也是答案；新 commit 落库，下次 GET 立现（无需任何状态变更）", async () => {
    const [k0, , k2] = freshRepo("live1")
    void k0
    // start 锚 = 当前 HEAD（刚起跑，还没有新提交）。
    const [taskId] = await newAwaitingTask({ status: "running", start: { live1: k2 }, end: null, harnessSummary: null })
    // HEAD 仍停在 start 锚：available + 全零（不是 409，也不谎报）。
    const d0 = await diffOf(taskId)
    expect(d0.available).toBe(true)
    expect(d0.aggregate).toEqual({ commits: 0, additions: 0, dels: 0, files: 0 })
    expect(d0.interventions).toBeNull()
    // agent 落了第一个 commit → 下一次拉取即见（AC4 的服务端口径）。
    commitMore("live1", "r3.txt", "3a\n3b\n")
    const d1 = await diffOf(taskId)
    expect(d1.aggregate.commits).toBe(1)
    const paths = d1.repos.find((r) => r.name === "live1")!.groups.flatMap((g) => g.files.map((f) => f.path))
    expect(paths).toEqual(["r3.txt"]) // 本轮口径只看 start 之后的实物
    // 再落一 commit（例：💬 快改每改即提交）→ 再拉再新，端点无状态天然跟随 HEAD。
    commitMore("live1", "r4.txt", "4a\n")
    const d2 = await diffOf(taskId)
    expect(d2.aggregate.commits).toBe(2)
    expect(d2.aggregate.files).toBe(2)
  })

  it("L2: live 轮 patch 懒取同口径；不在 start map 的仓 → 409（所有权闸不变）", async () => {
    const [k0] = freshRepo("live2")
    const [taskId] = await newAwaitingTask({ status: "running", start: { live2: k0 }, end: null })
    const pr = await app.request(
      `/api/tasks/${taskId}/round-diff/patch?repo=live2&path=${encodeURIComponent("r2.txt")}`,
    )
    expect(pr.status).toBe(200)
    const body = (await pr.json()) as { patch: string; truncated: boolean }
    expect(body.patch).toContain("+2a")
    expect((await app.request(`/api/tasks/${taskId}/round-diff/patch?repo=nope&path=x`)).status).toBe(409)
  })

  it("L3: paused 轮同供（暂停不打断实物）", async () => {
    const [k0] = freshRepo("live3")
    const [taskId] = await newAwaitingTask({ status: "paused", start: { live3: k0 }, end: null })
    const d = await diffOf(taskId) // 无 awaiting → live：k0..HEAD(k2) = 2 提交
    expect(d.available).toBe(true)
    expect(d.aggregate.commits).toBe(2)
  })

  it("L4: awaiting 优先律不变 —— 有 awaiting 轮时绝不偷读 live HEAD（存储锚收口即定格）", async () => {
    const [k0, k1] = freshRepo("live4")
    const [taskId] = await newAwaitingTask({ start: { live4: k0 }, end: { live4: k1 } }) // completed → awaiting_review
    commitMore("live4", "r9.txt", "9\n") // 工作区继续前进（HEAD 已越过 end 锚）
    const d = await diffOf(taskId)
    expect(d.aggregate.commits).toBe(1) // 存储锚 k0..k1，r9 不在本轮实物里
    const paths = d.repos.find((r) => r.name === "live4")!.groups.flatMap((g) => g.files.map((f) => f.path))
    expect(paths).not.toContain("r9.txt")
  })

  it("L5: live 轮 cumulative 口径 = 首轮 start 锚..HEAD（累计与本轮同源变化）", async () => {
    const [k0, k1] = freshRepo("live5")
    // 首轮已收口（completed k0..k1），当前轮 R2 running start=k1 end=null，HEAD=k2。
    // 轮号必须错开（R1/R2）：derive 的 latestByRound 只认每轮最新行，同轮双行
    // 会按毫秒运气在 awaiting/live 两解析间摇摆 —— 那是 fixture 缺陷不是被测行为。
    const [taskId] = await newAwaitingTask({ status: "running", round: 2, start: { live5: k1 }, end: null })
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
        task_id, phase_index, round_index, start_commit_id, end_commit_id,
        started_at, completed_at, created_at, updated_at)
      VALUES ('exec-live5-r1', ?, ?, 'task-dev', 'rd', 'completed', ?, 1, 1, ?, ?, ?, ?, ?, ?)
    `).run(WS_ID, ORG, taskId, JSON.stringify({ live5: k0 }), JSON.stringify({ live5: k1 }),
      now, now, now, now)
    const round = await diffOf(taskId)
    expect(round.aggregate.commits).toBe(1) // 本轮 start(k1)..HEAD(k2)
    const cum = (await (await app.request(`/api/tasks/${taskId}/round-diff?scope=cumulative`)).json()) as RoundDiffPayload
    expect(cum.aggregate.commits).toBe(2) // 首轮 start(k0)..HEAD(k2)
    // payload 形状零新字段（web 解析面不变）
    expect(Object.keys(cum).sort()).toEqual(Object.keys(round).sort())
  })
})
