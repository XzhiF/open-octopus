// packages/server/src/__tests__/tasks-semantic-summary.test.ts
//
// 归档资产化 P3 票06 — 语义摘要进任务板（S1 服务层 + S2 路由缝，真 tmpdir DB）。
//
// 断言的外部行为（expected 真相源 = 票面/spec 故事25-26，非实现反推）：
//   ① tasks 表加列 semantic_summary（schema-migration 先例：新库 CREATE 带列 + 旧库
//      ensureColumn 补列，历史行读出 NULL 宽容不报错）。
//   ② DAO 写摘要 = 定向 UPDATE，不动 status（done 唯一写者不变）、不动 version
//      （metadata 写非 spec 编辑，不 409 并发规格写 —— bindDoerSession/updateAutosave 先例）。
//   ③ 归档链：ArchiveIngestService.ingestTask 总结成功后把独立字段写入 semantic_summary
//      （多面：关键决策 + 产出指针 facet 均在，指「独立字段=整份摘要」而非首段截断）。
//   ④ 搜索面：listTasks({q}) + GET /api/tasks?q= 服务端 LIKE 命中 name 或 summary；
//      q 空时列盘面不受影响；NULL 摘要宽容不崩。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { TaskDAO } from "../db/dao/task-dao"
import { SSEService } from "../services/sse"
import { WorkspaceService } from "../services/workspace"
import { WorkspaceDAO } from "../db/dao/workspace-dao"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RawIngestService } from "../services/knowledge/raw"
import { CompileQueue } from "../services/knowledge/wiki/compile-queue"
import { ArchiveIngestService } from "../services/tasks/archive-ingest-service"

const ORG = "aa06-org"

let db: Database.Database
let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa06-"))
  // 真 tmpdir DB（票面 S1「真 tmpdir DB」）：文件落盘，非纯内存。
  db = new Database(path.join(tmp, "octopus.db"))
  db.pragma("foreign_keys = ON")
  applySchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function tasksTableNameHasCol(col: string): boolean {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  return cols.some((c) => c.name === col)
}

function insertTask(id: string, name: string, status = "done"): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources,
      skills, project_ids, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', '[]', '[]', '[]', '[]', 1, ?, ?)
  `).run(id, ORG, name, status, now, now)
}

// ── ① schema-migration：新库带列 + 旧库补列 + 历史 NULL 宽容 ───────────

describe("票06 semantic_summary 迁移（schema-migration 先例）", () => {
  it("新库 applySchema 后 tasks 表含 semantic_summary 列", () => {
    expect(tasksTableNameHasCol("semantic_summary")).toBe(true)
  })

  it("旧库（无该列）applySchema 补列，历史行读出 NULL 不报错", () => {
    db.close()
    // 造一张缺 semantic_summary 的旧 tasks 表 + 一行历史数据。
    const oldDbPath = path.join(tmp, "old.db")
    const old = new Database(oldDbPath)
    old.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, org TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', source_chat_session_id TEXT,
        task_spec TEXT NOT NULL DEFAULT '{}', authoring_resources TEXT NOT NULL DEFAULT '[]',
        resources TEXT NOT NULL DEFAULT '[]', skills TEXT NOT NULL DEFAULT '[]',
        project_ids TEXT NOT NULL DEFAULT '[]', workflow_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, completed_at TEXT, workspace_id TEXT DEFAULT NULL,
        trigger_mode TEXT NOT NULL DEFAULT 'manual', trigger_at TEXT, cron_expression TEXT,
        cron_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', trigger_enabled INTEGER NOT NULL DEFAULT 1,
        next_fire_at TEXT, last_fired_at TEXT, doer_session_id TEXT
      )
    `)
    old.prepare(`
      INSERT INTO tasks (id, org, name, status, created_at, updated_at)
      VALUES ('legacy-1', 'x', '旧任务', 'done', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
    `).run()
    old.close()

    // 以旧库重开并跑 applySchema —— ensureColumn 补列。
    db = new Database(oldDbPath)
    db.pragma("foreign_keys = ON")
    applySchema(db)
    expect(tasksTableNameHasCol("semantic_summary")).toBe(true)
    const row = db.prepare("SELECT semantic_summary FROM tasks WHERE id='legacy-1'").get() as {
      semantic_summary: string | null
    }
    expect(row.semantic_summary).toBeNull() // 宽容读：历史 NULL，不抛
  })
})

