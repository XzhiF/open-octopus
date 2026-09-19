// packages/server/src/__tests__/tasks-verify.test.ts
//
// 验货台当场复检 — POST/GET /api/tasks/:id/verify(+ /abort)。
// 门链断言：未配置 400 → 起会话 202 running → echo 终态 passed + verdict .md
// 落批次目录 + taskpool SSE（running/terminal/log）三事件齐 → exit≠0 failed →
// 并发 409 → abort → timeout（timeoutS 下限 5s）→ cwd 逃逸 400 → ws 不在 409。
// BashExecutor 走真 spawn（darwin/linux bash；Windows 由 OCTOPUS_BASH_PATH 兜底，
// 与引擎 bash 节点同路），故本套是真集成测试而非 mock 演练。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { execFileSync } from "node:child_process"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService, buildPerRepoVerifyBash, type VerifySummary } from "../services/tasks/round-evidence-service"
import { TASK_VERIFY_EVENT, TASK_VERIFY_LOG_EVENT } from "@octopus/shared"

const ORG = "e2e-td-verify"
const WS_ID = "ws-vf-1"
const BATCH_REL = ".scratch/20260916/p-1"

let db: Database.Database
let app: Hono
let sse: SSEService
let tmp: string
let wsDir: string
let taskHome: TaskHomeService
let seq = 0
let sseEvents: Array<{ event: string; data: Record<string, unknown> }> = []
let unSub: (() => void) | null = null

