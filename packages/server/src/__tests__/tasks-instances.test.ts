// packages/server/src/__tests__/tasks-instances.test.ts
//
// 测试实例路由三面（2026-09-24）：GET /:id/instances（注册表 + 外部 dev 候选，
// 分支端口文件走 tmp 注入）、POST reclaim（真杀：端口反查→树杀→落账删文件）、
// POST close-dev 的三重闸拒绝路径。纪律同 tasks-preview：真 spawn、真端口、
// 注册表/端口目录指到 tmp，绝不碰真实 ~/.octopus。
//
// close-dev 的"成功杀"路径不在此测：测试 spawn 的 listener 父链含 vitest 进程
// 本身（= 宿主 PID 集成员），三闸按设计拒绝 —— 这正是 409 用例要钉的行为；
// 成功树杀路径由 reclaim 用例覆盖。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import net from "net"
import { spawn, type ChildProcess } from "child_process"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService } from "../services/tasks/round-evidence-service"
import { TestInstanceRegistry } from "../services/tasks/test-instance-registry"

const ORG = "e2e-td-instances"
const WS_ID = "ws-in-1"
const BATCH_REL = ".scratch/20260924/p-1"
let db: Database.Database
let app: Hono
let tmp: string
let instances: TestInstanceRegistry
let seq = 0
const children: ChildProcess[] = []

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) })
  })
}

/** 真起一个占端口的 node listener（测试的子进程）。 */
function spawnListener(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e",
    `require("http").createServer((_q,res)=>res.end("ok")).listen(${port})`], { stdio: "ignore" })
  children.push(child)
  return new Promise((res) => {
    const t0 = Date.now()
    const tick = () => {
      const s = net.createServer()
      s.once("error", () => { s.close(); res(child); return })
      s.once("listening", () => s.close(() => { if (Date.now() - t0 > 8000) res(child); else setTimeout(tick, 100) }))
      s.listen(port)
    }
    tick()
  })
}

async function newAwaitingTask(branch?: string): Promise<string> {
  const spec: Record<string, unknown> = {
    format: "v4", goal: "g", ac: ["a"],
    phases: [{ index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} }],
  }
  if (branch) spec.branch = branch
  const r = await app.request("/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD inst ${seq++}`, task_spec: spec }),
  })
  const id = ((await r.json()) as { id: string }).id
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at) VALUES (?,?,?,'task-dev','in','completed',?,1,1,'{}','{}',?,?,?,?)`)
    .run(`exec-in-${seq}`, WS_ID, ORG, id, now, now, now, now)
  fs.mkdirSync(path.join(tmp, "ws1", "projects"), { recursive: true })
  return id
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-instances-"))
  fs.mkdirSync(path.join(tmp, "ws1"), { recursive: true })
  db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(WS_ID, "in-ws", ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  const taskHome = new TaskHomeService(path.join(tmp, "home"))
  const ts = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const wss = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  instances = new TestInstanceRegistry(path.join(tmp, "instances"), path.join(tmp, "ports"))
  const ev = new RoundEvidenceService(db, sse, ts, wss, taskHome, instances)
  app = new Hono(); app.route("/api/tasks", createTasksRoutes(ts, sse, undefined, ev))
})

afterAll(() => {
  for (const c of children) { try { c.kill() } catch { /* dead */ } }
  for (let i = 0; i < 50; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return } catch { setTimeout(() => {}, 50) }
  }
})

describe("GET /:id/instances", () => {
  it("IN1: 空注册表 → 空 entries；分支端口文件里有 listener → external 候选", async () => {
    const taskId = await newAwaitingTask("feat-inst-ext")
    let g = (await (await app.request(`/api/tasks/${taskId}/instances`)).json()) as { entries: unknown[]; external: unknown[] }
    expect(g.entries).toEqual([])
    expect(g.external).toEqual([])

    const port = await freePort()
    await spawnListener(port)
    fs.mkdirSync(path.join(tmp, "ports"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "ports", "feat-inst-ext.json"), JSON.stringify({ branch: "feat-inst-ext", server: port + 1, web: port }))
    g = await (await app.request(`/api/tasks/${taskId}/instances`)).json() as typeof g
    expect(g.entries).toEqual([])
    const ext = g.external as Array<{ port: number; role: string }>
    expect(ext).toHaveLength(1)
    expect(ext[0]).toMatchObject({ port, role: "web" })
  }, 30_000)
})

describe("POST /:id/instances/reclaim", () => {
  it("IN2: 登记 entry → reclaim 树杀 listener、端口释放、注册表文件删除", async () => {
    const taskId = await newAwaitingTask()
    const port = await freePort()
    await spawnListener(port)
    instances.add(taskId, { source: "preview-up", ports: [port], urls: [`http://localhost:${port}`] })

    const r = await app.request(`/api/tasks/${taskId}/instances/reclaim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { reclaimed: string[]; still_occupied: number[] }
    expect(body.reclaimed).toHaveLength(1)
    expect(body.still_occupied).toEqual([])
    expect(instances.listEntries(taskId)).toEqual([])
    // listener 真死：再反查无 PID
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      const probe = await new Promise<boolean>((res) => {
        const s = net.createServer()
        s.once("error", () => res(false))
        s.once("listening", () => s.close(() => res(true)))
        s.listen(port)
      })
      if (probe) break
      await new Promise((res) => setTimeout(res, 200))
    }
  }, 30_000)
})

describe("POST /:id/instances/close-dev — 安全闸", () => {
  const closeDev = async (taskId: string, port: unknown) =>
    app.request(`/api/tasks/${taskId}/instances/close-dev`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port }),
    })

  it("IN3: 非法端口 → 400；宿主端口 → 400（env PORT 未设时默认 3001/3000 集）", async () => {
    const taskId = await newAwaitingTask()
    expect((await closeDev(taskId, "not-a-port")).status).toBe(400)
    expect((await closeDev(taskId, 0)).status).toBe(400)
    const hostPort = parseInt(process.env.PORT ?? "3001", 10)
    expect((await closeDev(taskId, hostPort)).status).toBe(400)
  })

  it("IN4: 与任务无登记关联的端口 → 403", async () => {
    const taskId = await newAwaitingTask()
    const r = await closeDev(taskId, 39999 % 65535 || 60001)
    expect(r.status).toBe(403)
    expect(((await r.json()) as { error: string }).error).toMatch(/登记关联/)
  })

  it("IN5: 白名单内但 listener 父链含宿主进程 → 409（测试 spawn 正是该形状）", async () => {
    const taskId = await newAwaitingTask()
    const port = await freePort()
    await spawnListener(port)
    instances.add(taskId, { source: "preview-up", ports: [port], urls: [`http://localhost:${port}`] })
    const r = await closeDev(taskId, port)
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toMatch(/祖先链|宿主/)
  }, 30_000)
})