// ── ② DAO 写面：定向 UPDATE，不碰 status/version ──────────────────────

describe("票06 TaskDAO.setSemanticSummary 写面纪律", () => {
  it("写入摘要后读回；status 与 version 均不变（done 唯一写者/乐观锁零扰动）", () => {
    insertTask("t1", "Actuator 端点补齐")
    const dao = new TaskDAO(db)
    const before = dao.getById("t1")!
    const ok = dao.setSemanticSummary("t1", "干了什么：补齐 actuator。关键决策：复用既有信道。")
    expect(ok).toBe(true)
    const after = dao.getById("t1")!
    expect(after.semantic_summary).toContain("actuator")
    expect(after.status).toBe(before.status) // 不碰生命周期态
    expect(after.version).toBe(before.version) // 不 bump 乐观锁版本
  })

  it("对不存在的行返回 false（幂等无副作用）", () => {
    const dao = new TaskDAO(db)
    expect(dao.setSemanticSummary("missing", "x")).toBe(false)
  })
})

// ── ④ 搜索面：listTasks({q}) 服务端 LIKE（name ∨ semantic_summary）─────

describe("票06 任务板搜索命中语义摘要（服务端 LIKE）", () => {
  let svc: TasksService

  beforeEach(() => {
    const sse = new SSEService()
    const taskHome = new TaskHomeService(path.join(tmp, "home"))
    svc = new TasksService(
      db, sse, new AgentSessionDAO(db), taskHome,
      undefined, null, null,
      new WorkspaceService(new WorkspaceDAO(db)),
    )
  })

  it("q 命中 semantic_summary → 归档任务进结果；无摘要未归档任务不受影响", () => {
    insertTask("arch", "无关标题") // 归档摘要里带关键词，标题不带
    new TaskDAO(db).setSemanticSummary("arch", "本次做 actuator 观测端点，关键决策走既有面")
    insertTask("plain", "普通草稿") // 无摘要，未归档
    const draft = db.prepare("UPDATE tasks SET status='draft' WHERE id='plain'").run()
    expect(draft.changes).toBe(1)

    const hit = svc.listTasks({ q: "actuator" }).items.map((t) => t.id)
    expect(hit).toContain("arch")
    expect(hit).not.toContain("plain")

    // q 命中 name：与摘要无关的搜索也照常工作
    expect(svc.listTasks({ q: "普通草稿" }).items.map((t) => t.id)).toContain("plain")

    // 无 q：盘面全量，两行都在（NULL 摘要不参与、不报错）
    const all = svc.listTasks().items.map((t) => t.id)
    expect(all).toContain("arch")
    expect(all).toContain("plain")
  })

  it("q 组合 status/org 过滤仍生效", () => {
    insertTask("a1", "计费重构", "done")
    new TaskDAO(db).setSemanticSummary("a1", "重构计费，产出指针 PR#12")
    insertTask("a2", "计费重构", "draft") // 同名不同态
    const onlyDone = svc.listTasks({ q: "计费", status: "done" }).items.map((t) => t.id)
    expect(onlyDone).toEqual(["a1"])
    const onlyOrg = svc.listTasks({ q: "计费", org: ORG }).items.map((t) => t.id)
    expect(onlyOrg.sort()).toEqual(["a1", "a2"])
  })

  it("空 q / 纯空白 q = 不过滤（回归保护）", () => {
    insertTask("b1", "任务一")
    expect(svc.listTasks({ q: "   " }).items.map((t) => t.id)).toContain("b1")
    expect(svc.listTasks({ q: "" }).items.map((t) => t.id)).toContain("b1")
  })

  it("GET /api/tasks?q= 路由透出 q 并 LIKE 命中摘要", async () => {
    const sse = new SSEService()
    const taskHome = new TaskHomeService(path.join(tmp, "home2"))
    const service = new TasksService(
      db, sse, new AgentSessionDAO(db), taskHome,
      undefined, null, null,
      new WorkspaceService(new WorkspaceDAO(db)),
    )
    const app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))

    insertTask("r1", "看板搜索")
    new TaskDAO(db).setSemanticSummary("r1", "语义摘要含 kw-needle-9001 用于路由命中")
    insertTask("r2", "另一条")

    const res = await app.request("/api/tasks?q=kw-needle-9001")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string }[] }
    expect(body.items.map((t) => t.id)).toEqual(["r1"])

    const all = (await (await app.request("/api/tasks")).json()) as { items: { id: string }[] }
    expect(all.items.map((t) => t.id).sort()).toEqual(["r1", "r2"])
  })

  it("DTO 读出 semantic_summary（多面带 facet 标记）", () => {
    insertTask("d1", "带摘要任务")
    new TaskDAO(db).setSemanticSummary("d1", "决策：X；指针：Y")
    const dto = svc.listTasks({ q: "指针" }).items[0]
    expect(dto?.semantic_summary).toContain("指针")
    // 无摘要任务读出 null（宽容）
    insertTask("d2", "无摘要")
    const d2 = svc.listTasks({ q: "无摘要" }).items[0]
    expect(d2?.semantic_summary).toBeNull()
  })
})

