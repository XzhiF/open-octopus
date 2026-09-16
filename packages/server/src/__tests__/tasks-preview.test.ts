// packages/server/src/__tests__/tasks-preview.test.ts
//
// 跑起来看(spec T03)。真 spawn:BashExecutor 起 `node http server` → 探活转
// ready → stop 释放端口;外部进程占 url → 无会话 GET 报 external;秒退命令 →
// exited;未配置/非法url/$vars./无awaiting 门链。端口用 net 抢 ephemeral 避免撞车。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import net from "net"
import http from "http"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService, type PreviewSummary } from "../services/tasks/round-evidence-service"
import { TASK_PREVIEW_EVENT } from "@octopus/shared"

const ORG = "e2e-td-preview"
const WS_ID = "ws-pv-1"
const BATCH_REL = ".scratch/20260917/p-1"
let db: Database.Database
let app: Hono
let tmp: string
let taskHome: TaskHomeService
let seq = 0
let sseEvents: string[] = []
let unSub: (() => void) | null = null

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) })
  })
}

async function newAwaitingTask(): Promise<string> {
  const r = await app.request("/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD pv ${seq++}`, task_spec: {
      format: "v4", goal: "g", ac: ["a"],
      phases: [{ index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} }],
    } }),
  })
  const id = ((await r.json()) as { id: string }).id
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at) VALUES (?,?,?,'task-dev','pv','completed',?,1,1,'{}','{}',?,?,?,?)`)
    .run(`exec-pv-${seq}`, WS_ID, ORG, id, now, now, now, now)
  // worktree 目录需存在(preview 校验 existsSync(ws.path))
  fs.mkdirSync(path.join(tmp, "ws1", "projects"), { recursive: true })
  return id
}
async function setPreview(taskId: string, value: unknown): Promise<Response> {
  return app.request(`/api/tasks/${taskId}/spec-field`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ field: "acceptance_preview", value, source: "user" }),
  })
}
async function pollPreview(taskId: string, want: (s: PreviewSummary | null) => boolean, ms = 12_000): Promise<PreviewSummary | null> {
  const t0 = Date.now()
  for (;;) {
    const r = await app.request(`/api/tasks/${taskId}/preview`)
    const s = (await r.json()) as PreviewSummary | null
    if (want(s)) return s
    if (Date.now() - t0 > ms) return s
    await new Promise((res) => setTimeout(res, 120))
  }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-preview-"))
  fs.mkdirSync(path.join(tmp, "ws1"), { recursive: true })
  db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(WS_ID, "pv-ws", ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  unSub = sse.subscribe("taskpool", (e) => { if (e.event === TASK_PREVIEW_EVENT) sseEvents.push((e.data as { state: string }).state) })
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const ts = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const wss = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  const ev = new RoundEvidenceService(db, sse, ts, wss, taskHome)
  app = new Hono(); app.route("/api/tasks", createTasksRoutes(ts, sse, undefined, ev))
})
afterAll(() => { unSub?.(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe("preview — 生命周期", () => {
  it("PV1: 起 node http server → ready → stop → 端口释放", async () => {
    const taskId = await newAwaitingTask()
    const port = await freePort()
    const cmd = `node -e "require('http').createServer((_q,s)=>s.end('ok')).listen(${port})"`
    expect((await setPreview(taskId, { command: cmd, url: `http://localhost:${port}/` })).status).toBe(200)
    sseEvents = []
    const start = await app.request(`/api/tasks/${taskId}/preview`, { method: "POST" })
    expect(start.status).toBe(202)
    expect(((await start.json()) as PreviewSummary).state).toBe("starting")
    const ready = await pollPreview(taskId, (s) => s?.state === "ready")
    expect(ready?.state).toBe("ready")
    expect(sseEvents).toContain("starting")
    expect(sseEvents).toContain("ready")
    // stop
    const stop = await app.request(`/api/tasks/${taskId}/preview/stop`, { method: "POST" })
    expect(stop.status).toBe(200)
    const gone = await pollPreview(taskId, (s) => s?.state === "stopped", 6000)
    expect(gone?.state).toBe("stopped")
    // 端口应已释放:再探 → stopped(非 external)
    const after = (await (await app.request(`/api/tasks/${taskId}/preview`)).json()) as PreviewSummary
    expect(after.state).toBe("stopped")
    expect(after.external).toBeFalsy()
  }, 20_000)

  it("PV2: 秒退命令 → exited(带 exit_code),非 running", async () => {
    const taskId = await newAwaitingTask()
    await setPreview(taskId, { command: "echo up && node -e 'process.exit(3)'", url: "http://localhost:1/x" })
    await app.request(`/api/tasks/${taskId}/preview`, { method: "POST" })
    const s = await pollPreview(taskId, (x) => x?.state === "exited")
    expect(s?.state).toBe("exited")
    expect(s?.exit_code).toBe(3)
  }, 15_000)

  it("PV3: 未配置 → 400;非法 url → 400;$vars. → 400", async () => {
    const taskId = await newAwaitingTask()
    expect((await app.request(`/api/tasks/${taskId}/preview`, { method: "POST" })).status).toBe(400)
    await setPreview(taskId, { command: "echo x", url: "not a url" })
    expect((await app.request(`/api/tasks/${taskId}/preview`, { method: "POST" })).status).toBe(400)
    await setPreview(taskId, { command: "echo $vars.foo", url: "http://localhost:9/x" })
    expect((await app.request(`/api/tasks/${taskId}/preview`, { method: "POST" })).status).toBe(400)
  }, 10_000)

  it("PV4: 外部进程占 url(无会话)→ GET 报 external ready", async () => {
    const taskId = await newAwaitingTask()
    const port = await freePort()
    const server = http.createServer((_q, s) => s.end("ext")).listen(port)
    await new Promise((r) => server.once("listening", r as () => void))
    await setPreview(taskId, { command: "echo noop", url: `http://localhost:${port}/` })
    const g = await pollPreview(taskId, (s) => s?.external === true)
    expect(g?.external).toBe(true)
    expect(g?.state).toBe("ready")
    server.close()
  }, 10_000)
})
