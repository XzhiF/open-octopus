// packages/server/src/__tests__/tasks-batch-tree.test.ts
//
// #53 draft-artifact-visibility — GET /api/tasks/:id/batch-tree（磁盘直扫，
// 绕开 phases[] 的「落盘即现」端点）+ v4 manifest 写侧空键噪音过滤（K3）。
// harness 抄 tasks-home-file.test.ts：真路由 + in-memory DB + tmpDir 注入
// TaskHomeService。批次识别 = 直接含 .md 的 .scratch 子树目录（约定日期层 +
// 扁平层双支持）；批内递归 depth ≤2；全局 cap 300；latest_mtime 降序；缺
// .scratch → batches:[] 200；未知任务 404 且不建野 home。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-batchtree"

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService
let seq = 0

async function newV4Task(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD bt ${seq++}`, task_spec: { format: "v4" } }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

function getTree(id: string) {
  return app.request(`/api/tasks/${id}/batch-tree`)
}

/** Write a file under the home, optionally pinning its mtime (ms epoch) so
 *  latest_mtime ordering is deterministic. */
function seed(id: string, rel: string, content = "# x\n", mtimeMs?: number): void {
  const full = path.join(taskHome.homePath(id), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs)
    fs.utimesSync(full, t, t)
  }
}

interface BatchTreeResp {
  batches: Array<{
    dir: string
    slug: string
    files: Array<{ path: string; mtime: string; bytes: number }>
    latest_mtime: string
  }>
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-batch-tree-${Date.now()}`)
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

