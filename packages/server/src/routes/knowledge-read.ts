import { Hono, type Context } from "hono"
import fs from "fs"
import path from "path"
import { WikiArticleDAO } from "../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG, resolveGlobalKnowledgeRoot } from "../services/knowledge/global-paths"
import { resolveWikiRootCompat } from "../services/knowledge/wiki/paths"
import { IngestError, listRawSources, readRawSource } from "../services/knowledge/raw"
import { spawnGit, wikiHead } from "../services/knowledge/wiki/wiki-git"
import { WIKI_DOMAIN_TO_PAGE_TYPE, WikiPageTypeValues, type WikiDomain, type WikiPageType } from "@octopus/shared"
import { errorResponse } from "../services/knowledge/validators"

/**
 * 知识中心读面最小补口 — 票11（spec §知识中心 UI「服务端 API 面」）。
 * 挂载 /api/knowledge 下（沿用 createIngestRoutes 的构造注入先例）：
 *   GET /log   — LOG.md 时间线（行数组 + op 前缀过滤），真 fs 读 wiki 根，缺失诚实降级 []。
 *   GET /raw   — raw 源列表（path/bytes/hash/origin，只读）。
 *   GET /raw/* — raw 单文件读（拒绝路径穿越）。
 *   GET /health — 健康条聚合（页数按类/raw 源数/本周 ingest/队列深度/findings/
 *                最近编译/git HEAD）。队列深度接票06 全局编译队列实值（未注入 ⇒
 *                稳定零值）；findings 在票13 就位前返回零值——契约形状先定，
 *                后续票只换值不换形。**响应中不存在「待审核」字段**（审批概念已废除，
 *                spec D6）。
 * org 参数容错保留（旧客户端仍带 ?org=），语义钉 global（票03 D6① 同律）。
 */

export interface KnowledgeReadDeps {
  articles: WikiArticleDAO
}

export interface KnowledgeReadOpts {
  /** 假知识根（测试注入 tmpdir：raw/ 与 wiki/ 都在其下）；缺省 resolveGlobalKnowledgeRoot() */
  knowledgeRoot?: string
  /** wiki 根覆盖（优先级最高）；缺省 knowledgeRoot/wiki，再缺省 resolveWikiRootCompat */
  wikiRoot?: string
  /** 假 home（测试注入，绝不碰真 ~/.octopus） */
  octopusHome?: string
  /** 时钟注入（本周 ingest 判定用） */
  now?: () => Date
  /** 票06：全局编译队列深度注入（缺省 0 = 未装配队列形态；只换值不换形，票11 契约） */
  getQueueDepth?: () => number
  /** 票13：开放 findings 注入（FindingsDAO.countOpen 单源；缺省 0 = 未装配巡检形态） */
  getOpenFindings?: () => number
  /**
   * P4 票07：健康条「全库平均 confidence」注入（口径=已测行滚动值均值，
   * 单源 effectiveness-confidence.avgMeasuredConfidence；缺省 null = 未装配账目形态
   * 的稳定零值——契约形状先定只换值不换形，queueDepth/openFindings 同律）。
   */
  getAvgConfidence?: () => number | null
  /**
   * P4 票08：健康条「health score 0-100」注入（公式单源 health-score.ts，服务侧
   * WikiPatrolService.healthScore()；缺省 null = 未装配巡检/空库诚实不可评——
   * 不伪造满分，avgConfidence 同律只换值不换形）。
   */
  getHealthScore?: () => number | null
}

/**
 * LOG.md 行格式（票04 编译服务 formatLogRow 产物）：
 *   `## [date] op | title` + 续行 `  → result`
 * 旧 v2 表格行（`| 日期 | … |`）不解析——机械转换封 git 史属票07。
 */
const LOG_LINE_RE = /^## \[(\d{4}-\d{2}-\d{2})\] ([A-Za-z0-9+_-]+) \| (.*)$/
const LOG_RESULT_RE = /^\s*→\s*(.*)$/

