// packages/server/src/__tests__/tasks-home-tree.test.ts
//
// 输出区磁盘直扫（2026-09-24「完整路径 + 目录如实显示」拍板）：
//   GET /:id/home-tree     → { dir(绝对路径), entries(原始递归列表，空目录在列) }
//   GET /:id/home-content  → home 下任意常规文件（403/404/413 同 home-file 码）
// harness 抄 tasks-batch-tree.test.ts：真路由 + in-memory DB + tmpDir 注入。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService, MAX_HOME_FILE_READ_BYTES } from "../services/tasks/task-home-service"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-hometree"

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService
let seq = 0

async function newV4Task(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD ht ${seq++}`, task_spec: { format: "v4" } }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

function seed(id: string, rel: string, content = "x\n"): void {
  const full = path.join(taskHome.homePath(id), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
}

function mkdir(id: string, rel: string): void {
  fs.mkdirSync(path.join(taskHome.homePath(id), rel), { recursive: true })
}

interface TreeResp {
  dir: string
  entries: Array<{ path: string; type: "dir" | "file"; bytes: number; mtime: string }>
}

async function getTree(id: string): Promise<{ status: number; body: TreeResp }> {
  const r = await app.request(`/api/tasks/${id}/home-tree`)
  return { status: r.status, body: (await r.json()) as TreeResp }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-home-tree-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as any,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("GET /:id/home-tree — 如实磁盘视图", () => {
  it("T1: dir = 任务 home 绝对路径；文件/目录（含空目录、dot 目录）全在列", async () => {
    const id = await newV4Task()
    seed(id, "artifacts/report.md", "# R\n")
    seed(id, "artifacts/sub/deep.txt", "d")
    mkdir(id, "artifacts/empty-dir")
    seed(id, ".scratch/20260101/p/spec.md", "# S\n")

    const { status, body } = await getTree(id)
    expect(status).toBe(200)
    expect(body.dir).toBe(path.join(tmpDir, "tasks", id))
    const paths = body.entries.map((e) => e.path)
    expect(paths).toContain("artifacts/report.md")
    expect(paths).toContain("artifacts/sub/deep.txt")
    expect(paths).toContain("artifacts/sub/")
    expect(paths).toContain("artifacts/empty-dir/") // 空目录如实显示
    expect(paths).toContain(".scratch/20260101/p/spec.md") // dot 目录不隐藏
    const file = body.entries.find((e) => e.path === "artifacts/report.md")!
    expect(file.type).toBe("file")
    expect(file.bytes).toBe(4)
    expect(file.mtime.length).toBeGreaterThan(10)
    const dir = body.entries.find((e) => e.path === "artifacts/")!
    expect(dir.type).toBe("dir")
    expect(dir.bytes).toBe(0)
  })

  it("T2: POST 建的 home（manifest/context）即刻在列，每层目录在前名字排序", async () => {
    const id = await newV4Task()
    const { body } = await getTree(id)
    const roots = body.entries.filter((e) => !e.path.replace(/\/$/, "").includes("/"))
    expect(roots.map((e) => e.path)).toContain("manifest.json")
    // 逐层排序：同层内 dir 先于 file，之后按名字
    const rootDirs = roots.filter((e) => e.type === "dir").map((e) => e.path)
    const rootFiles = roots.filter((e) => e.type === "file").map((e) => e.path)
    expect(rootDirs).toEqual([...rootDirs].sort())
    expect(rootFiles).toEqual([...rootFiles].sort())
    const dirBoundary = roots.findIndex((e) => e.type === "dir")
    if (dirBoundary >= 0 && rootFiles.length > 0) {
      expect(dirBoundary).toBeLessThan(roots.findIndex((e) => e.type === "file"))
    }
  })

  it("T3: 未知任务 404，且不建野 home", async () => {
    const r = await app.request("/api/tasks/no-such-task/home-tree")
    expect(r.status).toBe(404)
    expect(fs.existsSync(path.join(tmpDir, "tasks", "no-such-task"))).toBe(false)
  })
})

describe("GET /:id/home-content — home 内任意常规文件", () => {
  const get = (id: string, p: string | null) =>
    app.request(`/api/tasks/${id}/home-content${p === null ? "" : `?path=${encodeURIComponent(p)}`}`)

  it("C1: 读 artifacts 与 .scratch 两侧文件（超越 home-file 的 .scratch 白名单）", async () => {
    const id = await newV4Task()
    seed(id, "artifacts/a.md", "# A\n")
    seed(id, ".scratch/20260101/p/spec.md", "# S\n")
    const r1 = await get(id, "artifacts/a.md")
    expect(r1.status).toBe(200)
    expect(((await r1.json()) as { content: string }).content).toBe("# A\n")
    const r2 = await get(id, ".scratch/20260101/p/spec.md")
    expect(r2.status).toBe(200)
  })

  it("C2: 越界/绝对路径 → 403；缺失/目录 → 404；超限 → 413；缺参 → 400", async () => {
    const id = await newV4Task()
    seed(id, "artifacts/a.md")
    expect((await get(id, "../outside.md")).status).toBe(403)
    expect((await get(id, "/etc/passwd")).status).toBe(403)
    expect((await get(id, "artifacts/missing.md")).status).toBe(404)
    expect((await get(id, "artifacts")).status).toBe(404) // 目录
    seed(id, "artifacts/big.md", "x".repeat(MAX_HOME_FILE_READ_BYTES + 1))
    expect((await get(id, "artifacts/big.md")).status).toBe(413)
    expect((await get(id, null)).status).toBe(400)
  })

  it("C3: 未知任务 404", async () => {
    expect((await get("no-such-task", "artifacts/a.md")).status).toBe(404)
  })
})