/** v4 任务（draft — isSpecEditable 放行）+ completed phase1/round1 exec → awaiting_review。 */
async function newAwaitingTask(workspaceId = WS_ID): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      org: ORG,
      name: `E2E_TD vf ${seq++}`,
      task_spec: {
        format: "v4", goal: "g", ac: ["a1"],
        phases: [
          { index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} },
        ],
      },
    }),
  })
  expect(res.status).toBe(201)
  const taskId = ((await res.json()) as { id: string }).id
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id,
      started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'task-dev', 'vf', 'completed', ?, 1, 1, '{}', '{}', ?, ?, ?, ?)
  `).run(`exec-vf-${seq}`, workspaceId, ORG, taskId, now, now, now, now)
  return taskId
}

async function setVerify(taskId: string, value: unknown): Promise<Response> {
  return app.request(`/api/tasks/${taskId}/spec-field`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field: "acceptance_verify", value, source: "user" }),
  })
}

async function pollTerminal(taskId: string, timeoutMs = 15_000): Promise<VerifySummary> {
  const t0 = Date.now()
  for (;;) {
    const r = await app.request(`/api/tasks/${taskId}/verify`)
    const s = (await r.json()) as VerifySummary | null
    expect(s, "verify session vanished").toBeTruthy()
    if (s && s.state !== "running") return s
    if (Date.now() - t0 > timeoutMs) throw new Error(`verify did not settle in ${timeoutMs}ms`)
    await new Promise((res) => setTimeout(res, 50))
  }
}

function batchHomeFiles(taskId: string): string[] {
  const dir = path.join(taskHome.homePath(taskId), BATCH_REL)
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-verify-"))
  wsDir = path.join(tmp, "ws1", "projects")
  fs.mkdirSync(wsDir, { recursive: true })
  db.prepare(`
    INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
    VALUES (?, 'vf-ws', ?, ?, ?, ?)
  `).run(WS_ID, ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())

  sse = new SSEService()
  unSub = sse.subscribe("taskpool", (e) => {
    sseEvents.push({ event: e.event, data: e.data as Record<string, unknown> })
  })
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const tasksService = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never,
  )
  const workspaceService = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  const evidence = new RoundEvidenceService(db, sse, tasksService, workspaceService, taskHome)
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse, undefined, evidence))
})

afterAll(() => {
  unSub?.()
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("verify — 门链与终态", () => {
  it("V1: echo → running→passed；exit 0；verdict .md 落批次目录；SSE 三事件齐", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "echo hello-verify", timeoutS: 30 })).status).toBe(200)
    sseEvents = []
    const start = await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })
    expect(start.status).toBe(202)
    const running = (await start.json()) as VerifySummary
    expect(running.state).toBe("running")
    expect(running.round_index).toBe(1)

    const done = await pollTerminal(taskId)
    expect(done.state).toBe("passed")
    expect(done.exit_code).toBe(0)
    expect(done.duration_ms).toBeGreaterThanOrEqual(0)
    expect(done.verdict_path).toContain(`${BATCH_REL}/verify-r1-`)
    expect(done.tail?.join("\n")).toContain("hello-verify")

    const verdicts = batchHomeFiles(taskId).filter((f) => f.startsWith("verify-r1-") && f.endsWith(".md"))
    expect(verdicts.length).toBe(1)
    const md = fs.readFileSync(path.join(taskHome.homePath(taskId), BATCH_REL, verdicts[0]!), "utf-8")
    expect(md).toContain("PASSED")
    expect(md).toContain("echo hello-verify")
    expect(md).toContain("hello-verify")

    const verifyEvents = sseEvents.filter((e) => e.event === TASK_VERIFY_EVENT)
    expect(verifyEvents.some((e) => e.data.state === "running")).toBe(true)
    expect(verifyEvents.some((e) => e.data.state === "passed" && e.data.verdict_path)).toBe(true)
    expect(sseEvents.some((e) => e.event === TASK_VERIFY_LOG_EVENT && String(e.data.line).includes("hello-verify"))).toBe(true)
  })

  it("V2: 非零退出 → failed + 退出码", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "echo bad >&2; exit 3", timeoutS: 30 })).status).toBe(200)
    expect((await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })).status).toBe(202)
    const done = await pollTerminal(taskId)
    expect(done.state).toBe("failed")
    expect(done.exit_code).toBe(3)
  })

  it("V3: 未配置命令 → 400（TaskSpecFieldError 路由分类）", async () => {
    const taskId = await newAwaitingTask()
    const r = await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain("未配置复检命令")
  })

  it("V4: 在跑时二次 POST → 409；随后 abort → aborted", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "sleep 30", timeoutS: 60 })).status).toBe(200)
    expect((await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })).status).toBe(202)
    expect((await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })).status).toBe(409)
    const ab = await app.request(`/api/tasks/${taskId}/verify/abort`, { method: "POST" })
    expect(ab.status).toBe(200)
    const done = await pollTerminal(taskId)
    expect(done.state).toBe("aborted")
  })

  it("V5: 超时分类 — sleep 30 / timeoutS 5 → timeout（无 exitCode 也定得住）", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "sleep 30", timeoutS: 5 })).status).toBe(200)
    expect((await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })).status).toBe(202)
    const done = await pollTerminal(taskId)
    expect(done.state).toBe("timeout")
  }, 20_000)

  it("V6: cwd 逃逸出工作区 → 400，且不起会话", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "echo x", cwd: "../../../../tmp" })).status).toBe(200)
    const r = await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain("逃逸")
    expect((await app.request(`/api/tasks/${taskId}/verify`)).status).toBe(200) // session=null
  })

  it("V7: 工作区目录不存在 → 409（诚实降级，不是 500）", async () => {
    // FK 开启 → 真插一行 workspaces 指向已不存在的目录（比 fake id 更贴真实场景）
    const ghostWs = "ws-vf-ghost"
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'ghost', ?, ?, ?, ?)
    `).run(ghostWs, ORG, path.join(tmp, "gone"), now, now)
    const taskId = await newAwaitingTask(ghostWs)
    expect((await setVerify(taskId, { command: "echo x", timeoutS: 30 })).status).toBe(200)
    const r = await app.request(`/api/tasks/${taskId}/verify`, { method: "POST" })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toContain("工作区")
  })

  it("V8: 命令值形状守门 — 空 command 400 / timeoutS 越界 400", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "" })).status).toBe(400)
    expect((await setVerify(taskId, { command: "echo ok", timeoutS: 2 })).status).toBe(400)
    expect((await setVerify(taskId, { command: "echo ok", timeoutS: 999999 })).status).toBe(400)
  })

  it("V9: null 清空 — spec JSON 里键整个消失（不是 null 毒化后续 parse）", async () => {
    const taskId = await newAwaitingTask()
    expect((await setVerify(taskId, { command: "echo ok", timeoutS: 30 })).status).toBe(200)
    expect((await setVerify(taskId, null)).status).toBe(200)
    const spec = db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(taskId) as { task_spec: string }
    const parsed = JSON.parse(spec.task_spec) as Record<string, unknown>
    expect("acceptance_verify" in parsed).toBe(false)
  })

  it("V10: per_repo 逐仓复检 — 两仓 marker 齐 → passed；一仓缺 → failed（聚合退出码）", async () => {
    // 在共享 ws1/projects 下铺两个假 git 仓（[ -e .git ] 判 worktree）
    const mk = (name: string, withMarker: boolean) => {
      const d = path.join(tmp, "ws1", "projects", name)
      fs.rmSync(d, { recursive: true, force: true })
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, ".git"), "gitdir: x\n")
      if (withMarker) fs.writeFileSync(path.join(d, "marker.txt"), "1")
    }
    mk("repo-a", true)
    mk("repo-b", true)
    const okTask = await newAwaitingTask()
    expect((await setVerify(okTask, { command: "test -f marker.txt", per_repo: true, timeoutS: 60 })).status).toBe(200)
    expect((await app.request(`/api/tasks/${okTask}/verify`, { method: "POST" })).status).toBe(202)
    expect((await pollTerminal(okTask)).state).toBe("passed")

    // repo-b 去 marker → 任一仓失败即整体 failed
    fs.rmSync(path.join(tmp, "ws1", "projects", "repo-b", "marker.txt"), { force: true })
    const badTask = await newAwaitingTask()
    expect((await setVerify(badTask, { command: "test -f marker.txt", per_repo: true, timeoutS: 60 })).status).toBe(200)
    expect((await app.request(`/api/tasks/${badTask}/verify`, { method: "POST" })).status).toBe(202)
    expect((await pollTerminal(badTask)).state).toBe("failed")
  })

  it("V11: buildPerRepoVerifyBash 生成逐仓循环骨架", () => {
    const bash = buildPerRepoVerifyBash("mvn -B test")
    expect(bash).toContain("for D in projects/*/")
    expect(bash).toContain('[ -e "$D/.git" ]')
    expect(bash).toContain('( cd "$D" && mvn -B test ) || rc=1')
    expect(bash.trimEnd().endsWith("exit $rc")).toBe(true)
  })
})

