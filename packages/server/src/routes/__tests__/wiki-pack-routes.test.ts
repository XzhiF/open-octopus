// packages/server/src/routes/__tests__/wiki-pack-routes.test.ts
//
// P3 票02 — 素材包路由（S2 契约面；票面第 4/6 行：剔除→重编译端点、历史兼容读）。
//
// Seam：Hono app.request 打 GET /pack/:taskId 与 POST /pack/:taskId/recompile——
// 真 fs 包（经票02 契约模块冻结）+ 假 CompileQueue（记录入队；手动泵触发 closure）+
// compilePack seam mock。断言对外形状：状态码/响应体/manifest 落盘面/队列任务面。
// expected 真相源：票02 票面 + spec「素材包」，禁反向抄实现。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { createWikiPackRoutes } from "../wiki-pack"
import { MaterialPackOpsService } from "../../services/knowledge/pack-ops"
import { freezePackItem, writePackManifest, type MaterialPackManifest } from "../../services/knowledge/material-pack"
import type { QueueTaskView, WriteQueue } from "../../services/knowledge/wiki/compile-queue"

let tmpRoot: string
let knowledgeRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa02-packr-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const TASK = "aa02r-task1"

interface Enq {
  opKind: string
  taskId?: string
  label?: string
  fn: () => Promise<unknown>
}

function makeApp(seed = true) {
  const enqs: Enq[] = []
  const packCalls: Array<{ taskId: string; opts: { focus?: string } | undefined }> = []
  const fakeQueue: WriteQueue = {
    enqueue: (opKind, fn, opts) => {
      enqs.push({ opKind, taskId: opts?.taskId, label: opts?.label, fn })
      return { id: opts?.taskId ?? "wq-x", opKind, state: "queued", position: 1, queuedAt: "2026-10-14T00:00:00Z" } as QueueTaskView
    },
    get: () => undefined,
    list: () => [],
    depth: () => 0,
  }
  if (seed) seedPack()
  const ops = new MaterialPackOpsService({
    root: knowledgeRoot,
    queue: fakeQueue,
    compilePack: async (taskId, opts) => { packCalls.push({ taskId, opts }) },
    now: () => new Date("2026-10-14T09:00:00.000Z"),
  })
  const app = new Hono()
  app.route("/api/knowledge/wiki", createWikiPackRoutes(ops))
  return { app, enqs, packCalls }
}

