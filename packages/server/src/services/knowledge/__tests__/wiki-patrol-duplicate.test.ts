// packages/server/src/services/knowledge/__tests__/wiki-patrol-duplicate.test.ts
//
// P4 票08 — D2 重复对查（S1，spec 故事 10「碎片不堆积」，票面清单第 1 行 D2 项）。
//
// 判据（票面逐字）：跨页近义规则 jaccard 批量判 ⇒ duplicate finding **附策展人合并稿**。
// 三件套单源复用 case-symptom（normalizeSymptom/symptomTokens/jaccard——E2 §9 实锤
// spec 虚指的 normalizeRuleText/ruleTokens 全仓不存在，P3 同款坑钉在案）；
// 阈值另立单源常量（勿动 0.5 症状口径）。合并稿=LLM seam 装饰面：seam 缺席/抛/空
// 一律诚实空稿，**finding 本体照常产出**（archive-ingest SUMMARIZE_FAILED 先例同律，
// 红线2 判据面零 LLM——pair 命中是确定性 jaccard，非 LLM 判定；embedding 严禁引入）。
// 幂等进阶：同证据重跑**不重烧 LLM**（已有非空稿复用——夜巡成本纪律）。
//
// 手算真相源（禁 tautology）：fixture 规则 A=「提交代码前必须跑 pnpm test 再推送」、
// B=「提交代码前必须跑 pnpm test 后推送」——
// A tokens = {pnpm,test} ∪ CJK二元{提交,交代,代码,码前,前必,必须,须跑} ∪ {再推,推送,送?}
//   段「提交代码前必须跑」8 字→7 二元；「再推送」3 字→2 二元（再推/推送）⇒ |A|=2+7+2=11
// B 同构 ⇒ |B|=11；交集 = {pnpm,test} ∪ 7 二元 ∪ {推送} = 10 ⇒ jaccard = 10/12 = 0.8333

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { WikiPatrolService, RULE_DUPLICATE_JACCARD_THRESHOLD } from "../patrol"

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

/** topic 页：规则行 = `- {text} <!--#{anchor}-->`。 */
function rulesPage(rel: string, id: string, rules: Array<{ anchor: string; text: string }>): void {
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
    "---",
    "",
    "## 硬约束",
    "",
    ...rules.map(r => `- ${r.text} <!--#${r.anchor}-->`),
    "",
  ].join("\n"), "utf-8")
}

const A_TEXT = "提交代码前必须跑 pnpm test 再推送"
const B_TEXT = "提交代码前必须跑 pnpm test 后推送"
const C_TEXT = "归档工作区前先跑对账脚本确认索引与真盘一致"

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-patrol-dup-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

interface Captured { prompts: string[] }
function mkPatrol(llm?: (prompt: string) => Promise<string>) {
  return new WikiPatrolService({ db, root, ...(llm ? { llm } : {}) })
}

