import { Hono } from "hono"
import fs from "fs"
import path from "path"
import { WikiArticleDAO } from "../db/dao/wiki-article-dao"
import { extractRuleAnchors, RULE_ANCHOR_RE, parseCaseMarkdown } from "../services/knowledge/wiki/format"
import { WIKI_DOMAINS, WIKI_DOMAIN_LABELS, resolveWikiRoot } from "../services/knowledge/wiki/paths"
import { WIKI_LOG_FILE } from "../services/knowledge/wiki/compile"
import { spawnGit } from "../services/knowledge/wiki/wiki-git"
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

/**
 * 命中定位：扫描正文行，收集包含查询词（大小写不敏感）的规则行锚点；
 * snippet = 首个命中行（去掉不可见锚点注释后的原文）。无命中行（如仅标题/摘要命中）
 * 时回退 summary，anchors 为空。
 */
function locateQueryHits(body: string, query: string): { snippet: string; anchors: string[] } {
  const needle = query.toLowerCase()
  const anchors: string[] = []
  let snippet = ""
  for (const raw of body.split("\n")) {
    const line = raw.replace(RULE_ANCHOR_RE, "").replace(/\s+$/, "")
    if (!line.toLowerCase().includes(needle)) continue
    if (!snippet) snippet = line
    const m = raw.match(RULE_ANCHOR_RE)
    if (m && !anchors.includes(m[1])) anchors.push(m[1])
  }
  return { snippet, anchors }
}

/**
 * 票03 UI 数据面：LOG.md 全文（左树 System 组「LOG.md 有渲染视图」的数据源）——
 * 只读文件探测，缺失/不可读返回 null（诚实降级，绝不 500）。
 */
function readWikiLog(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, WIKI_LOG_FILE), "utf-8")
  } catch {
    return null
  }
}

/**
 * 票03 UI 数据面：词条路径的 git 近史（右栏「git 近史」）。
 * 非 git 仓 / 无提交 / git 抖动一律 [] —— 只读降级，与 archive 诚实降级同律。
 */
function gitHistoryFor(root: string, entryPath: string, limit = 5): Array<{ hash: string; date: string; message: string }> {
  try {
    const r = spawnGit(root, 5000).run(["log", `-n${limit}`, "--date=short", "--format=%h\t%ad\t%s", "--", entryPath])
    if (r.status !== 0) return []
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [hash, date, message] = line.split("\t")
        return { hash, date, message: message ?? "" }
      })
  } catch {
    return []
  }
}

/**
 * 票04：判例的 status/rule_ref/occurrences/severity 不进 DB 索引表（schema v52 无列，
 * 判例真源在 fs——"检索/统计不扫盘"禁的是全库遍历，逐命中读 ≤topK 个文件是定向读，
 * 与 per-hit 取整行 body 同量级）。顺藤指针 rule_ref 随命中结果携带。
 */
function caseFieldsFor(root: string, relPath: string): {
  symptom: string
  tags: string[]
  severity: string
  occurrences: number
  ruleRef: string | null
  status: string
} | null {
  try {
    const { meta } = parseCaseMarkdown(fs.readFileSync(path.join(root, relPath), "utf-8"))
    return {
      symptom: meta.symptom,
      tags: meta.tags,
      severity: meta.severity,
      occurrences: meta.occurrences,
      ruleRef: meta.rule_ref ?? null,
      status: meta.status,
    }
  } catch {
    return null
  }
}

/**
 * 判例加权分（票04：domain=cases 检索 symptom/tags 加权命中）：
 * symptom（title/summary 两列同值）×4 + tags ×3 + 正文偶然提及 ×1。
 * "判例比法条更贴现场"——卡壳按症状检索时，症状命中的判例必须压过只在
 * 正文顺带提了一嘴的命中（prototype Tab③ 行 230 检索纪律）。
 */
function caseWeightScore(
  q: string,
  row: { title: string; summary: string; topics: string; body: string } | undefined,
): number {
  if (!row) return 0
  const ql = q.toLowerCase()
  const toks = [...new Set([ql, ...ql.split(/\s+/).filter(Boolean)])]
  const hits = (text: string) => toks.some(t => text.toLowerCase().includes(t))
  let s = 0
  if (hits(row.title) || hits(row.summary)) s += 4
  if (hits(row.topics)) s += 3
  if (hits(row.body)) s += 1
  return s
}

export function createWikiRoutes(articles: WikiArticleDAO, opts?: { rootDir?: string }): Hono {
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

      return c.json({ org, domains, stats, log: readWikiLog(resolveWikiRoot(org, opts?.rootDir)) })
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
        gitHistory: gitHistoryFor(resolveWikiRoot(org, opts?.rootDir), row.path),
        // 票04：判例详情携带状态面（open/distilled/superseded chips + rule_ref 顺藤）；词条 null
        case: row.domain === "cases" ? caseFieldsFor(resolveWikiRoot(org, opts?.rootDir), row.path) : null,
      })
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki.article")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/wiki/search?org=&q=&topK=&domain= — FTS5 主检索 + LIKE 降级（票03）
  routes.get("/search", (c) => {
    const q = c.req.query("q")?.trim()
    if (!q) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Query parameter \"q\" is required" } }, 400)
    }
    try {
      const org = c.req.query("org") || "default"
      const topK = Math.min(Math.max(parseInt(c.req.query("topK") ?? "10", 10) || 10, 1), 50)
      const domain = c.req.query("domain") || undefined

      // FTS5 MATCH 主检索；零命中或 MATCH 抛错（坏语法/FTS 表损坏）⇒ LIKE 降级。
      let mode: "fts" | "like" = "fts"
      let hits: ReturnType<WikiArticleDAO["search"]> = []
      try {
        hits = articles.search(org, q, topK, domain)
      } catch {
        hits = []
      }
      if (hits.length === 0) {
        hits = articles.searchLike(org, q, topK, domain)
        mode = "like"
      }

      const results = hits.map(r => {
        const full = articles.get(org, r.id)
        const { snippet, anchors } = locateQueryHits(full?.body ?? "", q)
        const caseFields = r.domain === "cases" ? caseFieldsFor(resolveWikiRoot(org, opts?.rootDir), r.path) : null
        return {
          ...r,
          snippet: snippet || (full?.summary ?? ""),
          anchors,
          ruleRef: caseFields?.ruleRef ?? null,
          status: caseFields?.status ?? null,
          _score: caseWeightScore(q, full),
        }
      })
      // 判例加权：symptom/tags 命中压过正文偶然提及；同分保持检索引擎序（stable sort）
      if (results.some(r => r.domain === "cases")) {
        results.sort((a, b) => b._score - a._score)
      }
      for (const r of results) delete (r as { _score?: number })._score

      return c.json({ org, query: q, mode, results })
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki.search")
      return c.json(body, status)
    }
  })

  return routes
}