function seedPack(): MaterialPackManifest {
  const items = [
    freezePackItem(knowledgeRoot, TASK, { fileName: "01-acceptance-ledger.md", kind: "acceptance-ledger", name: "验收台账", origin: `db:task_phase_acceptances:${TASK}`, title: "台账", payload: "# 台账\n- phase 1 accepted\n" }),
    freezePackItem(knowledgeRoot, TASK, { fileName: "02-phase-rejections.md", kind: "phase-rejections", name: "phase 打回记录", origin: `db:task_phase_acceptances:${TASK}#rejected`, title: "打回", payload: "# 打回\n- phase 2 round 1 rejected：cookie 未清\n" }),
    freezePackItem(knowledgeRoot, TASK, { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", name: "执行 JSONL 关键事件摘录", origin: `exec:${TASK}`, title: "摘录", payload: "# 摘录\n- error 登录接口 500\n" }),
    freezePackItem(knowledgeRoot, TASK, { fileName: "07-archive-summary.md", kind: "archive-summary", name: "归档总结", origin: `task-archive:${TASK}`, title: "总结", payload: "# 总结\n" }),
  ]
  const manifest: MaterialPackManifest = { v: 1, taskId: TASK, createdAt: "2026-10-14T08:00:00.000Z", items, recompiles: [] }
  writePackManifest(knowledgeRoot, TASK, manifest)
  return manifest
}

function manifestOnDisk(): MaterialPackManifest {
  return JSON.parse(fs.readFileSync(path.join(knowledgeRoot, "raw", "archives", `task-${TASK}`, "manifest.json"), "utf-8"))
}

describe("GET /api/knowledge/wiki/pack/:taskId — manifest 视图 + 历史兼容（S2）", () => {
  it("包在盘 ⇒ 200：件清单逐件 kind/name/path/bytes/sha256（素材包卡数据面）", async () => {
    const { app } = makeApp()
    const res = await app.request(`/api/knowledge/wiki/pack/${TASK}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.taskId).toBe(TASK)
    expect(body.packPath).toBe(`raw/archives/task-${TASK}`)
    expect(body.manifestPath).toBe(`raw/archives/task-${TASK}/manifest.json`)
    expect(body.items).toHaveLength(4)
    const ledger = body.items.find((i: any) => i.kind === "acceptance-ledger")
    expect(ledger.name).toBe("验收台账")
    expect(ledger.bytes).toBeGreaterThan(0)
    expect(ledger.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ledger.excluded ?? false).toBe(false)
  })

  it("旧单文件归档 ⇒ 200 legacy 兼容读（不迁移不报错）；两者皆无 ⇒ 404 PACK_NOT_FOUND", async () => {
    fs.mkdirSync(path.join(knowledgeRoot, "raw", "archives"), { recursive: true })
    fs.writeFileSync(path.join(knowledgeRoot, "raw", "archives", "task-oldtask9-summary.md"), "---\norigin: \"task-archive:oldtask9\"\n---\n旧总结\n", "utf-8")
    const { app } = makeApp(false)
    const res = await app.request("/api/knowledge/wiki/pack/oldtask9")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.legacy).toBe(true)
    expect(body.rawPath).toBe("raw/archives/task-oldtask9-summary.md")

    const miss = await app.request("/api/knowledge/wiki/pack/ghost")
    expect(miss.status).toBe(404)
    expect(((await miss.json()) as any).error.code).toBe("PACK_NOT_FOUND")
  })

  it("taskId 含非法字符 ⇒ 400（文件名注入零容忍，同 TASK_ID_RE 律）", async () => {
    const { app } = makeApp()
    const res = await app.request(`/api/knowledge/wiki/pack/${encodeURIComponent("../evil")}`)
    expect(res.status).toBe(400)
  })
})

describe("POST /api/knowledge/wiki/pack/:taskId/recompile — 剔除重编译经全局串行队列（S2·红线2）", () => {
  it("剔除某件 ⇒ 202：manifest 该件标记 excluded（本体不删）+ 入队 archive-compile（禁直写 wiki）；队列任务执行时调 compilePack 读包", async () => {
    const { app, enqs, packCalls } = makeApp()
    const excludePath = `raw/archives/task-${TASK}/03-exec-jsonl-excerpt.md`
    const res = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excludePath }),
    })
    expect(res.status).toBe(202)
    const ack = (await res.json()) as any
    expect(ack.queueTaskId).toBe(`arc-${TASK}-rc1`)
    expect(ack.excludedPath).toBe(excludePath)

    // 入队面：全局串行队列 opKind 复用 archive-compile（单源枚举，未旁路）
    expect(enqs).toHaveLength(1)
    expect(enqs[0].opKind).toBe("archive-compile")
    expect(enqs[0].taskId).toBe(`arc-${TASK}-rc1`)
    expect(enqs[0].label).toBe(`raw/archives/task-${TASK}/manifest.json`)

    // manifest 落盘面：excluded 标记 + 审计行；素材件本体仍在盘（不可变源不删）
    const m = manifestOnDisk()
    expect(m.items.find(i => i.path === excludePath)?.excluded).toBe(true)
    expect(fs.existsSync(path.join(knowledgeRoot, excludePath))).toBe(true)
    expect(m.recompiles).toEqual([{ at: "2026-10-14T09:00:00.000Z", excludePath, queueTaskId: `arc-${TASK}-rc1`, focus: null }])

    // 队列轮到 ⇒ compilePack 收包身份（读包重编译执行体；剔除件不再进输入由编译面断言）
    await enqs[0].fn()
    expect(packCalls).toEqual([{ taskId: TASK, opts: {} }])
  })

  it("焦点重编译（不剔件）⇒ 202 + 队列 closure 带 focus 原样进编译面", async () => {
    const { app, enqs, packCalls } = makeApp()
    const res = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ focus: "重新编译，重点看 phase-2 打回那段" }),
    })
    expect(res.status).toBe(202)
    await enqs[0].fn()
    expect(packCalls[0]).toEqual({ taskId: TASK, opts: { focus: "重新编译，重点看 phase-2 打回那段" } })
  })

  it("剔除件不在包内 ⇒ 400 INVALID_PARAM；剔除已 excluded 件 ⇒ 409 ALREADY_EXCLUDED；剔除总结件以外的路径穿越 ⇒ 400", async () => {
    const { app } = makeApp()
    const bad = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ excludePath: `raw/archives/task-${TASK}/99-ghost.md` }),
    })
    expect(bad.status).toBe(400)

    const traversal = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ excludePath: `raw/archives/task-${TASK}/../../inbox/evil.md` }),
    })
    expect(traversal.status).toBe(400)

    const ok = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ excludePath: `raw/archives/task-${TASK}/02-phase-rejections.md` }),
    })
    expect(ok.status).toBe(202)
    const twice = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ excludePath: `raw/archives/task-${TASK}/02-phase-rejections.md` }),
    })
    expect(twice.status).toBe(409)
    expect(((await twice.json()) as any).error.code).toBe("ALREADY_EXCLUDED")
  })

  it("重编译入队 id 递增确定（rc2 不撞 rc1）；连续两次剔除 ⇒ 两条队列任务", async () => {
    const { app, enqs } = makeApp()
    for (const p of ["01-acceptance-ledger.md", "02-phase-rejections.md"]) {
      const res = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ excludePath: `raw/archives/task-${TASK}/${p}` }),
      })
      expect(res.status).toBe(202)
    }
    expect(enqs.map(e => e.taskId)).toEqual([`arc-${TASK}-rc1`, `arc-${TASK}-rc2`])
  })

  it("无包（历史单文件任务）⇒ 404（对话剔除重编译只面向素材包形态）", async () => {
    const { app } = makeApp(false)
    const res = await app.request(`/api/knowledge/wiki/pack/${TASK}/recompile`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })
})
