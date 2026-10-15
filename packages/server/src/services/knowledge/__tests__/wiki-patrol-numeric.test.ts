// packages/server/src/services/knowledge/__tests__/wiki-patrol-numeric.test.ts
//
// P4 票08 — 巡检「数值查」S1 逐查断言（spec 故事 9/11/12/13，票面清单第 1 行的同步半）。
//
// 判据逐字真相源（不从实现反推）：
//  D1 膨胀榜（故事 9）：逼近 L1 容量闸 80% 的页 ⇒ bloat finding 预拆分提案。
//     L1 闸三阈值 = lint.ts WIKI_LIMITS 同族（≤120 行/25 规则/~2000 token，SCHEMA.md「容量闸」）。
//  D3 僵尸（故事 11）：90 天零引用（吃票06 账，cited_count/last_cited 现形）⇒ zombie 退役 finding。
//     时钟注入判据（红线6）：dormant=有账但最近引用逾 90 天；never=无账且建页（last_compiled）逾 90 天。
//  D5 域失衡（故事 12）：单页锚点数占全库 >30% ⇒ domain-skew hub 化/拆分 finding（低水位库不判）。
//  D7 volatile 到期（故事 13）：review_after 已过 ⇒ volatile-expired 复审 finding（三选一在人裁侧）。
// 制式照票13/票03/票07 各查：确定性遍历零 LLM、内容寻址 id、幂等、三态不再扰。
// D2 duplicate（含 LLM seam）与 health score 分文件另钉。

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

/** v3 topic 页：硬约束节 anchors 条规则（票07 制式）。 */
function topicPage(rel: string, id: string, anchors: string[]): void {
  writePage(rel, id, "topic", anchors.length > 0 ? "## 硬约束\n\n" + anchors.map((a, i) => `- 纪律${i + 1} <!--#${a}-->`).join("\n") + "\n" : "## 说明\n\n无约束。\n")
}

/** 通用 v3 页字面量（front-matter 制式同票13 fixture；行数可预期=12 行 fm + 正文行）。 */
function writePage(rel: string, id: string, type: string, body: string, extraFM: string[] = []): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `title: ${id} 页`,
    `summary: ${id} 的摘要`,
    "topics: [ci]",
    "aliases: []",
    "links: []",
    ...extraFM,
    "last_compiled: 2026-10-12",
    "sources: []",
    "---",
    "",
    body,
  ].join("\n"), "utf-8")
}

/** 判例页（D1 豁免对照：判例天然长、L1 容量闸豁免同律）。 */
function longCasePage(rel: string, id: string, fillerLines: number): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const filler = Array.from({ length: fillerLines }, (_, i) => `第${i + 1}行现场记录，内容略。`).join("\n")
  fs.writeFileSync(abs, [
    "---",
    `id: ${id}`,
    "domain: cases",
    `symptom: 症状${id}`,
    "tags: [ci]",
    "severity: major",
    "source: raw/inbox/seed.md",
    "status: open",
    "occurrences: 1",
    "---",
    "",
    "## 现场",
    "",
    filler,
    "",
  ].join("\n"), "utf-8")
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-patrol-num-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
  ledger = new KnowledgeEffectivenessDAO(db)
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const NOW = new Date("2026-10-15T00:00:00.000Z")
const patrol = () => new WikiPatrolService({ db, root, now: () => NOW })

