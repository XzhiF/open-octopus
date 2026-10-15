import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { EffectivenessLedgerService } from "../services/knowledge/effectiveness-ledger"
import { applySchema } from "../db/schema"

/**
 * AC5 首批烟测数据（票06）——真实现场复演，**默认 skip、不入库常规跑**（非 hermetic：
 * 读本机 KC 分支库与真 xzf-dev 日志盘）。运行法：
 *   $env:OCTOPUS_EFF_SMOKE_DB="C:/Users/<you>/.octopus/db/octopus-feat-knowledge-center-20261013.db"
 *   $env:OCTOPUS_EFF_KB_ROOT="C:/Users/<you>/.octopus/knowledge"   # 只读知识根
 *   pnpm --filter @octopus/server test -- --run smoke-effectiveness
 *
 * 安全面：真库只 COPY 到 tmpdir 后打开（原文件零写，红线「真默认库/知识根只读」）；
 * 日志 JSONL/知识根纯读；LLM 走离线闸（判定面诚实缺席 skipped，引用面照常）。
 * 烟测对象 = KC E2E 存量执行（wiki_refs 真锚点 2 行：oct-007/008/014/015 +
 * stale 注；wiki-consume.jsonl 含 INDEX.md/两真页 Read 工具调用行）。
 */

const SMOKE_DB = process.env.OCTOPUS_EFF_SMOKE_DB ?? ""
const KB_ROOT = process.env.OCTOPUS_EFF_KB_ROOT ?? ""

describe.skipIf(!SMOKE_DB || !KB_ROOT)("effectiveness 烟测（KC 分支库真数据 → tmp 副本落账）", () => {
  it("解析存量执行：真锚点账目落 knowledge_effectiveness，游标推进，重跑幂等", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eff-smoke-"))
    const dbCopy = path.join(tmpRoot, "smoke.db")
    fs.copyFileSync(SMOKE_DB, dbCopy)
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(SMOKE_DB + ext)) fs.copyFileSync(SMOKE_DB + ext, dbCopy + ext)
    }
    const db = new Database(dbCopy)
    try {
      // 真旧库蓝绿迁移面（顺带实证 v55）：分支库是旧 schema ⇒ 副本上 applySchema
      // 走 rename 迁移；原文件零写。
      applySchema(db)
      const before = db.prepare("SELECT COUNT(*) c FROM effectiveness_cursors").get() as { c: number }
      expect(before.c).toBe(0)

      const svc = new EffectivenessLedgerService({ db, root: KB_ROOT }) // deps.llm 缺席 = 诚实不判定
      const first = await svc.parse()

      expect(first.scanned).toBeGreaterThan(0)
      // 真锚点必须落账（kc15 两执行的 wiki_refs 交集锚）
      const anchors = db.prepare("SELECT rule_id, cited_count, last_cited FROM knowledge_effectiveness ORDER BY rule_id").all() as Array<{ rule_id: string; cited_count: number; last_cited: string }>
      const ids = anchors.map(a => a.rule_id)
      expect(ids).toEqual(expect.arrayContaining(["oct-007", "oct-008", "oct-014", "oct-015"]))
      // stale 前缀项与正常引用同锚并计：oct-008 两次执行各 1 = 2（非 3——虚增钉）
      expect(anchors.find(a => a.rule_id === "oct-008")?.cited_count).toBe(2)
      // 页级 Read 记账（wiki-consume.jsonl 真行：topics/wf-prd-impl.md 等整读）
      expect(ids).toEqual(expect.arrayContaining(["wf-prd-impl", "prj-open-octopus"]))
      // 判定面诚实缺席（无 blocker 信道存量 ⇒ link_status 空、helpful/not_helpful 零）
      expect(first.helpful).toBe(0)
      expect(first.notHelpful).toBe(0)

      // 游标推进 + 重跑幂等（红线6）
      const cur = db.prepare("SELECT COUNT(*) c FROM effectiveness_cursors").get() as { c: number }
      expect(cur.c).toBe(first.scanned)
      const second = await svc.parse()
      expect(second.scanned).toBe(0)
      const after = db.prepare("SELECT SUM(cited_count) s FROM knowledge_effectiveness").get() as { s: number }
      const mid = first.citations // 首轮落账总数（键×执行去重和）
      expect(after.s).toBe(mid)
      // eslint-disable-next-line no-console
      console.log("[smoke] 落账真锚点：", JSON.stringify(anchors))
      console.log("[smoke] 首轮报告：", JSON.stringify(first))
    } finally {
      db.close()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
