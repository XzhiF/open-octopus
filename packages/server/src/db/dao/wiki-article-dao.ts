import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/**
 * WikiArticleDAO — wiki_articles（索引/追踪，非真源；真源是 org wiki git 仓库）。
 * FTS 同步是 external-content-less 模式（无 content= 参数，experiences_fts 先例）：
 * wiki_fts.rowid 与 wiki_articles.rowid 由编译服务手工对齐，非本 DAO 自动触发。
 */

export interface WikiArticleRow {
  org: string
  id: string
  domain: string
  title: string
  summary: string
  topics: string   // JSON array
  stability: string
  last_compiled: string
  sources: string  // JSON array
  confidence: number
  body: string
  path: string
  updated_at: string
}

export interface WikiArticleUpsert {
  org: string
  id: string
  domain: string
  title: string
  summary: string
  topics: string
  stability: string
  last_compiled: string
  sources: string
  confidence: number
  body: string
  path: string
}

export interface WikiFtsRow {
  rowid: number
  id: string
  domain: string
  title: string
  summary: string
  topics: string
  body: string
}

export class WikiArticleDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  upsert(row: WikiArticleUpsert): void {
    this.stmt(`
      INSERT INTO wiki_articles (org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path)
      VALUES (@org, @id, @domain, @title, @summary, @topics, @stability, @last_compiled, @sources, @confidence, @body, @path)
      ON CONFLICT(org, id) DO UPDATE SET
        domain=@domain, title=@title, summary=@summary, topics=@topics,
        stability=@stability, last_compiled=@last_compiled, sources=@sources,
        confidence=@confidence, body=@body, path=@path,
        updated_at=datetime('now')
    `).run(row)
  }

  get(org: string, id: string): WikiArticleRow | undefined {
    return this.stmt("SELECT * FROM wiki_articles WHERE org = ? AND id = ?").get(org, id) as WikiArticleRow | undefined
  }

  listByOrg(org: string): WikiArticleRow[] {
    return this.stmt("SELECT * FROM wiki_articles WHERE org = ? ORDER BY domain, path").all(org) as WikiArticleRow[]
  }

  /** Anchor-uniqueness scan input: all other entries' bodies/paths in this org. */
  listOthers(org: string, excludeId: string): Array<{ id: string; path: string; body: string }> {
    return this.stmt(
      "SELECT id, path, body FROM wiki_articles WHERE org = ? AND id != ?",
    ).all(org, excludeId) as Array<{ id: string; path: string; body: string }>
  }

  /** sqlite rowid of the base-table row (drives manual FTS rowid alignment). */
  getRowid(org: string, id: string): number | undefined {
    const r = this.stmt("SELECT rowid AS rid FROM wiki_articles WHERE org = ? AND id = ?").get(org, id) as { rid: number } | undefined
    return r?.rid
  }

  delete(org: string, id: string): void {
    this.stmt("DELETE FROM wiki_articles WHERE org = ? AND id = ?").run(org, id)
  }

  // ── FTS manual sync (called by the compile service inside try/catch — non-fatal) ──

  getFtsByRowid(rowid: number): WikiFtsRow | undefined {
    return this.stmt("SELECT rowid, id, domain, title, summary, topics, body FROM wiki_fts WHERE rowid = ?").get(rowid) as WikiFtsRow | undefined
  }

  insertFts(row: WikiFtsRow): void {
    this.stmt(`
      INSERT INTO wiki_fts (rowid, id, domain, title, summary, topics, body)
      VALUES (@rowid, @id, @domain, @title, @summary, @topics, @body)
    `).run(row)
  }

  deleteFts(rowid: number): void {
    this.stmt("DELETE FROM wiki_fts WHERE rowid = ?").run(rowid)
  }

  /** Full-text hit → base row (FTS5 MATCH 主检索，search API/票03 复用此入口).
   *  注意：FTS5 的 MATCH 左侧必须是真实表名（别名 f MATCH 会报 no such column）。 */
  search(org: string, query: string, limit = 10): Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">> {
    return this.stmt(`
      SELECT a.id, a.domain, a.title, a.summary, a.path
      FROM wiki_fts JOIN wiki_articles a ON a.rowid = wiki_fts.rowid
      WHERE wiki_fts MATCH ? AND a.org = ?
      LIMIT ?
    `).all(query, org, limit) as Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">>
  }
}
