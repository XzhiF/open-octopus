import { Hono } from "hono"
import { WikiArticleDAO } from "../db/dao/wiki-article-dao"
import { extractRuleAnchors } from "../services/knowledge/wiki/format"
import { WIKI_DOMAINS, WIKI_DOMAIN_LABELS } from "../services/knowledge/wiki/paths"
import { errorResponse } from "../services/knowledge/validators"

/**
 * Wiki 只读 API（spec §服务端 API 与存储：tree / article；search 属票03）。
 * 数据源是 wiki_articles 索引表（编译服务同步），不扫盘——原型 Tab③ 的
 * 「检索/统计不扫盘」纪律。写路径不在这里（唯一写入口 = WikiCompileService）。
 *
 * 路由工厂签名沿用 archive-routes 先例：构造注入依赖（DAO），测试传 in-memory DB。
 */

// wiki 词条 id：kebab-case（格式 v2 schema 同源）；显式拒绝 '/'、'..'、空白与编码分隔符
const ENTRY_ID_RE = /^[a-z][a-z0-9-]*$/i

export function createWikiRoutes(articles: WikiArticleDAO): Hono {
  const routes = new Hono()

  // GET /api/knowledge/wiki/tree?org= — 域树 + 统计
  routes.get("/tree", (c) => {
    try {
      const org = c.req.query("org") || "default"
      const rows = articles.listByOrg(org)

      const stats = {
        entries: rows.filter(r => r.domain !== "cases").length,
        cases: rows.filter(r => r.domain === "cases").length,
        rules: 0,
        lastCompiled: "",
        pendingReview: 0,
      }

      const domains: Array<{
        name: string
        label: string
        count: number
        entries: Array<{ id: string; path: string; title: string; summary: string; stability: string; ruleCount: number }>
      }> = []

      for (const domain of WIKI_DOMAINS) {
        const inDomain = rows.filter(r => r.domain === domain)
        if (inDomain.length === 0) continue
        const mapped = inDomain.map(r => {
          const ruleCount = extractRuleAnchors(r.body).length
          stats.rules += ruleCount
          if (r.last_compiled > stats.lastCompiled) stats.lastCompiled = r.last_compiled
          return { id: r.id, path: r.path, title: r.title, summary: r.summary, stability: r.stability, ruleCount }
        })
        domains.push({ name: domain, label: WIKI_DOMAIN_LABELS[domain], count: mapped.length, entries: mapped })
      }

      try {
        stats.pendingReview = (articles.getDb()
          .prepare("SELECT COUNT(*) AS n FROM pending_review WHERE status IN ('pending','deferred')")
          .get() as { n: number }).n
      } catch { /* pending_review 缺席时不阻塞树查询 */ }

      return c.json({ org, domains, stats })
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki.tree")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/wiki/article/:id?org= — 单词条正文 + 元数据
  // （id 缺失走 Hono 路由 404；格式非法（traversal/空白/编码分隔符）= 400 INVALID_PARAM）
  routes.get("/article/:id", (c) => {
    const id = c.req.param("id")
    if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid wiki entry id format" } }, 400)
    }

    try {
      const org = c.req.query("org") || "default"
      const row = articles.get(org, id)
      if (!row) {
        return c.json({ error: { code: "NOT_FOUND", message: "Wiki entry not found" } }, 404)
      }
      return c.json({
        id: row.id,
        org: row.org,
        domain: row.domain,
        title: row.title,
        summary: row.summary,
        topics: JSON.parse(row.topics) as string[],
        stability: row.stability,
        lastCompiled: row.last_compiled,
        sources: JSON.parse(row.sources) as string[],
        confidence: row.confidence,
        path: row.path,
        updatedAt: row.updated_at,
        body: row.body,
        anchors: extractRuleAnchors(row.body),
      })
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki.article")
      return c.json(body, status)
    }
  })

  return routes
}
