import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import { escapeLikeParam } from "../like-escape"

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
  /** 链接目标 JSON 数组（front-matter ∪ 正文 wikilinks，lint.computeArticleLinks 单源）；NULL=历史行未回灌 */
  links?: string | null
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
  /** 收数组（DAO 内 JSON 序列化）或已序列化串（快照重放形）；缺省落 '[]' */
  links?: string[] | string | null
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
    // links 收口：数组→JSON；串→原样；缺省/null→**保留在库值**（COALESCE）——
    // reconcile/redistill 等清单外写通道不带 links 时不得清列（改版 code-review S2；
    // 新行 insert 落 NULL，由启动 backfillWikiArticleLinks 一次补齐）
    const links = Array.isArray(row.links) ? JSON.stringify(row.links) : (row.links ?? null)
    this.stmt(`
      INSERT INTO wiki_articles (org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path, links)
      VALUES (@org, @id, @domain, @title, @summary, @topics, @stability, @last_compiled, @sources, @confidence, @body, @path, @links)
      ON CONFLICT(org, id) DO UPDATE SET
        domain=@domain, title=@title, summary=@summary, topics=@topics,
        stability=@stability, last_compiled=@last_compiled, sources=@sources,
        confidence=@confidence, body=@body, path=@path, links=COALESCE(@links, links),
        updated_at=datetime('now')
    `).run({ ...row, links })
  }

  get(org: string, id: string): WikiArticleRow | undefined {
    return this.stmt("SELECT * FROM wiki_articles WHERE org = ? AND id = ?").get(org, id) as WikiArticleRow | undefined
  }

  /**
   * 按 org+path 定位整行（aa-fix 项③：page-retire/page-restore/revert 三通道原各持
   * 裸 SQL 副本——SELECT * 与 SELECT id 两制式一并收编 DAO 单源；SELECT-id 消费方
   * 取 .id 行为逐字等价）。
   */
  getByPath(org: string, path: string): WikiArticleRow | undefined {
    return this.stmt("SELECT * FROM wiki_articles WHERE org = ? AND path = ?").get(org, path) as WikiArticleRow | undefined
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
  search(org: string, query: string, limit = 10, domain?: string): Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">> {
    return this.stmt(`
      SELECT a.id, a.domain, a.title, a.summary, a.path
      FROM wiki_fts JOIN wiki_articles a ON a.rowid = wiki_fts.rowid
      WHERE wiki_fts MATCH ? AND a.org = ? AND (? IS NULL OR a.domain = ?)
      LIMIT ?
    `).all(query, org, domain ?? null, domain ?? null, limit) as Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">>
  }

  /** LIKE 降级检索（票03）：FTS5 零命中或 MATCH 抛错时使用——CJK 子串在
   *  unicode61 下不是独立 token，session_memory_fts/evolution-dao 同款先例。
   *  %_\\ 转义按 LIKE 语义（escape '\'），title/summary/body 三列子串命中。 */
  searchLike(org: string, query: string, limit = 10, domain?: string): Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">> {
    const escaped = escapeLikeParam(query)
    return this.stmt(`
      SELECT id, domain, title, summary, path
      FROM wiki_articles
      WHERE org = ? AND (? IS NULL OR domain = ?)
        AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
      ORDER BY domain, path
      LIMIT ?
    `).all(org, domain ?? null, domain ?? null, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, limit) as Array<Pick<WikiArticleRow, "id" | "domain" | "title" | "summary" | "path">>
  }
}
