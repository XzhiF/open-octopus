// packages/server/src/__tests__/tasks-artifact-manifest.test.ts
//
// 票 11 ⑩回补 — ▣ 产物页签的只读薄端点（唯一新增 seam）：
//   GET /api/tasks/:id/artifacts/manifest          → 分组清单
//   GET /api/tasks/:id/artifacts/manifest/content?path= → 现读文本（预览最小实现）
//
// 票面原文写 `GET /api/tasks/:id/artifacts`，但该路径已被票 06 产物索引占用
// （响应 = ArtifactIndexEntry[]，web ArtifactsCard 在用，字段不可破）。故分组清单
// 落同子树新叶 `/artifacts/manifest`（additive，不破既有契约）。
//
// AC4 四态：
//   ① 分组正确：需求票面 spec/issues · 轮次报告 report · 证据 evidence ·
//      验收台账 acceptance-ledger · 原型 prototype（工作区仓内 prototype 目录）；
//   ② 路径守卫：所有引用限定 任务 home `.scratch/**` / 工作区根内；
//      `..` 遍历 → 400，绝对路径/越界 → 403（ArtifactAccessError FORBIDDEN 惯例）；
//   ③ 缺文件 → 该组空数组优雅降级（200 不 404）；任务不存在 → 404；
//   ④ content 现读 = 磁盘内容；未登记/越界 → 403/400；白名单内但缺文件 → 404；
//      超 MAX_HOME_FILE_READ_BYTES → 413。
//
// Anti-fake-run: real better-sqlite3 + applySchema + real TaskHomeService（temp home）
// + real workspace dir（temp）+ Hono app.request；数据前缀 E2E_TDM_；断言响应体 +
// readFileSync 交叉核对。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, WorkspaceDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { WorkspaceService } from "../services/workspace"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService, MAX_HOME_FILE_READ_BYTES } from "../services/tasks/task-home-service"

const ORG = "e2e-tdm"

let db: Database.Database
let app: Hono
let homeBase: string
let wsBase: string
let taskHome: TaskHomeService

function writeHome(taskId: string, rel: string, content: string): void {
  const abs = path.join(taskHome.homePath(taskId), ...rel.split("/"))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

function writeWs(rel: string, content: string): void {
  const abs = path.join(wsBase, ...rel.split("/"))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

async function createTask(name: string): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org: ORG, task_type: "coding", name }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: string }
  return body.id
}

interface ManifestItem { name: string; path: string; bytes: number; mtime: string }
interface ManifestGroup { key: string; label: string; items: ManifestItem[] }
interface ManifestBody { groups: ManifestGroup[] }

const group = (body: ManifestBody, key: string): ManifestGroup =>
  body.groups.find((g) => g.key === key)!

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  homeBase = fs.mkdtempSync(path.join(os.tmpdir(), "tdm-home-"))
  wsBase = fs.mkdtempSync(path.join(os.tmpdir(), "tdm-ws-"))
  taskHome = new TaskHomeService(homeBase)
  const sse = new SSEService()
  const service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome,
    undefined, null, null,
    new WorkspaceService(new WorkspaceDAO(db)),
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(homeBase, { recursive: true, force: true })
  fs.rmSync(wsBase, { recursive: true, force: true })
})