// ── ③ 归档链：ingestTask 总结成功 → semantic_summary 落库 ─────────────

describe("票06 归档链写入 semantic_summary（独立字段=多面摘要）", () => {
  const v4spec = JSON.stringify({
    format: "v4", goal: "补齐 actuator 观测端点", ac: ["a"],
    phases: [{ index: 1, name: "P1", slug: "p-1" }],
    decisions: ["复用既有信道"],
  })

  function seedArchivingTask(id: string): void {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources,
        skills, project_ids, version, created_at, updated_at)
      VALUES (?, ?, ?, 'archiving', ?, '[]', '[]', '[]', '[]', 1, ?, ?)
    `).run(id, ORG, `归档摘要任务 ${id}`, v4spec, now, now)
  }

  it("总结返回多段文本后，semantic_summary 落库含关键决策与产出指针 facet", async () => {
    seedArchivingTask("arc-ok")
    const knowledgeRoot = path.join(tmp, "knowledge")
    const queue = new CompileQueue()
    const summary = [
      "# 归档总结",
      "",
      "## 关键决策",
      "- 复用既有 metadata 通道，不新建表",
      "",
      "## 产出指针",
      "- 分支 feat-aa-06；PR pointer: octopus#74",
      "",
    ].join("\n")
    const svc = new ArchiveIngestService({
      db,
      taskHomeService: new TaskHomeService(path.join(tmp, "home")),
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue,
      // 票02 素材包链：compile 单指针入口升级为 compilePack 读包入口（seam 替身不变义）
      compilePack: async () => ({}),
      summarize: async () => summary,
    })
    const outcome = await svc.ingestTask("arc-ok")
    expect(outcome.status).toBe("ingested")

    const row = new TaskDAO(db).getById("arc-ok")!
    // 多面都在 = 存的是整份独立字段（facet 跨越首段，非首段截断）。
    expect(row.semantic_summary).toContain("复用既有 metadata 通道")
    expect(row.semantic_summary).toContain("octopus#74")
    // 归档写入不碰生命周期态（此刻仍 archiving，done 由 endArchiving 唯一写者决定）。
    expect(row.status).toBe("archiving")
  })

  it("总结为空（离线闸）→ 不写 semantic_summary（NULL 保持）", async () => {
    seedArchivingTask("arc-empty")
    const svc = new ArchiveIngestService({
      db,
      taskHomeService: new TaskHomeService(path.join(tmp, "home")),
      rawIngest: new RawIngestService({ root: path.join(tmp, "knowledge") }),
      queue: new CompileQueue(),
      compilePack: async () => ({}),
      summarize: async () => "",
    })
    const outcome = await svc.ingestTask("arc-empty")
    expect(outcome.status).toBe("skipped")
    expect(new TaskDAO(db).getById("arc-empty")!.semantic_summary).toBeNull()
  })
})
