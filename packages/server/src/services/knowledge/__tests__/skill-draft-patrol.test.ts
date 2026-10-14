// packages/server/src/services/knowledge/__tests__/skill-draft-patrol.test.ts
//
// P3 票04 — b 路巡检触发接线（票面第 2 行「触发点 = 归档 hook + 巡检」的巡检腿）。
//
// Seam：knowledgePatrolHandlerFor(patrol, { afterPatrol }) ——巡检产出**之后**执行
// 草案扫描（afterPatrol 消费本轮 report）。纪律：afterPatrol 抛错只显形进 outcome，
// 不吞巡检成果、不炸作业（与「报对话失败」同律）；成功零噪声。
// 真链例：蒸馏流程型判例 → 巡检 handler 跑完 → drafts 区出现草案（b 路经巡检触发）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { WikiPatrolService } from "../patrol"
import { knowledgePatrolHandlerFor } from "../patrol-job"
import { SkillDraftService } from "../skill-draft-service"

let tmpRoot: string
let knowledgeRoot: string
let db: Database.Database

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa04-patrol-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  fs.mkdirSync(path.join(knowledgeRoot, "wiki", "cases"), { recursive: true })
  db = new Database(":memory:")
  applySchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("巡检后草案扫描接线（S1·票04 触发点巡检腿）", () => {
  it("afterPatrol 在 patrol() 产出后被调用（携 report），成功路径零噪声；抛错显形 outcome 不炸作业", async () => {
    const patrol = new WikiPatrolService({ db, root: knowledgeRoot })
    const seen: number[] = []
    const handler = knowledgePatrolHandlerFor(patrol, {
      afterPatrol: (report) => { seen.push(report.scanned.pages) },
    })
    const outcome = await handler({ jobId: "j1", jobName: "knowledge-patrol", now: new Date() } as never)
    expect(seen).toHaveLength(1)
    expect(outcome.summary).not.toContain("草案")

    const boom = knowledgePatrolHandlerFor(patrol, {
      afterPatrol: () => { throw new Error("draft scan down") },
    })
    const outcome2 = await boom({ jobId: "j1", jobName: "knowledge-patrol", now: new Date() } as never)
    expect(outcome2.summary).toContain("草案扫描失败")
    expect(outcome2.summary).toContain("夜巡体检") // 巡检成果不被吞
  })

  it("真链：蒸馏流程型判例 + afterPatrol=service.detectProceduralCases ⇒ 巡检跑完草案落 drafts 区（触发点闭合）", async () => {
    fs.writeFileSync(path.join(knowledgeRoot, "wiki", "cases", "2026-10-12-case-flow.md"), [
      "---", "id: case-flow", "domain: cases", "symptom: 端口占用假死需拆机",
      "tags: [net]", "severity: major", "occurrences: 3", "source: exec:ex1",
      "rule_ref: oct-007", "status: distilled", "---", "",
      "## 现场", "", "端口 bind 失败。", "", "## 诊断", "", "孤儿进程占位。", "",
      "## 根因", "", "拆机杀不净。", "",
      "## 修复", "", "固定流程：先列占用 pid，再逐个 kill，最后复核端口。", "",
      "## 教训", "", "拆机按清单逐步走。", "",
    ].join("\n"), "utf-8")
    const service = new SkillDraftService({ root: knowledgeRoot, propose: async () => "", revise: async () => "" })
    const handler = knowledgePatrolHandlerFor(new WikiPatrolService({ db, root: knowledgeRoot }), {
      afterPatrol: () => service.detectProceduralCases(),
    })
    await handler({ jobId: "j1", jobName: "knowledge-patrol", now: new Date() } as never)
    expect(fs.existsSync(path.join(knowledgeRoot, "drafts", "skills", "flow-case-flow", "SKILL.md"))).toBe(true)
  })

  it("afterPatrol 缺省 ⇒ 现状零变（票03/13 既有夜巡作业面不动）", async () => {
    const patrol = new WikiPatrolService({ db, root: knowledgeRoot })
    const handler = knowledgePatrolHandlerFor(patrol, {})
    const outcome = await handler({ jobId: "j1", jobName: "knowledge-patrol", now: new Date() } as never)
    expect(outcome.summary).toContain("夜巡体检")
    expect(fs.existsSync(path.join(knowledgeRoot, "drafts"))).toBe(false)
  })
})