// ── 剧本探针单发执行 (POST /:id/playbook/run) ───────────────────────────
describe("playbook probe — 同步单发,就地盖章", () => {
  it("PR1: echo → passed, exit 0, tail 带回显;工作区根为 cwd", async () => {
    const taskId = await newAwaitingTask()
    const res = await app.request(`/api/tasks/${taskId}/playbook/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo probe-hello && pwd" }),
    })
    expect(res.status).toBe(200)
    const r = (await res.json()) as { state: string; exit_code: number | null; tail: string[] }
    expect(r.state).toBe("passed")
    expect(r.exit_code).toBe(0)
    expect(r.tail.join("\n")).toContain("probe-hello")
    expect(r.tail.join("\n")).toContain(path.join(tmp, "ws1")) // ws 根 cwd
  })

  it("PR2: 断言失败 → failed + 真实退出码(C 票步 5 形状)", async () => {
    const taskId = await newAwaitingTask()
    const res = await app.request(`/api/tasks/${taskId}/playbook/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "test 1 = 2 && echo data == false" }),
    })
    const r = (await res.json()) as { state: string; exit_code: number | null }
    expect(r.state).toBe("failed")
    expect(r.exit_code).not.toBe(0)
  })

  it("PR3: 尾随 & 拉起式包成 nohup,秒回且服务真活着(防 close 挂死→组杀)", async () => {
    const taskId = await newAwaitingTask()
    const t0 = Date.now()
    const res = await app.request(`/api/tasks/${taskId}/playbook/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "sleep 60 &", timeoutS: 10 }),
    })
    const r = (await res.json()) as { state: string; tail: string[] }
    expect(Date.now() - t0).toBeLessThan(8000) // 不挂满 timeout
    expect(r.state).toBe("passed")
    expect(r.tail.join(" ")).toContain("launcher")
    const out = execFileSync("pgrep", ["-f", "[s]leep 60"], { encoding: "utf8" }).trim()
    expect(out.length).toBeGreaterThan(0) // 服务没被组杀火葬
    for (const pid of out.split("\n")) { try { process.kill(Number(pid), "SIGKILL") } catch { /* gone */ } }
  })

  it("PR4: 空命令/超长 → 400;无 awaiting → 409", async () => {
    const taskId = await newAwaitingTask()
    expect((await app.request(`/api/tasks/${taskId}/playbook/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "  " }),
    })).status).toBe(400)
    expect((await app.request("/api/tasks/no-such-task/playbook/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "true" }),
    })).status).toBe(404) // 任务不存在 = 404（resolveAwaiting 的 NotFound 语义）
  })
})
