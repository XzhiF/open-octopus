import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema, SCHEMA_VERSION } from "../db/schema"

/**
 * Ticket 01 — wiki_articles + wiki_fts 蓝绿迁移（纯增量：新表进 schema.sql +
 * SCHEMA_VERSION 51→52；migrations 先于 schema.sql 跑，CREATE IF NOT EXISTS 幂等，
 * 旧库升级不丢既有行 — experiences_fts v2 先例同款断言，schema-migration.test.ts）。
 */
describe("wiki schema migration (v52)", () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(":memory:")
  })

  afterEach(() => {
    db?.close()
  })

  // 版本推进注记：票01 建表时为 51→52；票05 增 findings 表后 SCHEMA_VERSION=53；
  // 票08 清理账 pending_review 表退役 53→54，user_version 随之——wiki 表形态断言不变（纯增量/纯删表）。
  it("bumps SCHEMA_VERSION to 54 and stamps user_version", () => {
    expect(SCHEMA_VERSION).toBe(54)
    applySchema(db)
    expect(db.pragma("user_version", { simple: true })).toBe(54)
  })

  it("creates wiki_articles with the index columns (org-scoped composite PK)", () => {
    applySchema(db)
    const cols = db.prepare("PRAGMA table_info(wiki_articles)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining([
      "org", "id", "domain", "title", "summary", "topics",
      "stability", "last_compiled", "sources", "confidence", "body", "path", "updated_at",
    ]))
  })

  it("creates wiki_fts as an FTS5 virtual table searchable over title/summary/topics/body", () => {
    applySchema(db)
    const t = db.prepare(
      "SELECT sql FROM sqlite_master WHERE name='wiki_fts'",
    ).get() as { sql: string } | undefined
    expect(t?.sql).toContain("fts5")
    const cols = db.prepare("PRAGMA table_info(wiki_fts)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(["id", "domain", "title", "summary", "topics", "body"]))
  })

  it("keeps existing wiki rows and FTS hits across a repeated applySchema (upgrade pass)", () => {
    applySchema(db)
    db.prepare(`
      INSERT INTO wiki_articles (org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path)
      VALUES ('xzf-dev', 'prj-octopus', 'projects', 'Octopus 平台工程知识', 'monorepo 构建/测试/端口规则与已知陷阱',
              '["build","test","ports","pitfall"]', 'stable', '2026-10-12',
              '["archive:task-207","chat:session-8f21","doc:windows-bash.md"]', 0.86,
              '- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->', 'projects/prj-octopus.md')
    `).run()
    const base = db.prepare("SELECT rowid AS rid FROM wiki_articles WHERE id='prj-octopus'").get() as { rid: number }

    // Manual rowid-aligned FTS sync (external-content-less mode — compile service precedent, experiences pattern)
    db.prepare(`
      INSERT INTO wiki_fts (rowid, id, domain, title, summary, topics, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(base.rid, "prj-octopus", "projects", "Octopus 平台工程知识", "monorepo 构建/测试/端口规则与已知陷阱",
      '["build","test","ports","pitfall"]', "- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->")

    // Second startup on the existing DB — migrations run BEFORE schema.sql; must not lose rows
    applySchema(db)

    const count = db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }
    expect(count.n).toBe(1)

    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH ?").all("Promise") as { id: string }[]
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe("prj-octopus")
  })

  it("wiki_fts rowid join back to wiki_articles resolves path", () => {
    applySchema(db)
    db.prepare(`
      INSERT INTO wiki_articles (org, id, domain, title, body, path)
      VALUES ('xzf-dev', 'wf-prd-impl', 'workflows', 'prd-impl 工作流经验', '- 修改 shared/ 后必须先 pnpm build <!--#sop-001-->', 'workflows/wf-prd-impl.md')
    `).run()
    const base = db.prepare("SELECT rowid AS rid FROM wiki_articles WHERE id='wf-prd-impl'").get() as { rid: number }
    db.prepare("INSERT INTO wiki_fts (rowid, id, domain, title, summary, topics, body) VALUES (?, ?, ?, ?, '', '[]', ?)")
      .run(base.rid, "wf-prd-impl", "workflows", "prd-impl 工作流经验", "- 修改 shared/ 后必须先 pnpm build <!--#sop-001-->")

    const joined = db.prepare(`
      SELECT a.path FROM wiki_fts JOIN wiki_articles a ON a.rowid = wiki_fts.rowid
      WHERE wiki_fts MATCH 'shared'
    `).all() as { path: string }[]
    expect(joined).toEqual([{ path: "workflows/wf-prd-impl.md" }])
  })
})
