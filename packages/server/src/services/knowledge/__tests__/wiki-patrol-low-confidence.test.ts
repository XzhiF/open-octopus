// packages/server/src/services/knowledge/__tests__/wiki-patrol-low-confidence.test.ts
//
// P4 票07 — 巡检「低置信」查（S1，spec 故事 5，票面清单第 5 行）。
//
// 判据（票面逐字）：confidence ≤0.2 且引用 ≥3 ⇒ low-confidence finding，
// 提议修订或退役（裁决面=既有 finding 卡三态，红线2 零自动执行）。confidence 取
// 票07 单源闸值：measured 走滚动公式，未测走编译期初值（故事 5 的字面判据不另设
// 样本闸——初值就 ≤0.2 且已被引用 3 次的规则，同样「差规则不赖账」）。
// 制式照票13/票03 各查：确定性遍历零 LLM、内容寻址 id、幂等、三态不再扰。
// fixture=手写 v3 页字面量 + DAO 直入账目行（expected 真相源=票面公式手算，禁反推）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { WikiPatrolService } from "../patrol"

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string
let ledger: KnowledgeEffectivenessDAO

function topicPage(rel: string, id: string, anchors: string[], confidence?: number): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, [
    "---",
    `id: ${id}`,
    "type: topic",
    `title: ${id} 主题页`,
    `summary: ${id} 的纪律`,
    "topics: [ci]",
    "aliases: []",
    "links: []",
    "last_compiled: 2026-10-12",
    "sources: []",
    ...(confidence !== undefined ? [`confidence: ${confidence}`] : []),
    "---",
    "",
    "## 硬约束",
    "",
    ...anchors.map((a, i) => `- 纪律${i + 1} <!--#${a}-->`),
    "",
  ].join("\n"), "utf-8")
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-patrol-low-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
  ledger = new KnowledgeEffectivenessDAO(db)
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const patrol = () => new WikiPatrolService({ db, root })

describe("巡检「低置信」查（票07·故事5）", () => {
  it("measured 0.2（h1/n4）且聚合引用 5≥3 ⇒ finding；页键行+锚点行并算；重跑幂等 unchanged", async () => {
    topicPage("topics/top-ci.md", "top-ci", ["oct-001", "oct-002"])
    ledger.upsert("oct-001", { cited_count: 4, helpful_count: 1, not_helpful_count: 4 })
    ledger.upsert("oct-002", { cited_count: 1, helpful_count: 0, not_helpful_count: 0 })
    ledger.upsert("top-ci", { cited_count: 0, helpful_count: 0, not_helpful_count: 0 })

    const res = (await patrol().patrol())
    const low = res.findings.filter(f => f.kind === "low-confidence")
    expect(low).toHaveLength(1)
    expect(low[0].pages).toEqual(["topics/top-ci.md"])
    expect(res.counts["low-confidence"]).toBe(1)

    const row = new FindingsDAO(db).list("open").find(r => r.kind === "low-confidence")!
    expect(row.id).toMatch(/^fnd-[0-9a-f]{16}$/)
    expect(row.source).toBe("patrol")
    expect(row.title).toContain("低置信")
    expect(row.title).toContain("修订") // 提议面进标题（或退役——两案都人在裁决侧）
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.confidence).toBe(0.2) // 手算 1/(1+4)
    expect(detail.cited).toBe(5) // 三行并算 4+1+0
    expect(detail.measured).toBe(true)

    // 幂等：证据未变 ⇒ unchanged 零写，行数不变
    const res2 = (await patrol().patrol())
    expect(res2.findings.filter(f => f.kind === "low-confidence" && f.action === "unchanged")).toHaveLength(1)
    expect(new FindingsDAO(db).list("open").filter(r => r.kind === "low-confidence")).toHaveLength(1)
  })

  it("引用不足（cited 2）不产——还没被充分验证的账不催", async () => {
    topicPage("topics/top-ci.md", "top-ci", ["oct-001"])
    ledger.upsert("oct-001", { cited_count: 2, helpful_count: 0, not_helpful_count: 5 })
    expect((await patrol().patrol()).findings.filter(f => f.kind === "low-confidence")).toHaveLength(0)
  })

  it("账目不差（h4/n1 ⇒ 0.8）不扰", async () => {
    topicPage("topics/top-ci.md", "top-ci", ["oct-001"])
    ledger.upsert("oct-001", { cited_count: 9, helpful_count: 4, not_helpful_count: 1 })
    expect((await patrol().patrol()).findings.filter(f => f.kind === "low-confidence")).toHaveLength(0)
  })

  it("未测但初值 ≤0.2 且引用≥3 ⇒ 仍产（票面字面判据：初值也是 confidence）", async () => {
    topicPage("topics/top-ci.md", "top-ci", [], 0.15)
    ledger.upsert("top-ci", { cited_count: 4, helpful_count: 1, not_helpful_count: 1 })
    const res = (await patrol().patrol())
    const low = res.findings.filter(f => f.kind === "low-confidence")
    expect(low).toHaveLength(1)
    const detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "low-confidence")!.detail) as Record<string, unknown>
    expect(detail.confidence).toBe(0.15) // 保持初值不抖动（samples 2<3）
    expect(detail.measured).toBe(false)
  })

  it("无账页（从未被消费）绝不进低置信面；缺 confidence 字段的页按 DB 兜底初值 0.5 判", async () => {
    topicPage("topics/top-ci.md", "top-ci", ["oct-001"])
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 0 }) // 只引用零裁决
    expect((await patrol().patrol()).findings.filter(f => f.kind === "low-confidence")).toHaveLength(0)
  })

  it("ignored 后永不再扰（既有三态纪律对新增 kind 生效）", async () => {
    topicPage("topics/top-ci.md", "top-ci", ["oct-001"])
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 5 })
    const first = (await patrol().patrol()).findings.find(f => f.kind === "low-confidence")!
    new FindingsDAO(db).updateStatus(first.id, "ignored")
    const res = (await patrol().patrol())
    expect(res.findings.find(f => f.kind === "low-confidence")?.action).toBe("suppressed")
  })
})
