import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { reconcileWikiIndex, resolveReconcileConfig } from "../reconcile"
import { getGlobalWikiRoot } from "../../global-paths"

/**
 * 归档资产化票01 · 默认库对账脚本 S1 环级测试（wiki-redistill.test.ts 同法）：
 * 真 fs（tmpdir wiki 根，手工 fixture 五类各 1 页）+ applySchema 临时 DB。
 * 对账 = 以盘为唯一真相重建 wiki_articles + FTS（org 钉 global）。
 * Expected 值来自独立真相源：fixture 内联字面量（人工从 fixture 文本抄算），
 * 绝不与实现对账——行数/逐类计数/变更清单全部钉死在测试里。
 */

// ── fixture 语料：v3 五类各 1 页（body 带唯一 token 供 FTS 断言）──────────

const ENT_PAGE = `---
id: ent-reconcile-demo
type: entity
entity_kind: project
title: 对账 fixture 实体页
summary: fixture entity summary
topics: [fixture]
links: []
stability: stable
last_compiled: 2026-10-14
sources: [doc:fixture]
confidence: 0.8
---
正文 entunique01 唯一实体标记
`

const CON_PAGE = `---
id: con-reconcile-demo
type: concept
title: 对账 fixture 概念页
summary: fixture concept summary
topics: [fixture]
links: []
stability: stable
last_compiled: 2026-10-14
sources: [doc:fixture]
confidence: 0.8
---
正文 conunique02 唯一概念标记
`

const TOP_PAGE = `---
id: top-reconcile-demo
type: topic
title: 对账 fixture 主题页
summary: fixture topic summary
topics: [fixture]
links: []
stability: stable
last_compiled: 2026-10-14
sources: [doc:fixture]
confidence: 0.8
---
## 硬约束

- 对账纪律示例规则一条，足够长以通过 lint 预算检查即可用 topunique03 定位 <!--#oct-301-->
`

const SRC_PAGE = `---
id: src-reconcile-demo
type: source
title: 对账 fixture 来源页
summary: fixture source summary
topics: [fixture]
links: []
stability: stable
last_compiled: 2026-10-14
sources: [raw:fixture]
confidence: 0.8
---
正文 srcunique04 唯一来源标记
`

const CASE_PAGE = `---
id: case-reconcile-demo
domain: cases
symptom: 对账 fixture 判例症状 tokenalpha-case
tags: [fixture]
severity: minor
occurrences: 1
source: task:aa01-fixture
status: open
---
现场：判例 fixture 正文。
`

/** 盘上真源 = 5 页（独立真相源：人工数 → entity/concept/topic/source/case 各 1）。 */
const FIXTURE_PAGES: Array<[string, string]> = [
  ["entities/ent-reconcile-demo.md", ENT_PAGE],
  ["concepts/con-reconcile-demo.md", CON_PAGE],
  ["topics/top-reconcile-demo.md", TOP_PAGE],
  ["sources/src-reconcile-demo.md", SRC_PAGE],
  ["cases/2026-10-10-reconcile-demo.md", CASE_PAGE],
]

function seedDb(db: Database.Database): WikiArticleDAO {
  const dao = new WikiArticleDAO(db)
  const put = (org: string, id: string, domain: string, title: string, body: string, relPath: string): void => {
    dao.upsert({
      org, id, domain, title, summary: title, topics: JSON.stringify(["fixture"]),
      stability: "stable", last_compiled: "2026-10-14", sources: JSON.stringify(["doc:fixture"]),
      confidence: 0.8, body, path: relPath,
    })
    const rid = dao.getRowid(org, id)!
    dao.insertFts({ rowid: rid, id, domain, title, summary: title, topics: JSON.stringify(["fixture"]), body })
  }
  // 漂移现场（对照票面：多行/缺行/org 错/值漂移 + 一行完全匹配验证零重写）：
  put(GLOBAL_WIKI_ORG, "ghost-gone", "concept", "盘上已无此页的幽灵行", "ghostunique05 幽灵正文", "concepts/ghost-gone.md") // 多行 → 删
  put("xzf-dev", "ent-reconcile-demo", "entity", "旧 org 残行（错 org）", "entunique01 唯一实体标记", "entities/ent-reconcile-demo.md") // org 错 → 删
  put(GLOBAL_WIKI_ORG, "con-reconcile-demo", "concept", "标题已漂移的旧值", "conunique02 唯一概念标记", "concepts/con-reconcile-demo.md") // 值漂移 → 改
  put(GLOBAL_WIKI_ORG, "src-reconcile-demo", "sources", "对账 fixture 来源页", "正文 srcunique04 唯一来源标记", "sources/src-reconcile-demo.md") // domain 旧值 → 改
  // top / case 两页 = 缺行 → 补
  // ent（global）= 与盘完全一致的行 → 零重写（updated 不得包含）
  dao.upsert({
    org: GLOBAL_WIKI_ORG, id: "ent-reconcile-demo", domain: "entity",
    title: "对账 fixture 实体页", summary: "fixture entity summary", topics: JSON.stringify(["fixture"]),
    stability: "stable", last_compiled: "2026-10-14", sources: JSON.stringify(["doc:fixture"]),
    confidence: 0.8, body: "正文 entunique01 唯一实体标记\n", path: "entities/ent-reconcile-demo.md",
  })
  return dao
}

