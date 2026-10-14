// packages/server/src/services/knowledge/__tests__/wiki-patrol-case-backlog.test.ts
//
// P3 票03 — 巡检第六查「判例积压」（S1，spec 故事 13，票面清单第 5 行）。
//
// 判据（spec 逐字）：open 且 occurrences≥2 且未蒸馏（无 rule_ref）⇒ case-backlog finding，
// 提议蒸馏为 topics 硬约束（裁决面=finding adopt 通道，见 case-distill.test.ts）。
// 制式照票13 五查：确定性遍历零 LLM、内容寻址 id、裁决三态不再扰、幂等零写。
// fixture=手写 P0 判例 front-matter 字面量（expected 真相源=spec/票面，禁反推）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { WikiPatrolService } from "../patrol"

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

/** P0 判例文件字面量（cases/{YYYY-MM-DD}-{slug}.md；五段骨架）。 */
function caseFile(opts: {
  fileName: string
  id: string
  symptom: string
  occurrences: number
  status: string
  ruleRef?: string
}): void {
  const abs = path.join(wikiRoot, "cases", opts.fileName)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, [
    "---",
    `id: ${opts.id}`,
    "domain: cases",
    `symptom: ${opts.symptom}`,
    "tags: [ci, cookie]",
    "severity: blocker",
    `occurrences: ${opts.occurrences}`,
    ...(opts.ruleRef ? [`rule_ref: ${opts.ruleRef}`] : []),
    "source: exec:aa03-9f31",
    `status: ${opts.status}`,
    "---",
    "",
    "## 现场\n\n登录 500。\n\n## 诊断\n\ntoken 错。\n\n## 根因\n\n时钟。\n\n## 修复\n\n校准。\n\n## 教训\n\n先查时钟。\n",
  ].join("\n"), "utf-8")
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa03-patrol-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const makePatrol = () => new WikiPatrolService({ db, root })

describe("巡检⑥ 判例积压（open 且 occurrences≥2 未蒸馏 → 提议蒸馏；票03 六查）", () => {
  it("open + occurrences=2 + 无 rule_ref ⇒ case-backlog finding：内容寻址 id/涉事判例页/detail 计数在案；counts 记第六类", () => {
    caseFile({ fileName: "2026-10-12-case-backlog-a.md", id: "case-backlog-a", symptom: "登录 500 cookie 未清", occurrences: 2, status: "open" })

    const res = makePatrol().patrol()
    const backlog = res.findings.filter(f => f.kind === "case-backlog")
    expect(backlog).toHaveLength(1)
    expect(backlog[0].action).toBe("created")
    expect(backlog[0].pages).toEqual(["cases/2026-10-12-case-backlog-a.md"])
    expect(res.counts["case-backlog"]).toBe(1)

    const row = new FindingsDAO(db).getById(backlog[0].id)!
    expect(row.kind).toBe("case-backlog")
    expect(row.id).toMatch(/^fnd-[0-9a-f]{16}$/)
    expect(row.title).toContain("判例积压")
    expect(row.title).toContain("登录 500 cookie 未清")
    expect(row.source).toBe("patrol")
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail.case).toBe("cases/2026-10-12-case-backlog-a.md")
    expect(detail.caseId).toBe("case-backlog-a")
    expect(detail.occurrences).toBe(2)
  })

  it("三不查面：occurrences=1 不查；有 rule_ref 不查；status=distilled/superseded 不查", () => {
    caseFile({ fileName: "2026-10-12-case-once.md", id: "case-once", symptom: "症状一", occurrences: 1, status: "open" })
    caseFile({ fileName: "2026-10-12-case-refd.md", id: "case-refd", symptom: "症状二", occurrences: 3, status: "open", ruleRef: "oct-001" })
    caseFile({ fileName: "2026-10-12-case-dist.md", id: "case-dist", symptom: "症状三", occurrences: 5, status: "distilled" })
    caseFile({ fileName: "2026-10-12-case-sup.md", id: "case-sup", symptom: "症状四", occurrences: 4, status: "superseded" })

    const res = makePatrol().patrol()
    expect(res.findings.filter(f => f.kind === "case-backlog")).toHaveLength(0)
    expect(new FindingsDAO(db).list("open").filter(r => r.kind === "case-backlog")).toHaveLength(0)
  })

  it("幂等与裁决三态：重跑 unchanged 零写；occurrences 增长刷新证据；resolved 后永不再扰", () => {
    caseFile({ fileName: "2026-10-12-case-grow.md", id: "case-grow", symptom: "增长症状", occurrences: 2, status: "open" })
    const first = makePatrol().patrol()
    const created = first.findings.find(f => f.kind === "case-backlog")!
    const dao = new FindingsDAO(db)
    expect(dao.getById(created.id)).toBeDefined()

    // 重跑证据未变 ⇒ unchanged（零新行）
    const second = makePatrol().patrol()
    expect(second.findings.find(f => f.id === created.id)?.action).toBe("unchanged")

    // occurrences 3 ⇒ 证据变化 → refreshed（detail 更新，status 不动）
    caseFile({ fileName: "2026-10-12-case-grow.md", id: "case-grow", symptom: "增长症状", occurrences: 3, status: "open" })
    const third = makePatrol().patrol()
    expect(third.findings.find(f => f.id === created.id)?.action).toBe("refreshed")
    expect(JSON.parse(dao.getById(created.id)!.detail).occurrences).toBe(3)

    // 人已裁决（resolved）⇒ 永不再扰（suppressed，行内容不再动）
    dao.updateStatus(created.id, "resolved")
    caseFile({ fileName: "2026-10-12-case-grow.md", id: "case-grow", symptom: "增长症状", occurrences: 9, status: "open" })
    const fourth = makePatrol().patrol()
    expect(fourth.findings.find(f => f.id === created.id)?.action).toBe("suppressed")
    expect(JSON.parse(dao.getById(created.id)!.detail).occurrences).toBe(3)
  })

  it("退役区判例不参与六查（_retired/ 不进体检，票13 同律）", () => {
    const abs = path.join(wikiRoot, "_retired", "cases", "2026-10-12-case-dead.md")
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, [
      "---", "id: case-dead", "domain: cases", "symptom: 死判例", "tags: []", "severity: minor",
      "occurrences: 7", "source: exec:dead", "status: open", "---", "",
      "## 现场\n\nx\n\n## 诊断\n\nx\n\n## 根因\n\nx\n\n## 修复\n\nx\n\n## 教训\n\nx\n",
    ].join("\n"), "utf-8")

    const res = makePatrol().patrol()
    expect(res.findings.filter(f => f.kind === "case-backlog")).toHaveLength(0)
  })
})
