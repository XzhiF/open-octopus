import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { AgentSessionDAO } from "../../../db/dao/agent-session-dao"
import { WikiPatrolService } from "../patrol"
import { knowledgePatrolHandlerFor, createKnowledgeSessionReporter, appendKnowledgeSessionCards, appendCardsToSession } from "../patrol-job"
import { parseKcCardPayload, type KcCardEvent, type KcFindingCardData } from "@octopus/shared"
import type { CodeJobContext } from "../../scheduler/code-job-registry"

/**
 * 票13 · 夜巡作业（scheduler 系统作业先例的领域侧 handler + Lane A 报对话）。
 * S1 服务层直驱：不起 HTTP server、不起调度泵——handler 就是被执行体，
 * ctx 用最小假象形（CodeJobContext 契约字段）注入。
 */

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

function writePage(rel: string, id: string, type: string, topics: string[], links: string[], body: string): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]\n` : "links: []\n"
  fs.writeFileSync(abs, [
    "---", `id: ${id}`, `type: ${type}`, `title: ${id} 页`, `summary: ${id} 摘要`,
    `topics: [${topics.join(", ")}]`, "aliases: []", linksBlock + "",
    "last_compiled: 2026-10-12", "sources: []", "---", "", body,
  ].join("\n"), "utf-8")
}

const ctx = (): CodeJobContext => ({
  scheduleId: "builtin-knowledge-patrol", jobName: "系统 · 知识夜巡", org: "",
  fireId: "fire-1", args: {}, signal: new AbortController().signal, startedAtMs: Date.now(),
})

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-patrol-job-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function seedKnowledgeSession(): string {
  const dao = new AgentSessionDAO(db)
  dao.insertSession({
    id: "kc-s1", org: "default", title: "知识中心", clone_name: "archive",
    session_type: "chat", created_at: "2026-10-12T08:00:00Z", updated_at: "2026-10-12T08:00:00Z",
    scope_id: "knowledge",
  })
  return "kc-s1"
}

describe("夜巡 handler（服务层直驱）", () => {
  it("跑五查落 findings；outcome 带 summary/metrics；新建 finding 以 Lane A fenced 块报进知识中心会话", async () => {
    // 两页互链（消孤儿/缺互链噪声），其中一页引用缺页 ⇒ 恰 1 条 missing-page 新建
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], ["con-b"],
      "## 定义\n\n引用 [[con-ghost]]，见 [[con-b]]。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], ["con-a"],
      "## 定义\n\n见 [[con-a]]。")
    const sessionId = seedKnowledgeSession()
    const patrol = new WikiPatrolService({ db, root })
    const handler = knowledgePatrolHandlerFor(patrol, { report: createKnowledgeSessionReporter(db) })

    const outcome = await handler(ctx())
    expect(outcome?.summary).toContain("夜巡")
    expect(outcome?.metrics).toMatchObject({ newFindings: 1 })

    // findings 表真值
    const dao = new FindingsDAO(db)
    expect(dao.countOpen()).toBe(1)

    // Lane A：会话新增一条 assistant 消息，正文含可解析的 finding 卡 fenced 块
    const msgs = new AgentSessionDAO(db).findAllMessages(sessionId)
    const posted = msgs.filter(m => m.role === "assistant")
    expect(posted).toHaveLength(1)
    const blockMatch = /```kc-card\n([\s\S]*?)\n```/.exec(posted[0].content)
    expect(blockMatch, `消息正文应含 kc-card 块：${posted[0].content}`).not.toBeNull()
    const ev = parseKcCardPayload(JSON.parse(blockMatch![1]!))
    expect(ev?.kind).toBe("finding")
    const data = ev?.data as KcFindingCardData
    expect(data.findingId).toBe(dao.list("open")[0].id)
    expect(data.status).toBe("open")
    expect(data.source).toBe("patrol")
    expect(posted[0].content).toContain("体检报告")
  })

  it("幂等第二巡零新发现 ⇒ 零消息打扰；无知识中心会话时新建仍入库、报告诚实注明未报对话", async () => {
    // 单页零入链 = 孤儿 1 条（真实判据），首巡报一次；二巡不重复报
    writePage("concepts/con-a.md", "con-a", "concept", [], [], "## 定义\n\n孤儿页。")
    seedKnowledgeSession()
    const patrol = new WikiPatrolService({ db, root })
    const handler = knowledgePatrolHandlerFor(patrol, { report: createKnowledgeSessionReporter(db) })

    const first = await handler(ctx())
    expect(first?.metrics).toMatchObject({ newFindings: 1 })
    const second = await handler(ctx())
    expect(second?.metrics).toMatchObject({ newFindings: 0 })
    const postedAfterTwo = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE role='assistant'").get() as { c: number }
    expect(postedAfterTwo.c).toBe(1) // 只有首轮新建时打扰一次

    // 会话不存在：新 finding 仍入库（发现面独立成立），summary 显式说明未报对话
    db.prepare("DELETE FROM messages").run()
    db.prepare("DELETE FROM sessions").run()
    writePage("topics/top-x.md", "top-x", "topic", [], ["top-ghost"], "## SOP\n\n[[top-ghost]]")
    const third = await handler(ctx())
    // top-x 零入链（孤儿）且引用 top-ghost 缺页 ⇒ 两条新建
    expect(third?.metrics).toMatchObject({ newFindings: 2 })
    expect(third?.summary).toMatch(/未报对话|无知识中心会话/)
    expect(new FindingsDAO(db).list("open").filter(r => r.kind === "missing-page")).toHaveLength(1)
    // 无会话 ⇒ 一条也没多投（此前清库消息数为 0，第三巡后仍 0）
    const postedAfterThree = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE role='assistant'").get() as { c: number }
    expect(postedAfterThree.c).toBe(0)
  })
})

// ── 票10：卡片回流目标会话（appendKnowledgeSessionCards 泛化——目标会话参数化）──

/** 独立真相源：手写已知卡事件（不从被测代码推导 expected）。 */
const CURATED_EV: KcCardEvent = {
  id: "ing-deadbeef",
  kind: "ingest",
  ts: "2026-10-15T08:00:00Z",
  data: { status: "done", rawPath: "raw/inbox/2026-10-15-x.md", bytes: 1024, hash: "deadbeefcafe0123" },
}

function seedPlainSession(id: string, patch: Record<string, unknown> = {}): void {
  new AgentSessionDAO(db).insertSession({
    id, org: "default", title: patch.title != null ? String(patch.title) : "普通会话",
    clone_name: patch.clone_name != null ? String(patch.clone_name) : null,
    session_type: patch.session_type != null ? String(patch.session_type) : "main",
    created_at: "2026-10-15T08:00:00Z", updated_at: "2026-10-15T08:00:00Z",
    ...patch,
  } as never)
}

describe("appendCardsToSession（票10 泛化原语：目标会话参数化）", () => {
  it("任意非知识中心会话（main 会话）落一条 assistant 消息：header + Lane A fenced 块可解析", () => {
    seedPlainSession("main-s1")
    const out = appendCardsToSession(db, "main-s1", "📥 投喂入库：", [CURATED_EV], () => new Date("2026-10-15T09:00:00Z"))
    expect(out.posted).toBe(true)
    expect(out.sessionId).toBe("main-s1")

    const msgs = new AgentSessionDAO(db).findAllMessages("main-s1")
    const posted = msgs.filter(m => m.role === "assistant")
    expect(posted).toHaveLength(1)
    expect(posted[0].content).toContain("📥 投喂入库：")
    const blockMatch = /```kc-card\n([\s\S]*?)\n```/.exec(posted[0].content)
    expect(blockMatch, `消息正文应含 kc-card 块：${posted[0].content}`).not.toBeNull()
    const ev = parseKcCardPayload(JSON.parse(blockMatch![1]!))
    expect(ev).toEqual(CURATED_EV)
    // last_message_at 同步推进（会话列表排序面与 patrol 写者同律）
    const s = new AgentSessionDAO(db).findById("main-s1")
    expect(s?.last_message_at).toBe("2026-10-15T09:00:00.000Z")
  })

  it("会话不存在 ⇒ 诚实降级 posted:false + reason，零消息写入", () => {
    const out = appendCardsToSession(db, "ghost-sess", "header", [CURATED_EV])
    expect(out.posted).toBe(false)
    expect(out.reason).toContain("ghost-sess")
    const c = db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }
    expect(c.c).toBe(0)
  })

  it("会话已删除（is_deleted=1）⇒ 拒写诚实降级（软删面不复活）", () => {
    seedPlainSession("del-s1")
    db.prepare("UPDATE sessions SET is_deleted = 1 WHERE id = 'del-s1'").run()
    const out = appendCardsToSession(db, "del-s1", "header", [CURATED_EV])
    expect(out.posted).toBe(false)
    const c = db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }
    expect(c.c).toBe(0)
  })

  it("appendKnowledgeSessionCards 判据零回归：知识中心会话与任意普通会话并存 ⇒ 只写知识中心", () => {
    seedKnowledgeSession() // kc-s1：archive 分身 · title=知识中心 · scope=knowledge
    seedPlainSession("main-s2", { title: "投喂讨论" })
    seedPlainSession("main-s3", { clone_name: "archive", title: "工程分析会话" }) // 同分身非 KC

    const out = appendKnowledgeSessionCards(db, "✅ 回执：", [CURATED_EV])
    expect(out.posted).toBe(true)
    expect(out.sessionId).toBe("kc-s1")

    const countFor = (sid: string) =>
      (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sid) as { c: number }).c
    expect(countFor("kc-s1")).toBe(1)
    expect(countFor("main-s2")).toBe(0)
    expect(countFor("main-s3")).toBe(0)
  })

  it("appendKnowledgeSessionCards 无知识中心会话 ⇒ 降级 reason 措辞零变（既有合同）", () => {
    seedPlainSession("main-s4")
    const out = appendKnowledgeSessionCards(db, "header", [CURATED_EV])
    expect(out.posted).toBe(false)
    expect(out.reason).toBe("无知识中心会话（findings 已入库可查，未报对话）")
  })
})