let db: Database.Database
let tmpDir: string
let wikiRoot: string

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa01-reconcile-"))
  wikiRoot = path.join(tmpDir, "knowledge", "wiki")
  for (const [rel, content] of FIXTURE_PAGES) {
    const abs = path.join(wikiRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf-8")
  }
  seedDb(db)
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe("wiki-reconcile（票01 默认库对账）", () => {
  it("对账后 wiki_articles == 盘上真源：删多余/补缺失/改漂移/org 全 global", () => {
    const report = reconcileWikiIndex(db, { wikiRoot })

    // 行数 vs 盘页数（独立真相源：fixture 5 页）
    expect(report.diskPages).toBe(5)
    expect(report.beforeTotal).toBe(5) // seedDb 人工数：ghost + xzf-dev/ent + con + src + 匹配的 ent = 5 行
    expect(report.afterTotal).toBe(5)

    // 变更清单（逐 id 钉死）
    expect(report.deleted).toEqual([
      { org: GLOBAL_WIKI_ORG, id: "ghost-gone" },
      { org: "xzf-dev", id: "ent-reconcile-demo" },
    ])
    expect([...report.inserted].sort()).toEqual(["case-reconcile-demo", "top-reconcile-demo"])
    expect([...report.updated].sort()).toEqual(["con-reconcile-demo", "src-reconcile-demo"])

    // org 全 global + 五类各 1（票面核查口径）
    const rows = db.prepare("SELECT org, id, domain FROM wiki_articles ORDER BY id").all() as Array<{ org: string; id: string; domain: string }>
    expect(rows.map(r => r.id)).toEqual([
      "case-reconcile-demo", "con-reconcile-demo", "ent-reconcile-demo", "src-reconcile-demo", "top-reconcile-demo",
    ])
    expect(rows.every(r => r.org === GLOBAL_WIKI_ORG)).toBe(true)
    expect(report.afterByType).toEqual({ entity: 1, concept: 1, topic: 1, source: 1, case: 1 })

    // 漂移行值已收敛到盘（title/domain 独立字面量）
    const con = db.prepare("SELECT title, domain FROM wiki_articles WHERE org = ? AND id = ?").get(GLOBAL_WIKI_ORG, "con-reconcile-demo") as { title: string; domain: string }
    expect(con.title).toBe("对账 fixture 概念页")
    expect(con.domain).toBe("concept")
    const src = db.prepare("SELECT domain FROM wiki_articles WHERE id = ?").get("src-reconcile-demo") as { domain: string }
    expect(src.domain).toBe("source")

    // 缺行补齐后的字段面（判例走 caseEntryView：title/summary=symptom、confidence=1、last_compiled=文件名日期）
    const cs = db.prepare("SELECT domain, title, summary, confidence, last_compiled, path FROM wiki_articles WHERE id = ?").get("case-reconcile-demo") as { domain: string; title: string; summary: string; confidence: number; last_compiled: string; path: string }
    expect(cs).toEqual({
      domain: "case",
      title: "对账 fixture 判例症状 tokenalpha-case",
      summary: "对账 fixture 判例症状 tokenalpha-case",
      confidence: 1,
      last_compiled: "2026-10-10",
      path: "cases/2026-10-10-reconcile-demo.md",
    })

    // FTS 与基表一致：幽灵行不再可搜、补行可搜、行数守恒
    const dao = new WikiArticleDAO(db)
    expect(dao.search(GLOBAL_WIKI_ORG, "ghostunique05")).toEqual([])
    expect(dao.search(GLOBAL_WIKI_ORG, "topunique03").map(r => r.id)).toEqual(["top-reconcile-demo"])
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM wiki_fts").get() as { n: number }).n
    expect(ftsCount).toBe(5)
  })

  it("无显式 DB 路径 ⇒ 拒绝执行（绝不隐式打默认库）；参数/env 显式给定则通过", () => {
    // 独立真相源 = 票面「DB 路径参数/env 必填，拒绝无参直跑默认库」
    expect(() => resolveReconcileConfig([], {})).toThrow(/OCTOPUS_DB_PATH/)
    // env 覆盖缝（ops 与测试共用）
    const byEnv = resolveReconcileConfig([], { OCTOPUS_DB_PATH: "/seed/oct.db", OCTOPUS_KNOWLEDGE_DIR: "/seed/kroot" })
    expect(byEnv.dbPath).toBe("/seed/oct.db")
    expect(byEnv.wikiRoot).toBe(getGlobalWikiRoot("/seed/kroot"))
    // 参数优先于 env
    const byArg = resolveReconcileConfig(["--db", "/arg/oct.db", "--wiki-root", "/arg/wiki"], { OCTOPUS_DB_PATH: "/seed/oct.db" })
    expect(byArg.dbPath).toBe("/arg/oct.db")
    expect(byArg.wikiRoot).toBe("/arg/wiki")
  })

  it("幂等：连跑两次第二次零变更（diff 空，表内容逐列不动）", () => {
    const dump = (): string =>
      JSON.stringify(db.prepare("SELECT org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path FROM wiki_articles ORDER BY org, id").all())

    const first = reconcileWikiIndex(db, { wikiRoot })
    expect(first.diskPages).toBe(5)
    const afterFirst = dump()
    // 哨兵：钉死「一致行不重写」——updated_at 只有在 upsert 被再次执行时才会被刷新
    db.prepare("UPDATE wiki_articles SET updated_at = 'SENTINEL'").run()

    const second = reconcileWikiIndex(db, { wikiRoot })
    // 第二次变更清单全空（票面「重跑 diff 空」）
    expect(second.inserted).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.deleted).toEqual([])
    expect(second.beforeTotal).toBe(second.afterTotal)
    // 表内容逐列不动，且一致行连 updated_at 都没被无意义重写
    expect(dump()).toBe(afterFirst)
    expect(db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE updated_at != 'SENTINEL'").get()).toEqual({ n: 0 })
  })

  it("只写 DB 索引层：对账全程零 fs 写（wiki 根逐文件 hash 不变、不新增文件）", () => {
    // 独立真相源 = 票面红线「绝不写 wiki git 仓/raw/知识根文件」
    const hashTree = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          for (const [k, v] of Object.entries(hashTree(abs))) out[`${entry.name}/${k}`] = v
        } else {
          out[entry.name] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")
        }
      }
      return out
    }
    const before = hashTree(wikiRoot)
    reconcileWikiIndex(db, { wikiRoot })
    reconcileWikiIndex(db, { wikiRoot })
    expect(hashTree(wikiRoot)).toEqual(before)
    // 尤其不得出现编译通道才产的导航文件
    expect(fs.existsSync(path.join(wikiRoot, "INDEX.md"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, "LOG.md"))).toBe(false)
  })

  it("空盘护栏：盘 0 页而库有行 ⇒ 拒跑抛错，DB 原样不动", () => {
    // 独立真相源：本票设计「防 wiki 根误配把生产索引当漂移删光」
    const emptyRoot = path.join(tmpDir, "not-a-wiki")
    const rowsBefore = db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }
    expect(() => reconcileWikiIndex(db, { wikiRoot: emptyRoot })).toThrow(/RECONCILE_REFUSE_EMPTY_DISK/)
    const rowsAfter = db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }
    expect(rowsAfter.n).toBe(rowsBefore.n)
  })
})
