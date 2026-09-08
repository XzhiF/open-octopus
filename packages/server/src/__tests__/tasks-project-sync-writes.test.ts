// packages/server/src/__tests__/tasks-project-sync-writes.test.ts
//
// 特性A 写路径触发矩阵（tasks-service 2026-09-08）：三条 project_ids 写路径
// （POST 直建 / PUT / spec-field "projects"）在 **v4** 时把镜像同步打给
// RepoSyncService；v3/legacy 行零触发（范围闸门）。context.md 写入携带
// freshnessNotes（有快照才注）。不动 tasks-v3-gates（AC2 字节不变纪律）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import type { RepoSyncService } from "../services/tasks/repo-sync-service"

const ORG = "e2e-td-psync"

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService
const syncCalls: string[] = []

function makeStub(): RepoSyncService {
  return {
    syncProjectsForTask: (taskId: string, org: string | undefined, names: string[]) => {
      syncCalls.push(`${taskId}|${org}|${names.join(",")}`)
    },
    // PUT 路径在触发同步的同一毫秒读 notes → 返回一条 syncing 标注验证注入面。
    freshnessNotes: (_taskId: string, names: string[]) =>
      Object.fromEntries(names.map((n) => [n, "⚠ 同步未完成，代码可能过期"])),
    hasSnapshot: () => true,
    waitUntilIdle: async () => {},
    isBusy: () => false,
  } as unknown as RepoSyncService
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-psync-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, null, makeStub(),
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("v4 写路径 → 镜像同步触发", () => {
  it("POST 直建 v4 带 project_ids → syncProjectsForTask(taskId, org, names)", async () => {
    const { status, json } = await postJson("/api/tasks", {
      org: ORG, name: "E2E_TD psync-create", task_spec: { format: "v4" }, project_ids: ["p-alpha"],
    })
    expect(status).toBe(201)
    expect(syncCalls).toContain(`${json.id}|${ORG}|p-alpha`)
  })

  it("v3（task_type）带 project_ids → 不触发（闸门）", async () => {
    syncCalls.length = 0
    const { status, json } = await postJson("/api/tasks", {
      org: ORG, name: "E2E_TD psync-v3", task_type: "generic", preset: { org: ORG, projects: ["p-v3"] },
    })
    expect(status).toBe(201)
    expect(syncCalls).toEqual([])
    void json
  })

  it("PUT project_ids（v4 首锁路径）→ 触发 + context.md 带新鲜度行", async () => {
    syncCalls.length = 0
    const created = await postJson("/api/tasks", { org: ORG, name: "E2E_TD put", task_spec: { format: "v4" } })
    expect(created.status).toBe(201)
    expect(syncCalls).toEqual([]) // 建时无项目 → 不触发

    const put = await app.request(`/api/tasks/${created.json.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": String(created.json.version) },
      body: JSON.stringify({ project_ids: ["p-lock"] }),
    })
    expect(put.status).toBe(200)
    expect(syncCalls).toContain(`${created.json.id}|${ORG}|p-lock`)

    const ctx = fs.readFileSync(path.join(taskHome.homePath(created.json.id), "context.md"), "utf-8")
    expect(ctx).toContain("仓库新鲜度: ⚠ 同步未完成，代码可能过期")
  })

  it("spec-field projects（v4）→ 触发；同请求 v3 行 → 不触发", async () => {
    syncCalls.length = 0
    const v4 = await postJson("/api/tasks", { org: ORG, name: "E2E_TD sf-v4", task_spec: { format: "v4" } })
    const sf = await postJson(`/api/tasks/${v4.json.id}/spec-field`, { field: "projects", value: ["p-sf"] })
    expect(sf.status).toBe(200)
    expect(syncCalls).toContain(`${v4.json.id}|${ORG}|p-sf`)

    syncCalls.length = 0
    const v3 = await postJson("/api/tasks", { org: ORG, name: "E2E_TD sf-v3", task_type: "generic" })
    const sf3 = await postJson(`/api/tasks/${v3.json.id}/spec-field`, { field: "projects", value: ["p-x"] })
    expect(sf3.status).toBe(200)
    expect(syncCalls).toEqual([])
  })
})
