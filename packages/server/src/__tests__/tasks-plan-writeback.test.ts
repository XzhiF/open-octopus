// packages/server/src/__tests__/tasks-plan-writeback.test.ts
//
// 票02 计划回写端点 · spec 侧（S1 主 seam）—— 契约测试对 HTTP 面打：
//   POST /api/tasks/:id/plan  body {batch, file, content, reason, source}
// 期望值全部取自票面/规格/ADR-0026 的契约文案（防自证）：
//   · 成功 = 200 + home 盘文件内容以请求 content 开头 + 文末「## 变更记录」一行（时间 · actor · source · reason · 文件）
//   · 状态闸 = done/aborted/archiving → 409（对齐 isSpecEditable 既有判定；paused/takeover/fixing 非落库态，
//     落库恒 running —— 由「running 可写」用例覆盖其派生面）
//   · reason/source 缺失或空白 → 400；server 不判语义（任意非空 reason 皆放行）
//   · 路径限批次内（复用 resolveWithinRoot 不放宽）→ 越界 403；任务不存在 404
//   · actor = server 按 DB 推定（活跃 task-fix 执行 > doer 会话 > unattributed），body 自报身份不采信（.strict() → 400）
//   · 变更记录多次写入按时间累积不覆盖
//   · 写成功后既有产物 manifest 即列出该文件（零 manifest 改动）
// harness 先例：tasks-ledger-columns.test.ts（in-memory DB + Hono 直调 + tmp home）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"

const ORG = "pwb-02"
const BATCH1 = ".scratch/20261010/p-1"
const BATCH2 = ".scratch/20261010/p-2" // 后续 phase 批次（Q8b：跨 phase 回写合法）
let db: Database.Database
let app: Hono
let tmp: string
let taskHome: TaskHomeService
let seq = 0

/** 盘上真相的独立读取口（断言用，不经被测服务）。 */
function readHome(taskId: string, rel: string): string {
  return fs.readFileSync(path.join(taskHome.homePath(taskId), rel), "utf-8")
}