describe("GET /:id/batch-tree — 布局识别与守卫", () => {
  it("AC1: 约定日期层两批，files 计数正确，latest_mtime 新者在前", async () => {
    const id = await newV4Task()
    // alpha 三文件（spec + 两票），beta 单 spec。beta 更新 → 排前。
    seed(id, ".scratch/20260101/alpha/spec.md", "# Alpha\n", 1_600_000_000_000)
    seed(id, ".scratch/20260101/alpha/issues/01-a.md", "# A\n", 1_600_000_000_000)
    seed(id, ".scratch/20260101/alpha/issues/02-b.md", "# B\n", 1_600_000_001_000)
    seed(id, ".scratch/20260102/beta/spec.md", "# Beta\n", 1_700_000_000_000)

    const r = await getTree(id)
    expect(r.status).toBe(200)
    const { batches } = (await r.json()) as BatchTreeResp
    expect(batches).toHaveLength(2)
    const alpha = batches.find((b) => b.slug === "alpha")!
    const beta = batches.find((b) => b.slug === "beta")!
    expect(alpha).toBeTruthy()
    expect(beta).toBeTruthy()
    expect(alpha.dir).toBe(".scratch/20260101/alpha")
    expect(alpha.files).toHaveLength(3)
    expect(beta.files).toHaveLength(1)
    // paths home 相对 posix，可直接喂 readHomeFile
    expect(alpha.files.map((f) => f.path).sort()).toEqual([
      ".scratch/20260101/alpha/issues/01-a.md",
      ".scratch/20260101/alpha/issues/02-b.md",
      ".scratch/20260101/alpha/spec.md",
    ])
    // 降序：beta (1.7e12) 在 alpha (1.6e12 段) 前
    expect(batches[0].slug).toBe("beta")
    expect(batches[1].slug).toBe("alpha")
    expect(beta.latest_mtime).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("AC2: 非 .md / depth>2 不入 tree；cap 300 截断", async () => {
    const id = await newV4Task()
    seed(id, ".scratch/20260101/p/spec.md")            // 批次锚
    seed(id, ".scratch/20260101/p/notes.txt")          // 非 .md → 排除
    seed(id, ".scratch/20260101/p/issues/01.md")       // depth1 → 收
    seed(id, ".scratch/20260101/p/issues/sub/deep.md") // depth2 → 收（批目录起算第2层子目录）
    seed(id, ".scratch/20260101/p/issues/sub/deeper/x.md") // depth3 → 排除
    const r = await getTree(id)
    const paths = ((await r.json()) as BatchTreeResp).batches[0].files.map((f) => f.path)
    expect(paths).toContain(".scratch/20260101/p/issues/sub/deep.md")
    expect(paths).not.toContain(".scratch/20260101/p/notes.txt")
    expect(paths.some((p) => p.endsWith("deeper/x.md"))).toBe(false)

    // cap: spec.md 锚定批次 + 301 张票 → 全局截断 ≤300
    const id2 = await newV4Task()
    seed(id2, ".scratch/20260101/big/spec.md")
    for (let i = 0; i < 301; i++) seed(id2, `.scratch/20260101/big/issues/${String(i).padStart(3, "0")}.md`)
    const rr = (await (await getTree(id2)).json()) as BatchTreeResp
    const total = rr.batches.reduce((n, b) => n + b.files.length, 0)
    expect(total).toBeLessThanOrEqual(300)
    expect(total).toBeGreaterThan(0)
  })

  it("AC3: 扁平层成批；空 .scratch / 缺 .scratch / 仅根散 md → batches:[]", async () => {
    const flat = await newV4Task()
    seed(flat, ".scratch/legacy/spec.md") // 无日期层
    const fr = (await (await getTree(flat)).json()) as BatchTreeResp
    expect(fr.batches).toHaveLength(1)
    expect(fr.batches[0].dir).toBe(".scratch/legacy")

    // 空 .scratch（目录在但无任何批次子目录）
    const empty = await newV4Task()
    fs.mkdirSync(path.join(taskHome.homePath(empty), ".scratch/20260101/empty-dir"), { recursive: true })
    const er = (await (await getTree(empty)).json()) as BatchTreeResp
    expect(er.batches).toEqual([])

    // 仅 home 根散 .md（context.md 之类），.scratch 不存在 → 空
    const stray = await newV4Task()
    seed(stray, "loose.md")
    fs.rmSync(path.join(taskHome.homePath(stray), ".scratch"), { recursive: true, force: true })
    const sr = (await (await getTree(stray)).json()) as BatchTreeResp
    expect(sr.batches).toEqual([])
  })

  it("AC4: 未知任务 404 且不建野 home", async () => {
    const r = await getTree("e2e-td-bt-ghost")
    expect(r.status).toBe(404)
    expect(fs.existsSync(taskHome.homePath("e2e-td-bt-ghost"))).toBe(false)
  })
})

describe("manifest v4 写侧空键噪音过滤 (K3)", () => {
  function readManifest(id: string): { spec: Record<string, unknown> } {
    return JSON.parse(
      fs.readFileSync(path.join(taskHome.homePath(id), "manifest.json"), "utf-8"),
    )
  }

  it("AC5a: v4 空数组 resources/authoring_resources 被剔除", () => {
    const id = "e2e-td-bt-mf-empty"
    taskHome.createHome(id)
    taskHome.writeManifestFile(id, {
      version: 1,
      format: "v4",
      updated_at: "2026-09-06T00:00:00.000Z",
      spec: { format: "v4", resources: [], authoring_resources: [], decisions: [], phases: [] },
    })
    const { spec } = readManifest(id)
    expect("resources" in spec).toBe(false)
    expect("authoring_resources" in spec).toBe(false)
    // 非空数组不误删（decisions/phases 即便空也不动 —— 不属本键对）
    expect("decisions" in spec).toBe(true)
    expect("phases" in spec).toBe(true)
  })

  it("AC5b: v4 非空 resources/authoring_resources 原样保留", () => {
    const id = "e2e-td-bt-mf-full"
    taskHome.createHome(id)
    taskHome.writeManifestFile(id, {
      version: 1,
      format: "v4",
      updated_at: "2026-09-06T00:00:00.000Z",
      spec: {
        format: "v4",
        resources: [{ type: "skill", name: "tdd" }],
        authoring_resources: [{ type: "agent", name: "researcher" }],
      },
    })
    const { spec } = readManifest(id)
    expect(spec.resources).toEqual([{ type: "skill", name: "tdd" }])
    expect(spec.authoring_resources).toEqual([{ type: "agent", name: "researcher" }])
  })

  it("AC5c: 非 v4（无 format）快照两者不动", () => {
    const id = "e2e-td-bt-mf-v3"
    taskHome.createHome(id)
    taskHome.writeManifestFile(id, {
      version: 1,
      updated_at: "2026-09-06T00:00:00.000Z",
      spec: { resources: [], authoring_resources: [] },
    })
    const { spec } = readManifest(id)
    expect("resources" in spec).toBe(true)
    expect("authoring_resources" in spec).toBe(true)
  })
})
