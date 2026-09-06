// packages/server/src/__tests__/tasks-home-file.test.ts
//
// 契约修复 — GET/PUT /api/tasks/:id/home-file（v4 batch spec.md 审阅/编辑面）。
// 守卫矩阵（与 readArtifactContent 同一 idiom，基目录换 home 根）:
//   • 白名单: 仅 `.scratch/**` 前缀 + `.md` 后缀；context.md / manifest.json /
//     旧名 spec.json / artifacts/… / skills/… 一律 403（它们各有自己的既有端点）。
//   • 逃逸: `../`、盘符绝对路径、null byte → 403；未知任务 → 404。
//   • GET 缺文件 → 404（UI 据此渲染「创建骨架」空态）；目录 → 404。
//   • PUT: 建父目录（UI 增 phase 行后落骨架的硬需求）/ 覆写 / content>512KB →
//     400 / 非可编辑窗口（done）→ 409 / 写后 @@spec_updated notice（SW-BP4）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { getSpecNotice } from "../services/tasks/spec-notice-store"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-homefile"

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService
let seq = 0

/** Create a v4 draft through the route (home included), return its id. */
async function newV4Task(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD hf ${seq}`, task_spec: { format: "v4" } }),
  })
  expect(res.status).toBe(201)
  const dto = (await res.json()) as { id: string }
  return dto.id
}

function get(id: string, rel: string) {
  return app.request(`/api/tasks/${id}/home-file?path=${encodeURIComponent(rel)}`)
}
function put(id: string, rel: string, content: string) {
  return app.request(`/api/tasks/${id}/home-file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: rel, content }),
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-home-file-${Date.now()}`)
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

describe("GET home-file — 读路径与守卫", () => {
  it("G1: 读回 PUT 写过的 .scratch spec.md（live disk content）", async () => {
    const id = await newV4Task()
    const w = await put(id, ".scratch/20260905/p1/spec.md", "# Phase 1\n")
    expect(w.status).toBe(200)
    const r = await get(id, ".scratch/20260905/p1/spec.md")
    expect(r.status).toBe(200)
    const body = (await r.json()) as { path: string; content: string }
    expect(body.content).toBe("# Phase 1\n")
    expect(body.path).toBe(".scratch/20260905/p1/spec.md")

    // 磁盘侧外部修改立刻可见（不缓存）
    fs.writeFileSync(
      path.join(taskHome.homePath(id), ".scratch/20260905/p1/spec.md"),
      "# changed by agent\n",
    )
    const r2 = await get(id, ".scratch/20260905/p1/spec.md")
    expect(((await r2.json()) as { content: string }).content).toBe("# changed by agent\n")
  })

  it("G2: 缺文件 → 404（NOT_FOUND，UI 空态）；目录本身 → 403（前缀需 .scratch/）", async () => {
    const id = await newV4Task()
    expect((await get(id, ".scratch/nope/spec.md")).status).toBe(404)
    expect((await get(id, ".scratch")).status).toBe(403)
  })

  it("G3: 白名单外 → 403（context.md / manifest.json / 旧名 spec.json / artifacts/../ 兄弟 / skills junction）", async () => {
    const id = await newV4Task()
    expect((await get(id, "context.md")).status).toBe(403)
    expect((await get(id, "manifest.json")).status).toBe(403)
    expect((await get(id, "spec.json")).status).toBe(403) // 旧名同样不在白名单
    expect((await get(id, ".scratch/../context.md")).status).toBe(403) // 逃逸出 .scratch → FORBIDDEN
    expect((await get(id, ".scratch/notes.txt")).status).toBe(403)     // 非 .md
    expect((await get(id, "skills/foo/SKILL.md")).status).toBe(403)
  })

  it("G4: 绝对路径 / null byte / 未知任务 / 缺 path → 403/403/404/400", async () => {
    const id = await newV4Task()
    expect((await get(id, "C:/Windows/win.ini")).status).toBe(403)
    expect((await get(id, ".scratch/a\x00b.md")).status).toBe(403)
    expect((await get("e2e-td-no-such-task", ".scratch/a.md")).status).toBe(404)
    expect((await app.request(`/api/tasks/${id}/home-file`)).status).toBe(400)
    expect((await app.request(`/api/tasks/${id}/home-file?path=`)).status).toBe(400)
  })

  it("G5: GET 未知任务不建野 home（404 前置于任何 fs 动作）", async () => {
    const ghost = "e2e-td-ghost-home"
    const r = await get(ghost, ".scratch/x.md")
    expect(r.status).toBe(404)
    expect(fs.existsSync(taskHome.homePath(ghost))).toBe(false)
  })
})

describe("PUT home-file — 写路径（骨架/覆写/守卫/联动）", () => {
  it("W1: 新建深层文件（mkdir -p）+ slug 目录连号 + 覆写幂等", async () => {
    const id = await newV4Task()
    const rel = ".scratch/20260905/phase-2/spec.md"
    const w1 = await put(id, rel, "# Phase 2 draft\n")
    expect(w1.status).toBe(200)
    expect(((await w1.json()) as { bytes: number }).bytes).toBe("# Phase 2 draft\n".length)
    expect(fs.readFileSync(path.join(taskHome.homePath(id), rel), "utf-8")).toBe("# Phase 2 draft\n")
    const w2 = await put(id, rel, "# Phase 2 final\n")
    expect(w2.status).toBe(200)
    expect(fs.readFileSync(path.join(taskHome.homePath(id), rel), "utf-8")).toBe("# Phase 2 final\n")
  })

  it("W2: issues 子目录 md 同样可写（批次目录整树都是 .scratch 白名单）", async () => {
    const id = await newV4Task()
    const w = await put(id, ".scratch/20260905/p1/issues/01-first.md", "# Issue 1\n")
    expect(w.status).toBe(200)
  })

  it("W3: 守卫与 GET 同规 — .scratch 外 / 非 .md / 逃逸 / 绝对 → 403，且不落盘", async () => {
    const id = await newV4Task()
    expect((await put(id, "evil.md", "x")).status).toBe(403)
    expect((await put(id, ".scratch/evil.sh", "x")).status).toBe(403)
    expect((await put(id, ".scratch/../outside.md", "x")).status).toBe(403)
    expect((await put(id, path.join(taskHome.homePath(id), ".scratch", "abs.md"), "x")).status).toBe(403)
    expect(fs.existsSync(path.join(taskHome.homePath(id), "evil.md"))).toBe(false)
    expect(fs.existsSync(path.join(taskHome.homePath(id), "outside.md"))).toBe(false)
  })

  it("W4: content > 512_000 → 400（body 缺陷，不是 403）", async () => {
    const id = await newV4Task()
    expect((await put(id, ".scratch/big.md", "x".repeat(512_001))).status).toBe(400)
    expect((await put(id, ".scratch/big.md", "x".repeat(512_000))).status).toBe(200)
  })

  it("W5: 非可编辑窗口 → 409（done 拒写；draft 放行）", async () => {
    const id = await newV4Task()
    expect((await put(id, ".scratch/live.md", "# ok\n")).status).toBe(200)
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id)
    const r = await put(id, ".scratch/live.md", "# blocked\n")
    expect(r.status).toBe(409)
    expect(fs.readFileSync(path.join(taskHome.homePath(id), ".scratch/live.md"), "utf-8")).toBe("# ok\n")
  })

  it("W6: 写后落 @@spec_updated notice（用户手改，agent 下轮感知）", async () => {
    const id = await newV4Task()
    expect((await put(id, ".scratch/20260905/p9/spec.md", "# touched by user\n")).status).toBe(200)
    const notice = getSpecNotice(id)
    expect(notice).toBeTruthy()
    expect(notice).toContain("@@spec_updated")
    expect(notice).toContain(".scratch/20260905/p9/spec.md")
  })

  it("W7: 写回不动 tasks.version（文件不是行；乐观锁不参与）", async () => {
    const id = await newV4Task()
    const before = (db.prepare("SELECT version FROM tasks WHERE id = ?").get(id) as { version: number }).version
    expect((await put(id, ".scratch/nov-bump.md", "x\n")).status).toBe(200)
    const after = (db.prepare("SELECT version FROM tasks WHERE id = ?").get(id) as { version: number }).version
    expect(after).toBe(before)
  })
})