/** v4 双 phase 任务；status 直改 DB（绕状态机，与台账先例同形）。 */
async function seedTask(status: string): Promise<string> {
  const r = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      org: ORG,
      name: `PWB-02 ${seq++}`,
      task_spec: {
        format: "v4", goal: "g", ac: ["a"], autoAdvance: false,
        phases: [
          { index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH1}/spec.md`, workflowRef: "task-dev", inputValues: {} },
          { index: 2, name: "P2", slug: "p-2", specPath: `./${BATCH2}/spec.md`, workflowRef: "task-dev", inputValues: {} },
        ],
      },
    }),
  })
  expect(r.status).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  db.prepare(`UPDATE tasks SET status=? WHERE id=?`).run(status, id)
  return id
}

function postPlan(taskId: string, body: unknown): Promise<Response> {
  return app.request(`/api/tasks/${taskId}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pwb-02-"))
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run("ws-pwb-02", "pwb-ws", ORG, tmp, now, now)
  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const ts = new TasksService(db, sse, new AgentSessionDAO(db), taskHome)
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(ts, sse))
})
afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe("票02 AC1 — 成功路径：写入 home 批次内 spec 并落变更记录", () => {
  it("合法请求 → 200 写入摘要；盘上文件以请求 content 开头；文末「## 变更记录」恰好一行且字段齐（时间·actor·source·reason·文件）", async () => {
    const id = await seedTask("running")
    const content = "# Phase 1 规格\n\n范围改为：弹窗收窄至 480px，去透明蒙层。\n"
    const res = await postPlan(id, {
      batch: BATCH1,
      file: "spec.md",
      content,
      reason: "打回反馈第 2 条指向范围表述错误",
      source: "打回 r1 第 2 条",
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { task_id: string; path: string; bytes: number; actor: string }
    expect(json.task_id).toBe(id)
    expect(json.path).toBe(`${BATCH1}/spec.md`)
    expect(json.bytes).toBeGreaterThan(0)
    expect(json.actor).toBeTruthy()

    const onDisk = readHome(id, `${BATCH1}/spec.md`)
    // 计划正文 = 请求 content（变更记录节在其后，由 server 机械追加）。
    expect(onDisk.startsWith(content)).toBe(true)
    expect(onDisk).toContain("## 变更记录")
    const entries = onDisk.split("\n").filter((l) => l.startsWith("- "))
    expect(entries).toHaveLength(1)
    // 契约行形如：`- <ISO时间> · <actor> · <source> · <reason> · <文件>`
    expect(entries[0]).toMatch(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(entries[0]).toContain(" · ")
    expect(entries[0]).toContain("打回 r1 第 2 条")
    expect(entries[0]).toContain("打回反馈第 2 条指向范围表述错误")
    expect(entries[0]).toContain(`${BATCH1}/spec.md`)
    // actor 由 server 盖章（此 fixture 无会话/执行归属）→ 回落 unattributed，绝不吃 body。
    expect(json.actor).toBe("unattributed")
    expect(entries[0]).toContain("unattributed")
  })
})

describe("票02 AC3 — reason/source 必填 400，server 不判语义", () => {
  const valid = {
    batch: BATCH1, file: "spec.md",
    content: "x\n",
    reason: "r", source: "s",
  }

  it.each([
    ["缺 reason", { ...valid, reason: undefined }],
    ["reason 纯空白", { ...valid, reason: "   " }],
    ["reason 空串", { ...valid, reason: "" }],
    ["缺 source", { ...valid, source: undefined }],
    ["source 纯空白", { ...valid, source: "  " }],
    ["缺 batch", { ...valid, batch: undefined }],
    ["缺 file", { ...valid, file: undefined }],
  ])("%s → 400 且不落盘", async (_label, body) => {
    const id = await seedTask("running")
    const res = await postPlan(id, body)
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(taskHome.homePath(id), BATCH1, "spec.md"))).toBe(false)
  })

  it("不判语义：无关键词的任意非空 reason 放行 200（把关在人不在字符串）", async () => {
    const id = await seedTask("running")
    const res = await postPlan(id, { ...valid, reason: "asdfgh 随手改一下", source: "接管对话" })
    expect(res.status).toBe(200)
  })
})

describe("票02 AC4 — 状态闸对齐既有 spec 可编辑判定", () => {
  // 落库态集合（tasks.status CHECK）：paused/takeover/fixing 是派生态，落库恒
  // running —— 派生放行面由 running 用例覆盖（fixing 的归属面由 AC6 用例钉）。
  it.each(["running", "awaiting_review"])("%s 可写 → 200", async (status) => {
    const id = await seedTask(status)
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(200)
  })

  it.each(["done", "aborted", "archiving"])("%s 终态拒写 → 409 且不落盘", async (status) => {
    const id = await seedTask(status)
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(409)
    expect(fs.existsSync(path.join(taskHome.homePath(id), BATCH1, "spec.md"))).toBe(false)
  })
})

describe("票02 AC2 — batch 可指后续 phase；文件限批次内（复用守卫不放宽）；404 先行", () => {
  it("batch 指向后续 phase 批次（P2 未开工）→ 200 写进 p-2 目录", async () => {
    const id = await seedTask("running") // 当前 phase 1 在跑
    const res = await postPlan(id, {
      batch: BATCH2, file: "spec.md", content: "# Phase 2 规格（提前纠错）\n", reason: "r", source: "s",
    })
    expect(res.status).toBe(200)
    expect(readHome(id, `${BATCH2}/spec.md`)).toContain("# Phase 2 规格（提前纠错）")
  })

  it("file 以 .. 逃批次目录 → 403，目标文件不动", async () => {
    const id = await seedTask("running")
    const pre = await postPlan(id, { batch: BATCH2, file: "spec.md", content: "P2 原文\n", reason: "r", source: "s" })
    expect(pre.status).toBe(200)
    const res = await postPlan(id, {
      batch: BATCH1, file: "../p-2/spec.md", content: "洗掉P2\n", reason: "r", source: "s",
    })
    expect(res.status).toBe(403)
    expect(readHome(id, `${BATCH2}/spec.md`)).toContain("P2 原文")
  })

  it.each([
    ["file 含 .. 多级逃逸", { batch: BATCH1, file: "../../evil.md" }],
    ["file 绝对形态", { batch: BATCH1, file: "C:/Windows/x.md" }],
    ["batch 含 .. 逃逸 home", { batch: "../outside/spec", file: "spec.md" }],
    ["batch 区内折叠 ..（.scratch/../ 形，输入缺陷一律拒）", { batch: ".scratch/../elsewhere", file: "spec.md" }],
    ["batch 绝对形态", { batch: "/etc", file: "x.md" }],
  ])("%s → 403", async (_label, part) => {
    const id = await seedTask("running")
    const res = await postPlan(id, { ...part, content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(403)
  })

  it("非 .md 文件 → 403（既有写门白名单，零放宽）", async () => {
    const id = await seedTask("running")
    const res = await postPlan(id, { batch: BATCH1, file: "spec.txt", content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(403)
  })

  it("任务不存在 → 404（先于任何路径/fs 动作）", async () => {
    const res = await postPlan("no-such-task-42", { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(404)
  })
})

describe("票02 AC5 — 变更记录累积不覆盖（史书不是最新一页）", () => {
  it("连续三次回写：旧正文被新正文整替，但变更行按序全留在同一节内", async () => {
    const id = await seedTask("running")
    const w1 = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "V1 初稿\n", reason: "首轮落地", source: "接管对话" })
    expect(w1.status).toBe(200)
    const w2 = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "V2 扩了错误分支\n", reason: "范围要加一层", source: "打回 r1 第 2 条" })
    expect(w2.status).toBe(200)
    // 第三次请求正文自带一节「历史」（含一条伪造行）—— 节由 server 单源重建：
    // 盘上真史保留，伪造行不落账（账本不可被自报粉饰，US8 的机写不靠自觉）。
    const w3 = await postPlan(id, {
      batch: BATCH1, file: "spec.md",
      content: "V3 终稿\n\n## 变更记录\n\n- 伪造：自称更早的一行 · 假的 · 假的 · 假的 · spec.md\n",
      reason: "收口", source: "修复轮",
    })
    expect(w3.status).toBe(200)

    const onDisk = readHome(id, `${BATCH1}/spec.md`)
    expect(onDisk.startsWith("V3 终稿")).toBe(true)
    expect((onDisk.match(/^## 变更记录$/gm) ?? [])).toHaveLength(1)
    const entries = onDisk.split("\n").filter((l) => l.startsWith("- "))
    expect(entries).toHaveLength(3)
    expect(entries[0]).toContain("首轮落地")
    expect(entries[1]).toContain("范围要加一层")
    expect(entries[2]).toContain("收口")
    expect(entries[2]).toContain("修复轮")
    expect(onDisk).not.toContain("伪造")
  })
})

describe("票02 AC6 — actor 由 server 按 DB 推定，body 自报身份不采信", () => {
  function bindDoer(taskId: string, sessionId: string): void {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO chat_sessions (id, workspace_id, title, is_active, created_at, updated_at)
      VALUES (?, 'ws-pwb-02', ?, 1, ?, ?)`).run(sessionId, `task-doer · ${taskId}`, now, now)
    db.prepare(`UPDATE tasks SET doer_session_id = ? WHERE id = ?`).run(sessionId, taskId)
  }
  function seedExec(taskId: string, opts: { workflowRef: string; status: string; execId: string }): void {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, created_at, updated_at)
      VALUES (?, 'ws-pwb-02', ?, ?, 'e', ?, ?, 1, 2, ?, ?)`)
      .run(opts.execId, ORG, opts.workflowRef, opts.status, taskId, now, now)
  }

  it("doer 会话绑定 → actor = task-doer(session=…)（响应与变更行同源）", async () => {
    const id = await seedTask("awaiting_review")
    bindDoer(id, "sess-doer-1")
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { actor: string }).actor).toBe("task-doer(session=sess-doer-1)")
    expect(readHome(id, `${BATCH1}/spec.md`)).toContain("· task-doer(session=sess-doer-1) ·")
  })

  it("body 自报身份字段 → 400 响亮拒收（.strict()，不静默忽略也不采信）", async () => {
    const id = await seedTask("running")
    const res = await postPlan(id, {
      batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s", actor: "root",
    })
    expect(res.status).toBe(400)
  })

  it("拍板规则钉：fixing 两态并存（活跃 task-fix 执行 + doer 会话均在场）→ 归 task-fix 不双计", async () => {
    const id = await seedTask("running") // fixing 的落库态恒 running（派生态）
    bindDoer(id, "sess-doer-2")
    seedExec(id, { workflowRef: "built-in/task-fix", status: "running", execId: "exec-fix-1" })
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "反馈指向规格即改", source: "修复轮 r2" })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { actor: string }).actor).toBe("task-fix(execution=exec-fix-1)")
    const line = readHome(id, `${BATCH1}/spec.md`)
    expect(line).toContain("· task-fix(execution=exec-fix-1) ·")
    expect(line).not.toContain("sess-doer-2")
  })

  it("活跃执行非 task-fix（绑定流在跑）→ 不抢归属，仍归 doer 会话", async () => {
    const id = await seedTask("running")
    bindDoer(id, "sess-doer-3")
    seedExec(id, { workflowRef: "task-dev", status: "running", execId: "exec-main-1" })
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(((await res.json()) as { actor: string }).actor).toBe("task-doer(session=sess-doer-3)")
  })

  it("doer 指针悬空（会话行已不存在）→ unattributed（宁缺不伪）", async () => {
    const id = await seedTask("running")
    db.prepare(`UPDATE tasks SET doer_session_id = 'sess-gone' WHERE id = ?`).run(id)
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(((await res.json()) as { actor: string }).actor).toBe("unattributed")
  })

  it("终态执行行（completed）不在飞 → 不判 task-fix，走会话/缺账轨道", async () => {
    const id = await seedTask("awaiting_review")
    seedExec(id, { workflowRef: "built-in/task-fix", status: "completed", execId: "exec-fix-old" })
    const res = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "c\n", reason: "r", source: "s" })
    expect(((await res.json()) as { actor: string }).actor).toBe("unattributed")
  })
})

describe("票02 AC7 — 写成功后既有产物 manifest 即列出（零 manifest 改动）", () => {
  it("回写落盘后 GET /:id/artifacts/manifest 的 spec 组含该文件（home 直扫立现）", async () => {
    const id = await seedTask("running")
    const w = await postPlan(id, { batch: BATCH1, file: "spec.md", content: "要进产物页签\n", reason: "r", source: "s" })
    expect(w.status).toBe(200)
    const m = await app.request(`/api/tasks/${id}/artifacts/manifest`)
    expect(m.status).toBe(200)
    const groups = ((await m.json()) as {
      groups: Array<{ key: string; items: Array<{ path: string; bytes: number }> }>
    }).groups
    const specGroup = groups.find((g) => g.key === "spec")
    expect(specGroup?.items.some((i) => i.path === `home:${BATCH1}/spec.md`)).toBe(true)
  })
})