describe("GET /:id/artifacts/manifest — 分组清单（AC4①/③）", () => {
  it("五组齐、归类正确、路径引用限定 home:/.scratch 与 ws:", async () => {
    const taskId = await createTask("E2E_TDM manifest groups")
    const B = `.scratch/taskboard-demo`
    writeHome(taskId, `${B}/spec.md`, "# E2E_TDM spec")
    writeHome(taskId, `${B}/issues/01-shell.md`, "ticket 01")
    writeHome(taskId, `${B}/issues/02-tabs.md`, "ticket 02")
    writeHome(taskId, `${B}/round-report-r1.md`, "report claims")
    writeHome(taskId, `${B}/fix-report-r1.md`, "fix report")
    writeHome(taskId, `${B}/acceptance-ledger-r1.md`, "ledger append-only")
    writeHome(taskId, `${B}/evidence/e2e-data/run.txt`, "41 passed")
    writeHome(taskId, `${B}/probe/snap.json`, `{"ok":true}`)
    writeHome(taskId, `${B}/run.log`, "exit 0")
    writeHome(taskId, `${B}/.hidden`, "dot noise")
    // home 根（.scratch 之外）的文件绝不入清单（守卫面）
    writeHome(taskId, `outside.md`, "NOT AN ARTIFACT")
    // 工作区 + 绑定执行（原型组扫描根）
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
      VALUES ('ws-tdm-1', 'E2E_TDM ws', ?, ?, 'manual', 'active', ?, ?)`).run(ORG, wsBase, now, now)
    db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
      VALUES ('exec-tdm-1', 'ws-tdm-1', '0', 0, 'built-in/wf', 'wf', 'completed', '{}', '{}', ?, ?, ?, ?, 1, 1)`)
      .run(ORG, now, now, taskId)
    writeWs("public/prototype/taskboard-v2.html", "<!doctype html>prototype")
    writeWs("packages/web-app/public/prototype/other.md", "proto notes")
    writeWs("packages/web-app/public/prototype/.DS_Store", "noise")
    writeWs("packages/web-app/README.md", "not prototype")

    const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest`)
    expect(res.status).toBe(200)
    const body = await res.json() as ManifestBody
    expect(body.groups.map((g) => g.key)).toEqual(["spec", "report", "evidence", "ledger", "prototype"])

    const spec = group(body, "spec")
    expect(spec.items.map((i) => i.name).sort()).toEqual(["01-shell.md", "02-tabs.md", "spec.md"])
    for (const item of spec.items) {
      expect(item.path.startsWith(`home:.scratch/taskboard-demo/`)).toBe(true)
      expect(item.bytes).toBeGreaterThan(0)
    }
    expect(group(body, "report").items.map((i) => i.name).sort())
      .toEqual(["fix-report-r1.md", "round-report-r1.md"])
    // 轮次报告口径只认 round/fix-report*.md；.log/.txt/.json 属证据族
    // （ticket 原文 evidence 示例含 pnpm-test.log）。
    expect(group(body, "evidence").items.map((i) => i.name).sort())
      .toEqual(["run.log", "run.txt", "snap.json"])
    expect(group(body, "ledger").items.map((i) => i.name)).toEqual(["acceptance-ledger-r1.md"])
    expect(group(body, "prototype").items.map((i) => i.name).sort())
      .toEqual(["other.md", "taskboard-v2.html"])
    for (const item of group(body, "prototype").items) {
      expect(item.path.startsWith("ws:")).toBe(true)
    }
    // 噪声与越界面：dotfile / home 根文件 / 非 prototype 仓文件绝迹
    const allPaths = body.groups.flatMap((g) => g.items.map((i) => i.path))
    expect(allPaths.some((p) => p.includes(".hidden") || p.includes("outside") || p.includes("DS_Store") || p.includes("README"))).toBe(false)
  })

  it("缺文件 = 各空组优雅降级（200 + 五组齐、items 全空）", async () => {
    const taskId = await createTask("E2E_TDM empty degrade")
    const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest`)
    expect(res.status).toBe(200)
    const body = await res.json() as ManifestBody
    expect(body.groups.map((g) => g.key)).toEqual(["spec", "report", "evidence", "ledger", "prototype"])
    for (const g of body.groups) expect(g.items).toEqual([])
  })

  it("任务不存在 → 404", async () => {
    const res = await app.request("/api/tasks/no-such-task-tdm/artifacts/manifest")
    expect(res.status).toBe(404)
  })
})

describe("GET /:id/artifacts/manifest/content — 现读 + 遍历守卫（AC4②/④）", () => {
  let taskId: string

  beforeAll(async () => {
    taskId = await createTask("E2E_TDM content door")
    writeHome(taskId, ".scratch/demo/spec.md", "# E2E_TDM live content")
    writeHome(taskId, ".scratch/demo/evidence/big.log", "x".repeat(MAX_HOME_FILE_READ_BYTES + 1))
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
      VALUES ('ws-tdm-2', 'E2E_TDM ws2', ?, ?, 'manual', 'active', ?, ?)`).run(ORG, wsBase, now, now)
    db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
      VALUES ('exec-tdm-2', 'ws-tdm-2', '0', 0, 'built-in/wf', 'wf', 'completed', '{}', '{}', ?, ?, ?, ?, 1, 1)`)
      .run(ORG, now, now, taskId)
    writeWs("public/prototype/live.html", "<html>E2E_TDM live proto</html>")
  })

  it("home 引用现读 = 磁盘内容（readFileSync 交叉核对）", async () => {
    const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent("home:.scratch/demo/spec.md")}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { path: string; content: string }
    expect(body.path).toBe("home:.scratch/demo/spec.md")
    expect(body.content).toBe(fs.readFileSync(path.join(taskHome.homePath(taskId), ".scratch/demo/spec.md"), "utf-8"))
  })

  it("ws 引用现读（原型预览走同扇门）", async () => {
    const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent("ws:public/prototype/live.html")}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string }
    expect(body.content).toContain("E2E_TDM live proto")
  })

  it("`..` 遍历 → 400（home 与 ws 两种前缀同闸）", async () => {
    for (const bad of ["home:../../secret", "home:.scratch/../escape.md", "ws:../outside.txt"]) {
      const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent(bad)}`)
      expect(res.status, bad).toBe(400)
    }
  })

  it("绝对路径 / 未知前缀 / 空白名单区 → 403", async () => {
    const cases = [
      "home:C:/Windows/win.ini",
      "home:/etc/passwd",
      `other:.scratch/demo/spec.md`,
      "home:skills/foo.md", // .scratch 之外（home 内）也不许走这扇门
    ]
    for (const bad of cases) {
      const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent(bad)}`)
      expect(res.status, bad).toBe(403)
    }
  })

  it("白名单形内但磁盘缺文件 → 404；path 缺失/空 → 400", async () => {
    const missing = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent("home:.scratch/demo/nope.md")}`)
    expect(missing.status).toBe(404)
    const noParam = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content`)
    expect(noParam.status).toBe(400)
    const empty = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=%20`)
    expect(empty.status).toBe(400)
  })

  it("超读取上限 → 413（TOO_LARGE 惯例同 home-file 门）", async () => {
    const res = await app.request(`/api/tasks/${taskId}/artifacts/manifest/content?path=${encodeURIComponent("home:.scratch/demo/evidence/big.log")}`)
    expect(res.status).toBe(413)
  })
})
