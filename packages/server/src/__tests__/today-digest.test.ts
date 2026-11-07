// 「今日」页聚合：GET /api/dashboard/today
//
// 这一页的口径全部可从表/文件算出来（无 LLM 小结），测试钉住四件事：
// 1) 消耗走账本三桶拆分；2) 统计按当天窗口；3) 时间线是精选且有序；
// 4) 分身资产变更（版本/技能/记忆/文件）会被记进变动流，派出/合并不记。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { TodayDAO } from "../db/dao/today-dao"
import { createTodayRoutes } from "../routes/today"
import { appendCloneChange } from "../services/agent/clone-changes"

let db: Database.Database
let tokenDao: TokenUsageDAO
let todayDao: TodayDAO
let tmpRoot: string
let cloneRoots: { user: string; builtIn: string }

// 本地时区无关的「今天」：2026-11-07 09:41 本地时间
const NOW = new Date(2026, 10, 7, 9, 41, 0)
const at = (h: number, m: number) => new Date(2026, 10, 7, h, m, 0).toISOString()
const atMs = (h: number, m: number) => new Date(2026, 10, 7, h, m, 0).getTime()
const YESTERDAY = new Date(2026, 10, 6, 12, 0, 0).toISOString()

function insertTask(row: {
  id: string
  name: string
  status: string
  created_at: string
  updated_at?: string
  completed_at?: string | null
  source_chat_session_id?: string | null
}) {
  db.prepare(`
    INSERT INTO tasks (id, name, status, source_chat_session_id, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.name, row.status, row.source_chat_session_id ?? null,
    row.created_at, row.updated_at ?? row.created_at, row.completed_at ?? null,
  )
}

function insertCall(id: string, source: string, input: number, output: number, ms: number, sessionId?: string, model?: string) {
  db.prepare(`
    INSERT INTO llm_calls (
      id, turn_index, call_index, timestamp, duration_ms, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path, session_id
    ) VALUES (?, 1, 1, ?, 0, ?, ?, ?, 0, 0, ?, ?)
  `).run(id, ms, model ?? null, input, output, source, sessionId ?? null)
}

function app() {
  const a = new Hono()
  a.route("/api/dashboard", createTodayRoutes({
    todayDAO: todayDao,
    tokenUsageDAO: tokenDao,
    runningSessionCount: () => 2,
    now: () => NOW,
    cloneRoots,
    wikiRoot: path.join(tmpRoot, "no-wiki"),
  }))
  return a
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  todayDao = new TodayDAO(db)
})

afterAll(() => db.close())

beforeEach(() => {
  // 验收台账是 append-only（UPDATE/DELETE 触发器）；测试夹具临时摘掉删除闸再装回。
  db.exec(`
    DROP TRIGGER IF EXISTS prevent_task_phase_acceptance_update;
    DROP TRIGGER IF EXISTS prevent_task_phase_acceptance_delete;
  `)
  for (const table of [
    "llm_calls", "tasks", "task_phase_acceptances", "executions",
    "sessions", "agent_versions", "evolution_log", "billing_price_config",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  db.exec(`
    CREATE TRIGGER prevent_task_phase_acceptance_update
      BEFORE UPDATE ON task_phase_acceptances
      BEGIN SELECT RAISE(ABORT, 'task_phase_acceptances is append-only'); END;
    CREATE TRIGGER prevent_task_phase_acceptance_delete
      BEFORE DELETE ON task_phase_acceptances
      BEGIN SELECT RAISE(ABORT, 'task_phase_acceptances is append-only'); END;
  `)
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octo-today-"))
  cloneRoots = {
    user: path.join(tmpRoot, "clones"),
    builtIn: path.join(tmpRoot, "built-in"),
  }
  fs.mkdirSync(path.join(cloneRoots.user, "qing"), { recursive: true })
  fs.mkdirSync(path.join(cloneRoots.builtIn, "lan"), { recursive: true })

  // 工作区（executions.workspace_id 外键）
  db.prepare(`INSERT OR REPLACE INTO workspaces (id, name, path, created_at, updated_at)
              VALUES ('ws-1', 'ws', '/tmp/ws', ?, ?)`).run(NOW.toISOString(), NOW.toISOString())

  // 会话：今天开工的一段 + 昨天建、今天还在用的一段
  db.prepare(`INSERT INTO sessions (id, title, session_type, created_at, updated_at, last_message_at)
              VALUES ('s-1', 'core-pack', 'main', ?, ?, ?)`).run(at(7, 52), at(9, 0), at(9, 0))
  db.prepare(`INSERT INTO sessions (id, title, session_type, created_at, updated_at, last_message_at)
              VALUES ('s-2', '重构安装器', 'main', ?, ?, ?)`).run(YESTERDAY, at(9, 12), at(9, 12))

  // 任务：完成 / 待验收 / 失败
  insertTask({ id: "t-done", name: "FTS 增量重建", status: "done", created_at: at(7, 52), completed_at: at(8, 44), source_chat_session_id: "s-1" })
  insertTask({ id: "t-review", name: "看板双击详情", status: "awaiting_review", created_at: at(8, 0), updated_at: at(9, 5) })
  insertTask({ id: "t-fail", name: "v4 phase gate", status: "failed", created_at: YESTERDAY, updated_at: at(8, 20), completed_at: at(8, 20) })

  // 验收决策（append-only）
  db.prepare(`
    INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
    VALUES ('acc-1', 't-done', 0, 0, 'accepted', '索引完整', ?)
  `).run(at(9, 0))

  // 执行轮（P2/R1）
  db.prepare(`
    INSERT INTO executions (
      id, workspace_id, workflow_ref, workflow_name, status, phase_index, round_index,
      task_id, started_at, created_at, updated_at
    ) VALUES ('e-1', 'ws-1', 'wf-task', 'task-dev', 'running', 1, 0, 't-review', ?, ?, ?)
  `).run(at(9, 29), at(9, 29), at(9, 29))

  // 模型切换（同一会话相邻两次调用不同 model）
  insertCall("c-1", "clone_chat", 100, 10, atMs(9, 10), "s-2", "sonnet-5.5")
  insertCall("c-2", "clone_chat", 200, 20, atMs(9, 12), "s-2", "opus-5")
  // 任务侧调用
  insertCall("c-3", "workflow", 300, 30, atMs(9, 20), null, "opus-5")
  // 系统压缩
  insertCall("c-4", "session_compress", 50, 5, atMs(9, 30), null, "haiku-5.5")

  // 分身版本
  db.prepare(`
    INSERT INTO agent_versions (id, agent_name, version, major, minor, patch, stage, status, snapshot, changelog, published_at, published_by, created_at)
    VALUES ('v-1', 'lan', '1.4.0', 1, 4, 0, 'stable', 'published', '{}', '重试策略校验', ?, 'xiezhifeng', ?)
  `).run(at(8, 5), at(8, 5))

  // 技能演化
  db.prepare(`
    INSERT INTO evolution_log (skill_name, change_type, level, summary, diff_path, rolled_back, timestamp)
    VALUES ('octo-workflow-dev', 'improve', 'minor', '补验收纪律', NULL, 0, ?)
  `).run(at(9, 10))

  // 分身资产变更
  appendCloneChange(path.join(cloneRoots.user, "qing"), {
    ts: at(9, 6), kind: "file", path: "persona.md", delta_lines: 12,
  })
  appendCloneChange(path.join(cloneRoots.user, "qing"), {
    ts: at(9, 10), kind: "skill", path: "config.json", summary: "技能变更 + octo-workflow-dev",
  })
  appendCloneChange(path.join(cloneRoots.user, "qing"), {
    ts: at(9, 16), kind: "memory", path: "memory/long-term.md", delta_chars: 800,
  })
})

describe("GET /api/dashboard/today", () => {
  it("消耗按账本三桶拆分（对话 / 任务 / 系统）", async () => {
    const body = await (await app().request("/api/dashboard/today")).json() as any

    expect(body.consumption.calls).toBe(4)
    expect(body.consumption.input_tokens).toBe(650)
    expect(body.consumption.output_tokens).toBe(65)
    expect(body.consumption.tokens).toBe(715)
    // 无价表配置 → 价格三态：usd null 且 complete=false（不焊 0，也不谎称全额）
    expect(body.consumption.cost).toEqual({ usd: null, complete: false })

    const byBucket = Object.fromEntries(body.consumption.split.map((s: any) => [s.bucket, s.tokens]))
    expect(byBucket).toEqual({ chat: 330, task: 330, system: 55 })
    expect(body.consumption.split.reduce((sum: number, s: any) => sum + s.share, 0)).toBeCloseTo(1, 6)
  })

  it("统计只算当天窗口，并按当前状态分组", async () => {
    const body = await (await app().request("/api/dashboard/today")).json() as any

    expect(body.date).toBe("2026-11-07")
    expect(body.stats.tasks.changed).toBe(3)
    expect(body.stats.tasks.breakdown).toEqual([
      { key: "done", label: "完成", count: 1 },
      { key: "awaiting_review", label: "待验收", count: 1 },
      { key: "failed", label: "失败", count: 1 },
    ])
    expect(body.stats.chats).toEqual({ sessions: 2, converted: 1, running: 2 })
    expect(body.stats.knowledge.available).toBe(false)
  })

  it("分身统计只数资产变更（版本 / 技能 / 记忆 / 文件）", async () => {
    const body = await (await app().request("/api/dashboard/today")).json() as any

    expect(body.stats.clones).toEqual({
      total: 2,
      changed: 2,   // qing 有资产变更 + lan 发布了版本
      version: 1,
      skill: 1,
      memory: 1,
      file: 1,
    })
  })

  it("时间线按类目精选、时间升序，最后是「现在」", async () => {
    const body = await (await app().request("/api/dashboard/today")).json() as any
    const nodes = body.timeline.nodes as Array<{ ts: string; kind: string; title: string }>

    expect(nodes.length).toBeLessThanOrEqual(9)
    expect(nodes.at(-1)?.kind).toBe("now")
    expect(nodes.at(-1)?.title).toBe("现在：1 件事等你")
    // 「你做出的决定」永远入选
    expect(nodes.some((n) => n.title.includes("验收通过"))).toBe(true)
    // 时间升序
    const ts = nodes.slice(0, -1).map((n) => n.ts)
    expect([...ts].sort()).toEqual(ts)
    // 配额：对话类最多 1 个
    expect(nodes.filter((n) => n.kind === "chat").length).toBeLessThanOrEqual(1)
  })

  it("变动流包含任务/分身/Agent，按时间倒序", async () => {
    const body = await (await app().request("/api/dashboard/today")).json() as any
    const items = body.changes.items as Array<{ ts: string; cat: string; title: string }>

    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(12)
    expect(items[0].ts).toBe(at(9, 29)) // 最新：执行轮起跑
    expect(new Set(items.map((i) => i.cat))).toEqual(new Set(["task", "agent", "clone"]))
    expect(items.some((i) => i.title.includes("版本发布"))).toBe(true)
    expect(items.some((i) => i.title.includes("记忆更新"))).toBe(true)
    expect(items.some((i) => i.title.includes("模型切换"))).toBe(true)
    const ts = items.map((i) => i.ts)
    expect([...ts].sort().reverse()).toEqual(ts)
  })

  it("当天删除的任务进变动流与时间线，创建失败的回滚残行不出现", async () => {
    // 真实删除：昨天建、今天用过、今天 09:25 删掉
    insertTask({ id: "t-del", name: "旧草稿", status: "draft", created_at: YESTERDAY, updated_at: at(9, 20) })
    db.prepare("UPDATE tasks SET deleted_at = ? WHERE id = 't-del'").run(at(9, 25))
    // 回滚残行：同一秒内建完又删（createTask catch 的 softDelete）
    insertTask({ id: "t-phantom", name: "半创建残行", status: "draft", created_at: at(9, 30) })
    db.prepare("UPDATE tasks SET deleted_at = ? WHERE id = 't-phantom'")
      .run(new Date(2026, 10, 7, 9, 30, 0, 200).toISOString())

    const body = await (await app().request("/api/dashboard/today")).json() as any

    expect(body.stats.tasks.deleted).toBe(1)
    expect(body.stats.tasks.changed).toBe(4)
    expect(body.stats.tasks.breakdown).toContainEqual({ key: "deleted", label: "已删除", count: 1 })

    const changes = body.changes.items as Array<{ title: string }>
    expect(changes.some((i) => i.title === "「旧草稿」已删除")).toBe(true)
    expect(changes.some((i) => i.title.includes("半创建残行"))).toBe(false)

    const nodes = body.timeline.nodes as Array<{ title: string }>
    expect(nodes.some((n) => n.title === "「旧草稿」已删除")).toBe(true)
    expect(nodes.some((n) => n.title.includes("半创建残行"))).toBe(false)
  })

  it("有价表时成本/缓存省下都按视图现算（USD 基准）", async () => {
    // 只留一条缓存读调用：100 万 cacheRead、无 input/output
    db.prepare("DELETE FROM llm_calls").run()
    db.prepare(`
      INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price,
        cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
      VALUES ('p-1', 'seed', 'opus-5', 3, 15, 3.75, 0.3, 'USD', NULL, NULL, 't', 't')
    `).run()
    db.prepare(`
      INSERT INTO llm_calls (
        id, turn_index, call_index, timestamp, duration_ms, model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path
      ) VALUES ('c-price', 1, 1, ?, 0, 'opus-5', 0, 0, 1000000, 0, 'clone_chat')
    `).run(atMs(9, 10))

    const body = await (await app().request("/api/dashboard/today")).json() as any
    expect(body.consumption.cost.complete).toBe(true)
    expect(body.consumption.cost.usd).toBeCloseTo(0.3, 10)
    // 省下 = cacheRead × (输入价 - 缓存读价) = 1M × (3 - 0.3) / 1M
    expect(body.consumption.cache_saved.complete).toBe(true)
    expect(body.consumption.cache_saved.usd).toBeCloseTo(2.7, 10)
    expect(body.consumption.cache_hit_rate).toBe(1)
  })
})