export interface LogLine {
  date: string
  op: string
  title: string
  result: string
}

function parseLogLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "")
    const m = LOG_LINE_RE.exec(line)
    if (m) {
      out.push({ date: m[1], op: m[2], title: m[3], result: "" })
      continue
    }
    const r = LOG_RESULT_RE.exec(line)
    if (r && out.length > 0) out[out.length - 1].result = r[1]
  }
  return out
}

/** 本周口径 = ISO 周（周一起，UTC 日期比较）——「本周 ingest」不是滚动 7 天。 */
function isoWeekStartUtc(d: Date): string {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

/**
 * wiki_articles.domain 列值 → 页数桶（v3 类型值直通；v2 域值经 shared 映射——
 * 重蒸馏票07 前混存实况，单源 = WIKI_DOMAIN_TO_PAGE_TYPE，Standards #1）。
 */
function pageBucket(domain: string): WikiPageType | null {
  if ((WikiPageTypeValues as readonly string[]).includes(domain)) return domain as WikiPageType
  return WIKI_DOMAIN_TO_PAGE_TYPE[domain as WikiDomain] ?? null
}

export function createKnowledgeReadRoutes(deps: KnowledgeReadDeps, opts?: KnowledgeReadOpts): Hono {
  const routes = new Hono()

  const wikiRootOf = (legacyOrg?: string): string => {
    if (opts?.wikiRoot) return opts.wikiRoot
    if (opts?.knowledgeRoot) return path.join(opts.knowledgeRoot, "wiki")
    return resolveWikiRootCompat(legacyOrg, undefined, opts?.octopusHome)
  }

  const knowledgeRootOf = (): string => opts?.knowledgeRoot ?? resolveGlobalKnowledgeRoot()

  // IngestError 自带 HTTP 语义（routes/ingest.ts 同律）；其余错误走 errorResponse
  const fail = (c: Context, err: unknown, context: string) => {
    if (err instanceof IngestError) {
      return c.json({ error: { code: err.code, message: err.detail } }, err.status as 400)
    }
    const { body, status } = errorResponse(err, context)
    return c.json(body, status)
  }

  // GET /api/knowledge/raw — raw 源列表（path/bytes/hash/origin，只读；票02 冻结头为真源）
  routes.get("/raw", (c) => {
    try {
      return c.json({ org: GLOBAL_WIKI_ORG, sources: listRawSources(knowledgeRootOf()) })
    } catch (err) {
      return fail(c, err, "knowledge-read.raw.list")
    }
  })

  // GET /api/knowledge/raw/{dir}/{file} — 单文件只读；穿越三重闸在 readRawSource（400），
  // 缺席 404。rel = 请求路径去掉匹配前缀（routePath 去 '*'）后的余段——挂载无关。
  // 注：明文 `..` 段在 URL 层已归一化出 /raw/ 前缀（路由 404，fs 永不可达）；
  // 编码形态（%2F/%2e%2e 解码后含 ..、异目录段、嵌套段）由三重闸如实 400。
  routes.get("/raw/*", (c) => {
    try {
      const prefix = c.req.routePath.slice(0, -1) // "/…/raw/*" → "/…/raw/"
      const rawRel = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ""
      let rel = rawRel
      try {
        rel = decodeURIComponent(rawRel)
      } catch {
        throw new IngestError("INVALID_PARAM", `undecodable path: ${rawRel}`, 400)
      }
      const source = readRawSource(knowledgeRootOf(), rel)
      return c.json({ org: GLOBAL_WIKI_ORG, ...source })
    } catch (err) {
      return fail(c, err, "knowledge-read.raw.file")
    }
  })

  // GET /api/knowledge/log?op= — LOG.md 时间线（行数组 + 前缀过滤）
  routes.get("/log", (c) => {
    try {
      const root = wikiRootOf(c.req.query("org") || undefined)
      let lines: LogLine[] = []
      try {
        lines = parseLogLines(fs.readFileSync(path.join(root, "LOG.md"), "utf-8"))
      } catch {
        lines = [] // wiki 根尚无 LOG.md（首编译前）⇒ 诚实空态
      }
      const op = c.req.query("op")
      if (op) lines = lines.filter(l => l.op === op)
      return c.json({ org: GLOBAL_WIKI_ORG, lines })
    } catch (err) {
      const { body, status } = errorResponse(err, "knowledge-read.log")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/health — 健康条聚合（票面口径：页数按类 / raw 源数 / 本周 ingest /
  // 开放 findings / 编译队列深度 / 最近编译 / git HEAD）。**响应不存在「待审核」字段**
  // （审批概念已废除，spec D6/原型 Tab④ 交互纪律）。queueDepth/openFindings 在票06/13
  // 就位前返回稳定零值——契约形状先定，后续票只换值不换形。
  routes.get("/health", (c) => {
    try {
      const now = opts?.now?.() ?? new Date()
      const rows = deps.articles.listByOrg(GLOBAL_WIKI_ORG)

      const byType: Record<WikiPageType, number> = { entity: 0, concept: 0, topic: 0, source: 0, case: 0 }
      let lastCompiled = ""
      for (const r of rows) {
        const bucket = pageBucket(r.domain)
        if (bucket) byType[bucket]++
        if (r.last_compiled > lastCompiled) lastCompiled = r.last_compiled
      }

      const sources = listRawSources(knowledgeRootOf())
      const weekStart = isoWeekStartUtc(now)
      const ingestedThisWeek = sources.filter(s => (s.ingestedAt ?? "").slice(0, 10) >= weekStart).length

      let gitHead: string | null = null
      try {
        gitHead = wikiHead(spawnGit(wikiRootOf(c.req.query("org") || undefined), 5000))
      } catch {
        gitHead = null // 非 git 仓/git 抖动 ⇒ 诚实 null（只读降级同律）
      }

      return c.json({
        org: GLOBAL_WIKI_ORG,
        pages: { total: rows.length, ...byType },
        rawSources: sources.length,
        ingestedThisWeek,
        openFindings: opts?.getOpenFindings?.() ?? 0, // 票13 巡检/编译 findings 真值（只换值不换形）
        queueDepth: opts?.getQueueDepth?.() ?? 0,   // 票06 全局编译队列实值（未装配 ⇒ 稳定零值）
        avgConfidence: opts?.getAvgConfidence?.() ?? null, // 票07 全库平均置信（已测行口径；未装配/全未测 ⇒ null 诚实）
        score: opts?.getHealthScore?.() ?? null, // 票08 health score 0-100（未装配/空库 ⇒ null 诚实不可评，不伪造满分）
        lastCompiled,
        gitHead,
      })
    } catch (err) {
      return fail(c, err, "knowledge-read.health")
    }
  })

  // GET /api/knowledge/preference — user_preference.md 只读渲染（票09 迁入读面）。
  // 审批废除与偏好编辑器彻底删除（spec 删除边界）：user_preference 零 Web 编辑入口
  // ——PUT 面随 routes/knowledge.ts 物理删除，改文件 = 人工直接编辑知识根原件
  // （D6③ 写保护继承）。**纯读零副作用**：不 mkdir、不建文件——已归档删除的
  // 旧知识目录不得被任何请求重建（S1 护栏）。org 偏好面退役：scope 钉 global。
  routes.get("/preference", (c) => {
    const scope = c.req.query("scope") ?? "global"
    if (scope !== "global") {
      return c.json(
        { error: { code: "INVALID_PARAM", message: "user_preference 读面钉 global——org 偏好面随票09 归档删除退役，改写请人工直接编辑知识根 user_preference.md" } },
        400,
      )
    }
    const filePath = path.join(knowledgeRootOf(), "user_preference.md")
    let content = ""
    try {
      if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, "utf-8")
    } catch {
      content = "" // 读取失败诚实降级为空（只读面绝不炸 500、绝不落盘）
    }
    return c.json({ content, scope, filePath })
  })

  return routes
}
