import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { WikiPatrolService } from "../patrol"
import { knowledgePatrolHandlerFor } from "../patrol-job"
import type { CodeJobContext } from "../../scheduler/code-job-registry"
import { EffectivenessLedgerService } from "../effectiveness-ledger"
import { EffectivenessSyncService } from "../effectiveness-sync"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"

/**
 * 触发面（票06 AC4 上半 + AC6 负断言）——夜巡作业「既有挂载点扩步骤」：
 * knowledgePatrolHandlerFor 新增 parseLedger 腿，失败显形 outcome 不炸作业
 * （P3 票04 afterPatrol 同款纪律），且引用记账（确定性面）不依赖 LLM。
 *
 * 负断言（AC6「运行时零感知」）：记账面源文件对 engine/providers/写闸零 import
 * ——agent 执行链路（engine/prompt/VarPool）不在本票 diff 面（git diff 复核归报告）。
 */

let db: Database.Database
let tmpRoot: string
let root: string

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eff-trig-"))
  root = path.join(tmpRoot, "kb")
  fs.mkdirSync(path.join(root, "wiki", "topics"), { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const ctx = (): CodeJobContext => ({
  scheduleId: "builtin-knowledge-patrol", jobName: "系统 · 知识夜巡", org: "",
  fireId: "fire-eff-1", args: {}, signal: new AbortController().signal, startedAtMs: Date.now(),
})

function patrolStub(): WikiPatrolService {
  return new WikiPatrolService({ db, root })
}

describe("夜巡 parseLedger 腿（既有作业扩步骤，不新建作业）", () => {
  it("正常腿：patrol 之后执行记账，outcome 不炸、账落库", async () => {
    fs.writeFileSync(
      path.join(root, "wiki", "topics", "wf-a.md"),
      `---\nid: wf-a\ntype: topic\ntitle: A\nsummary: s\ntopics: [a]\n---\n## 硬约束\n- 先 test 再 build <!--#oct-001-->\n`,
      "utf-8",
    )
    db.prepare("INSERT INTO workspaces (id,name,repo_group,path,created_at,updated_at) VALUES ('w1','w1','x',?, '2026-10-01','2026-10-01')")
      .run(path.join(tmpRoot, "ws1"))
    db.prepare("INSERT INTO executions (id,workspace_id,workflow_ref,workflow_name,status,var_pool,org,created_at,updated_at,completed_at) VALUES ('e1','w1','w','w','completed',?,'x','2026-10-13T00:00:00Z','2026-10-13T00:01:00Z','2026-10-13T00:01:00Z')")
      .run(JSON.stringify({ wiki_refs: ["wf-a#oct-001"] }))

    const ledger = new EffectivenessLedgerService({ db, root, now: () => new Date("2026-10-15T03:00:00Z") })
    const handler = knowledgePatrolHandlerFor(patrolStub(), { parseLedger: async () => { await ledger.parse() } })
    const outcome = await handler(ctx())

    expect(outcome?.summary).toContain("夜巡")
    const row = db.prepare("SELECT cited_count FROM knowledge_effectiveness WHERE rule_id = ?").get("oct-001") as { cited_count: number }
    expect(row.cited_count).toBe(1)
  })

  it("腿炸：显形进 outcome 不炸作业（报对话同律）", async () => {
    const handler = knowledgePatrolHandlerFor(patrolStub(), {
      parseLedger: async () => { throw new Error("ledger down") },
    })
    const outcome = await handler(ctx())
    expect(outcome?.summary).toContain("记账失败")
    expect(outcome?.summary).toContain("ledger down") // 显形口径=afterPatrol 先例（含 err.message，不吞错）
  })
})

describe("运行时零感知负断言（票06 AC6）", () => {
  const ledgerSrc = fs.readFileSync(path.join(__dirname, "..", "effectiveness-ledger.ts"), "utf-8")
  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "..", "..", "routes", "effectiveness.ts"), "utf-8")
  /** 剥注释后的代码面（散文注记允许引用旧教训字样——红线扫描只对**可执行面**）。 */
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("记账面代码零 import engine/providers/VarPool/写闸——纯 DB+fs 读面", () => {
    for (const src of [ledgerSrc, routeSrc].map(codeOnly)) {
      expect(src).not.toMatch(/from ["'][^"']*@octopus\/engine/)
      expect(src).not.toMatch(/from ["'][^"']*@octopus\/providers/)
      expect(src).not.toContain("VarPool")
      expect(src).not.toMatch(/from ["'][^"']*compile-queue/)
      expect(src).not.toMatch(/from ["'][^"']*wiki\/compile/)
      expect(src).not.toContain("WikiCompileService")
    }
  })

  it("红线3 钉：代码面零词面启发式（无 jaccard/相似度/重叠率/数值阈值）", () => {
    const code = codeOnly(ledgerSrc)
    expect(code).not.toContain("jaccard")
    expect(code).not.toContain("similarity")
    expect(code).not.toMatch(/0\.\d/)
  })
})

// ── P4 票07：夜巡 syncConfidence 腿（账目→confidence 快照刷页的自动触发面）──
describe("夜巡 syncConfidence 腿（票07 既有挂载点扩步骤，parseLedger 之后同序）", () => {
  it("全链腿：记账落账 → 快照刷页真实进盘（故事 28 微型链：ref→账→confidence 可见）", async () => {
    const topicAbs = path.join(root, "wiki", "topics", "wf-s.md")
    fs.writeFileSync(
      topicAbs,
      `---\nid: wf-s\ntype: topic\ntitle: S\nsummary: s\ntopics: [s]\nlast_compiled: 2026-10-12\nsources: []\n---\n## 硬约束\n- 先红后绿 <!--#oct-010-->\n`,
      "utf-8",
    )
    db.prepare("INSERT INTO workspaces (id,name,repo_group,path,created_at,updated_at) VALUES ('w2','w2','x',?, '2026-10-01','2026-10-01')")
      .run(path.join(tmpRoot, "ws2"))
    db.prepare("INSERT INTO executions (id,workspace_id,workflow_ref,workflow_name,status,var_pool,org,created_at,updated_at,completed_at) VALUES ('e2','w2','w','w','completed',?,'x','2026-10-13T00:00:00Z','2026-10-13T00:01:00Z','2026-10-13T00:01:00Z')")
      .run(JSON.stringify({ wiki_refs: ["wf-s#oct-010"] }))
    // 已测账（手算 0/(0+4)=0 ≤ 低置信区）：parse 腿再 +1 引用不动 measured 值语义
    const ledgerDao = new KnowledgeEffectivenessDAO(db)
    ledgerDao.upsert("oct-010", { cited_count: 4, helpful_count: 0, not_helpful_count: 4 })

    const ledger = new EffectivenessLedgerService({ db, root, now: () => new Date("2026-10-15T03:00:00Z") })
    const syncSvc = new EffectivenessSyncService({ db, root, now: () => new Date("2026-10-15T03:00:00Z") })
    const handler = knowledgePatrolHandlerFor(patrolStub(), {
      parseLedger: async () => { await ledger.parse() },
      syncConfidence: async () => { await syncSvc.sync() },
    })
    const outcome = await handler(ctx())

    // 外部可见产物：页 front-matter 出现滚动快照行；DB 列同步；作业不炸
    expect(fs.readFileSync(topicAbs, "utf-8")).toContain("confidence: 0")
    expect(ledgerDao.getByRuleId("oct-010")!.confidence).toBe(0)
    expect(outcome.summary).not.toContain("失败")
  })

  it("腿炸：刷页失败显形 outcome 不炸作业（parseLedger/afterPatrol 同律）", async () => {
    const handler = knowledgePatrolHandlerFor(patrolStub(), {
      syncConfidence: async () => { throw new Error("EFFECTIVENESS_SYNC_QUEUE_TIMEOUT: 队列堵") },
    })
    const outcome = await handler(ctx())
    expect(outcome.summary).toContain("同步失败")
    expect(outcome.summary).toContain("EFFECTIVENESS_SYNC_QUEUE_TIMEOUT")
  })
})