describe("D1 膨胀榜（票08·故事9：逼近 L1 容量闸 80% → 预拆分 finding）", () => {
  it("行数逼近 120 行闸 80%（96 行 ≥ 0.8）的 topic 页 ⇒ bloat finding，预拆分提案进标题", () => {
    // 构造独立手算：front-matter 块 12 行 + 空行 1 + 正文 84 行 = 文件 97 行；
    // 序列化闸口径（strip 尾空行）≈96 行 ⇒ 水位 ≥96/120=0.8（闸含等号：80% 即预警，不等触顶）。
    const filler = Array.from({ length: 84 }, (_, i) => `纪律行${i + 1}`).join("\n")
    writePage("topics/top-fat.md", "top-fat", "topic", `## 说明\n\n${filler}\n`)

    const res = patrol().patrol()
    const blo = res.findings.filter(f => f.kind === "bloat")
    expect(blo).toHaveLength(1)
    expect(blo[0].pages).toEqual(["topics/top-fat.md"])
    expect(res.counts["bloat"]).toBe(1)

    const row = new FindingsDAO(db).list("open").find(r => r.kind === "bloat")!
    expect(row.id).toMatch(/^fnd-[0-9a-f]{16}$/)
    expect(row.source).toBe("patrol")
    expect(row.title).toContain("膨胀")
    expect(row.title).toContain("拆分") // 预拆分提案（故事 9「不等触顶硬拒」）
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.page).toBe("topics/top-fat.md")
    expect(Number(detail.lines)).toBeGreaterThanOrEqual(95) // 构造事实（独立手算 ~96-97）
    expect(Number(detail.waterline)).toBeGreaterThanOrEqual(0.8)
  })

  it("水位低于 80% 的页不产（40 行页 ≈0.33 远低预警线）", () => {
    const filler = Array.from({ length: 28 }, (_, i) => `行${i + 1}`).join("\n")
    writePage("topics/top-thin.md", "top-thin", "topic", `## 说明\n\n${filler}\n`)
    expect(patrol().patrol().findings.filter(f => f.kind === "bloat")).toHaveLength(0)
  })

  it("判例页豁免（L1 容量闸 cases 豁免同律：判例天然长不报膨胀）；sources 回执页受检", () => {
    longCasePage("cases/case-long.md", "case-long", 100)
    const res = patrol().patrol()
    expect(res.findings.filter(f => f.kind === "bloat").some(f => f.pages.includes("cases/case-long.md"))).toBe(false)
  })

  it("幂等：重跑不增殖（unchanged）；ignored 后永不再扰（三态纪律对新 kind 生效）", () => {
    const filler = Array.from({ length: 84 }, (_, i) => `纪律行${i + 1}`).join("\n")
    writePage("topics/top-fat.md", "top-fat", "topic", `## 说明\n\n${filler}\n`)
    const first = patrol().patrol()
    expect(first.findings.filter(f => f.kind === "bloat" && f.action === "created")).toHaveLength(1)

    const res2 = patrol().patrol()
    expect(res2.findings.filter(f => f.kind === "bloat" && f.action === "unchanged")).toHaveLength(1)
    expect(new FindingsDAO(db).list("open").filter(r => r.kind === "bloat")).toHaveLength(1)

    const bloatId = new FindingsDAO(db).list("open").find(r => r.kind === "bloat")!.id
    new FindingsDAO(db).updateStatus(bloatId, "ignored")
    const res3 = patrol().patrol()
    expect(res3.findings.find(f => f.kind === "bloat")?.action).toBe("suppressed")
  })
})

describe("D3 僵尸（票08·故事11：90 天零引用吃票06 账 → 退役 finding）", () => {
  it("有账但最近引用逾 90 天（last_cited 2026-06-01，NOW=10-15 ⇒ 136 天）⇒ dormant zombie", () => {
    topicPage("topics/top-z.md", "top-z", ["oct-001"])
    ledger.upsert("oct-001", { cited_count: 5, last_cited: "2026-06-01T00:00:00.000Z" })

    const res = patrol().patrol()
    const zom = res.findings.filter(f => f.kind === "zombie")
    expect(zom).toHaveLength(1)
    expect(zom[0].pages).toEqual(["topics/top-z.md"])

    const row = new FindingsDAO(db).list("open").find(r => r.kind === "zombie")!
    expect(row.title).toContain("僵尸")
    expect(row.title).toContain("退役") // 退役提案（故事 11）
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.basis).toBe("dormant")
    expect(detail.last_cited).toBe("2026-06-01T00:00:00.000Z")
    expect(detail.cited).toBe(5)
    expect(detail.dormant_days).toBe(136) // 手算：06-01→10-15 = 30(6月)+31(7月)+31(8月)+30(9月)+14
  })

  it("从未被引用（无账行）且建页逾 90 天（last_compiled 2026-07-01 ⇒ 106 天）⇒ never zombie", () => {
    const abs = path.join(wikiRoot, "concepts", "con-old.md")
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, [
      "---",
      "id: con-old",
      "type: concept",
      "title: con-old 页",
      "summary: 旧概念",
      "topics: [ci]",
      "aliases: []",
      "links: []",
      "last_compiled: 2026-07-01",
      "sources: []",
      "---",
      "",
      "## 定义\n\n没人查过。",
    ].join("\n"), "utf-8")

    const res = patrol().patrol()
    const zom = res.findings.filter(f => f.kind === "zombie")
    expect(zom).toHaveLength(1)
    const detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "zombie")!.detail) as Record<string, unknown>
    expect(detail.basis).toBe("never")
    expect(detail.dormant_days).toBe(106) // 手算：07-01→10-15 = 31(7月)+31(8月)+30(9月)+14
    expect(detail.last_cited).toBeNull()
  })

  it("90 天内有引用 ⇒ 不扰；新页（last_compiled 4 天前）无账 ⇒ 不扰（增长有提前量）", () => {
    topicPage("topics/top-hot.md", "top-hot", ["oct-002"])
    ledger.upsert("oct-002", { cited_count: 2, last_cited: "2026-10-01T00:00:00.000Z" }) // 14 天前
    writePage("concepts/con-new.md", "con-new", "concept", "## 定义\n\n新页。") // last_compiled 2026-10-12
    const res = patrol().patrol()
    expect(res.findings.filter(f => f.kind === "zombie")).toHaveLength(0)
  })

  it("判例与 sources 回执页不在僵尸面（判例走自身生命周期；回执页非规则载体·票06 同律）", () => {
    longCasePage("cases/case-old.md", "case-old", 5)
    writePage("sources/src-receipt.md", "src-receipt", "source", "## 回执\n\n原文指针。")
    const res = patrol().patrol()
    expect(res.findings.filter(f => f.kind === "zombie")).toHaveLength(0)
  })
})

