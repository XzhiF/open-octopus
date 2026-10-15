/**
 * 票09 item-6 S1 — 夜巡触发面「既有挂载点扩步骤」：knowledgePatrolHandlerFor 新增
 * autoRetire 腿，挂在票06 parseLedger 腿之后（spec 故事 16「夜巡步骤」+ 票面「doctor
 * 之后跑，吃当夜账」——记账腿先落账、窄口腿后读账，顺序即数据契约）。
 *
 * 失败显形进 outcome 不炸作业（afterPatrol/parseLedger 同律）；缺省零行为变化
 * （既有夜巡测试零回归）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { WikiPatrolService } from "../patrol"
import { knowledgePatrolHandlerFor } from "../patrol-job"
import type { CodeJobContext } from "../../scheduler/code-job-registry"

let db: Database.Database
let tmpRoot: string
let root: string

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "we09-trig-"))
  root = path.join(tmpRoot, "kb")
  fs.mkdirSync(path.join(root, "wiki", "topics"), { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function patrolStub(): WikiPatrolService {
  return new WikiPatrolService({ db, root })
}

function ctx(): CodeJobContext {
  return { jobId: "builtin-knowledge-patrol", runId: "run-1", startedAt: new Date("2026-10-14T03:17:00Z"), log: () => {} } as unknown as CodeJobContext
}

describe("夜巡 autoRetire 腿（票09：既有作业扩步骤，挂在 parseLedger 之后吃当夜账）", () => {
  it("正常腿：记账腿落账后窄口腿读到的账目可见（顺序=数据契约），outcome 不炸", async () => {
    let rowsSeenByGate = -1
    const handler = knowledgePatrolHandlerFor(patrolStub(), {
      // 票06 记账腿桩：落一条锚点引用账（时刻构造，红线6 无 sleep）
      parseLedger: async () => {
        new KnowledgeEffectivenessDAO(db).incrementCited("oct-001", "2026-07-01T00:00:00.000Z")
      },
      // 窄口腿桩：读账——若挂在 parseLedger 之前，此处读到 0 行（本断言即顺序哨）
      autoRetire: async () => {
        rowsSeenByGate = new KnowledgeEffectivenessDAO(db).listAll().length
      },
    })
    const outcome = await handler(ctx())
    expect(outcome?.summary).toContain("夜巡")
    expect(rowsSeenByGate).toBe(1)
    expect(outcome?.summary).not.toContain("自动退役失败")
  })

  it("腿炸：显形进 outcome 不炸作业（记账/草案扫描同律），其余步骤照跑", async () => {
    let parseRan = false
    const handler = knowledgePatrolHandlerFor(patrolStub(), {
      parseLedger: async () => { parseRan = true },
      autoRetire: async () => { throw new Error("gate down") },
    })
    const outcome = await handler(ctx())
    expect(parseRan).toBe(true)
    expect(outcome?.summary).toContain("自动退役失败")
    expect(outcome?.summary).toContain("gate down") // 显形口径=含 err.message 不吞错
  })

  it("缺省零行为变化：不传 autoRetire 的既有夜巡照常回报（票06/票13 测试群零回归）", async () => {
    const handler = knowledgePatrolHandlerFor(patrolStub(), {})
    const outcome = await handler(ctx())
    expect(outcome?.summary).toContain("夜巡体检")
  })
})