describe("D2 重复对（票08·故事10：跨页近义规则 jaccard 批量判 → 合并稿 finding）", () => {
  it("跨页近义对（手算 10/12≈0.833 ≥ 阈值）⇒ duplicate finding，a/b 四要素+score 进 detail；pair 规范化排序", async () => {
    rulesPage("topics/top-a.md", "top-a", [{ anchor: "oct-001", text: A_TEXT }])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B_TEXT }])

    const res = await mkPatrol().patrol()
    const dup = res.findings.filter(f => f.kind === "duplicate")
    expect(dup).toHaveLength(1)
    expect(dup[0].pages).toEqual(["topics/top-a.md", "topics/top-b.md"]) // 页路径字典序
    expect(res.counts["duplicate"]).toBe(1)

    const row = new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!
    expect(row.id).toMatch(/^fnd-[0-9a-f]{16}$/)
    expect(row.source).toBe("patrol")
    expect(row.title).toContain("重复")
    expect(row.title).toContain("合并")
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.a_page).toBe("topics/top-a.md")
    expect(detail.a_anchor).toBe("oct-001")
    expect(detail.b_page).toBe("topics/top-b.md")
    expect(detail.b_anchor).toBe("oct-002")
    expect(detail.a_text).toBe(A_TEXT)
    expect(detail.b_text).toBe(B_TEXT)
    expect(Number(detail.score)).toBeCloseTo(10 / 12, 4) // 独立手算值
    expect(RULE_DUPLICATE_JACCARD_THRESHOLD).toBeLessThan(10 / 12) // 构造在阈上
  })

  it("无 seam（llm 缺席）⇒ 合并稿诚实空串，finding 照常产出（附稿可空不毁产出）", async () => {
    rulesPage("topics/top-a.md", "top-a", [{ anchor: "oct-001", text: A_TEXT }])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B_TEXT }])
    await mkPatrol().patrol()
    const detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!.detail) as Record<string, unknown>
    expect(detail.merge_draft).toBe("")
  })

  it("seam 在场⇒ 合并稿进 detail；prompt 捕获=两锚点+两规则原文（契约面）；seam 每对只烧一次（重跑不重烧）", async () => {
    rulesPage("topics/top-a.md", "top-a", [{ anchor: "oct-001", text: A_TEXT }])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B_TEXT }])
    const cap: Captured = { prompts: [] }
    const llm = async (prompt: string) => { cap.prompts.push(prompt); return "合并稿：提交代码前必须跑 pnpm test 通过后再推送" }

    const res = await mkPatrol(llm).patrol()
    expect(res.findings.filter(f => f.kind === "duplicate" && f.action === "created")).toHaveLength(1)
    expect(cap.prompts).toHaveLength(1)
    expect(cap.prompts[0]).toContain("oct-001")
    expect(cap.prompts[0]).toContain("oct-002")
    expect(cap.prompts[0]).toContain(A_TEXT)
    expect(cap.prompts[0]).toContain(B_TEXT)

    let detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!.detail) as Record<string, unknown>
    expect(detail.merge_draft).toBe("合并稿：提交代码前必须跑 pnpm test 通过后再推送")

    // 幂等重跑：同证据 ⇒ unchanged、零写、**不重烧 LLM**（稿复用）
    const res2 = await mkPatrol(llm).patrol()
    expect(res2.findings.filter(f => f.kind === "duplicate" && f.action === "unchanged")).toHaveLength(1)
    expect(cap.prompts).toHaveLength(1) // 第二次 patrol 调用数不变
    detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!.detail) as Record<string, unknown>
    expect(detail.merge_draft).toBe("合并稿：提交代码前必须跑 pnpm test 通过后再推送")
  })

  it("seam 抛错/空响应 ⇒ 空稿诚实缺席，finding 仍产出且不毁巡检（archive-ingest SUMMARIZE_FAILED 先例同律）", async () => {
    rulesPage("topics/top-a.md", "top-a", [{ anchor: "oct-001", text: A_TEXT }])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B_TEXT }])
    const boom = async () => { throw new Error("provider down") }
    const res = await mkPatrol(boom).patrol()
    expect(res.findings.filter(f => f.kind === "duplicate")).toHaveLength(1)
    const detail = JSON.parse(new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!.detail) as Record<string, unknown>
    expect(detail.merge_draft).toBe("")

    // 空响应=「无响应」失败形态（离线闸恒空串同形）
    const res2 = await mkPatrol(async () => "   ").patrol()
    expect(res2.findings.filter(f => f.kind === "duplicate" && f.action !== "suppressed")).toHaveLength(1)
    // NOT_MERGE（模型判不可并的契约形态）⇒ 同样归一为空稿
    const res3 = await mkPatrol(async () => "NOT_MERGE").patrol()
    expect(res3.findings.filter(f => f.kind === "duplicate" && f.action !== "suppressed")).toHaveLength(1)
  })

  it("不近义对（手算低分）不产；同页近义不在重复面（合并是跨页面，页内重排属编辑）", async () => {
    rulesPage("topics/top-a.md", "top-a", [
      { anchor: "oct-001", text: A_TEXT },
      { anchor: "oct-002", text: C_TEXT }, // 不近义
    ])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-003", text: "推送前必须跑 pnpm lint 清掉告警" }])
    const res = await mkPatrol().patrol()
    expect(res.findings.filter(f => f.kind === "duplicate")).toHaveLength(0)
  })

  it("同页内的两条近义规则 ⇒ 不成对（跨页判据）", async () => {
    rulesPage("topics/top-a.md", "top-a", [
      { anchor: "oct-001", text: A_TEXT },
      { anchor: "oct-002", text: B_TEXT },
    ])
    const res = await mkPatrol().patrol()
    expect(res.findings.filter(f => f.kind === "duplicate")).toHaveLength(0)
  })

  it("ignored 后永不再扰；证据变化（规则文本改写）⇒ refreshed 且旧稿不作废复用（文本对不上⇒重新判稿）", async () => {
    rulesPage("topics/top-a.md", "top-a", [{ anchor: "oct-001", text: A_TEXT }])
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B_TEXT }])
    const ok = async () => "旧合并稿"
    await mkPatrol(ok).patrol()
    const first = new FindingsDAO(db).list("open").find(r => r.kind === "duplicate")!
    expect(JSON.parse(first.detail).merge_draft).toBe("旧合并稿")

    // 改写 b 页规则文本（仍与 a 近义但字面不同）⇒ a_text/b_text 变 ⇒ 旧稿不复用，重烧
    // 手算：与 A 差一语气尾巴 ⇒ 交集 11（{pnpm,test}+7 二元+再推/推送）∪ = 12 ⇒ 11/12=0.917 ≥ 阈值
    const B2 = "提交代码前必须跑 pnpm test 再推送了"
    rulesPage("topics/top-b.md", "top-b", [{ anchor: "oct-002", text: B2 }])
    const cap2: Captured = { prompts: [] }
    const res2 = await mkPatrol(async p => { cap2.prompts.push(p); return "新合并稿" }).patrol()
    expect(res2.findings.filter(f => f.kind === "duplicate" && f.action === "refreshed")).toHaveLength(1)
    expect(cap2.prompts).toHaveLength(1) // 文本变了 ⇒ 重烧一次
    const row = new FindingsDAO(db).getById(first.id)!
    expect(JSON.parse(row.detail).merge_draft).toBe("新合并稿")

    // ignored 后不再扰
    new FindingsDAO(db).updateStatus(first.id, "ignored")
    const res3 = await mkPatrol(async () => { throw new Error("不该被调") }).patrol()
    expect(res3.findings.find(f => f.kind === "duplicate")?.action).toBe("suppressed")
  })
})