describe("D5 域失衡（票08·故事12：单页锚点占全库 >30% → hub 化/拆分 finding）", () => {
  it("胖页 10 锚 / 全库 13 锚（0.769>0.3）⇒ domain-skew，份额进 detail", () => {
    topicPage("topics/top-fat.md", "top-fat", ["oct-001", "oct-002", "oct-003", "oct-004", "oct-005", "oct-006", "oct-007", "oct-008", "oct-009", "oct-010"])
    topicPage("topics/top-a.md", "top-a", ["oct-011", "oct-012"])
    topicPage("topics/top-b.md", "top-b", ["oct-013"])

    const res = patrol().patrol()
    const skew = res.findings.filter(f => f.kind === "domain-skew")
    expect(skew).toHaveLength(1)
    expect(skew[0].pages).toEqual(["topics/top-fat.md"])

    const detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "domain-skew")!.detail) as Record<string, unknown>
    expect(detail.anchors).toBe(10)
    expect(detail.total_anchors).toBe(13)
    expect(detail.share).toBeCloseTo(0.769, 3) // 手算 10/13
    const row = new FindingsDAO(db).list("open").find(r => r.kind === "domain-skew")!
    expect(row.title).toContain("失衡")
    expect(row.title).toContain("hub") // hub 化/拆分提案（故事 12）
  })

  it("全库锚点数低于低水位门槛（<10）不判——小库份额无统计意义", () => {
    topicPage("topics/top-fat.md", "top-fat", ["oct-001", "oct-002", "oct-003", "oct-004", "oct-005"])
    topicPage("topics/top-a.md", "top-a", ["oct-006"])
    const res = patrol().patrol()
    expect(res.findings.filter(f => f.kind === "domain-skew")).toHaveLength(0)
  })

  it("均衡库（最大份额 <30%）不扰", () => {
    topicPage("topics/top-a.md", "top-a", ["oct-001", "oct-002", "oct-003"])
    topicPage("topics/top-b.md", "top-b", ["oct-004", "oct-005", "oct-006"])
    topicPage("topics/top-c.md", "top-c", ["oct-007", "oct-008", "oct-009"])
    topicPage("topics/top-d.md", "top-d", ["oct-010", "oct-011"])
    expect(patrol().patrol().findings.filter(f => f.kind === "domain-skew")).toHaveLength(0)
  })
})

describe("D7 volatile 到期（票08·故事13：review_after 已过 → 复审 finding，纯新建判据）", () => {
  it("volatile 页 review_after=2026-09-30（NOW=2026-10-15 已过 15 天）⇒ volatile-expired，三选措辞进标题", () => {
    topicPage("topics/top-v.md", "top-v", ["oct-001"])
    const abs = path.join(wikiRoot, "topics", "top-v.md")
    const raw = fs.readFileSync(abs, "utf-8")
    fs.writeFileSync(abs, raw.replace("links: []", "links: []\nstability: volatile\nreview_after: 2026-09-30"), "utf-8")

    const res = patrol().patrol()
    const exp = res.findings.filter(f => f.kind === "volatile-expired")
    expect(exp).toHaveLength(1)
    expect(exp[0].pages).toEqual(["topics/top-v.md"])

    const row = new FindingsDAO(db).list("open").find(r => r.kind === "volatile-expired")!
    expect(row.title).toContain("到期")
    expect(row.title).toContain("续期") // 续期/改写/退役三选一（故事 13，人裁侧）
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.review_after).toBe("2026-09-30")
    expect(detail.overdue_days).toBe(15) // 手算 09-30→10-15
  })

  it("review_after 未到 ⇒ 不扰；stable 页无到期概念", () => {
    topicPage("topics/top-v2.md", "top-v2", ["oct-001"])
    const abs = path.join(wikiRoot, "topics", "top-v2.md")
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("links: []", "links: []\nstability: volatile\nreview_after: 2026-11-01"), "utf-8")
    topicPage("topics/top-s.md", "top-s", ["oct-002"])
    const res = patrol().patrol()
    expect(res.findings.filter(f => f.kind === "volatile-expired")).toHaveLength(0)
  })

  it("时钟注入判据（红线6）：同一库 NOW 前移一天 ⇒ 到期消失，不 sleep", () => {
    topicPage("topics/top-v.md", "top-v", ["oct-001"])
    const abs = path.join(wikiRoot, "topics", "top-v.md")
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("links: []", "links: []\nstability: volatile\nreview_after: 2026-10-14"), "utf-8")
    expect(new WikiPatrolService({ db, root, now: () => new Date("2026-10-15T00:00:00.000Z") }).patrol().findings.filter(f => f.kind === "volatile-expired")).toHaveLength(1)
    new FindingsDAO(db).updateStatus(new FindingsDAO(db).list("open").find(r => r.kind === "volatile-expired")!.id, "ignored")
    // 换时钟到到期日之前 ⇒ 判据不再命中（构造而非等待——红线6）
    const res = new WikiPatrolService({ db, root, now: () => new Date("2026-10-13T00:00:00.000Z") }).patrol()
    expect(res.findings.filter(f => f.kind === "volatile-expired")).toHaveLength(0)
  })
})
