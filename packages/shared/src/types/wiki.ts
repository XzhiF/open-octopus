import { z } from "zod"

// LLM-WIKI knowledge-loop — 词条 (Entry) 格式 v2 表示层 schema。
// 字段与样例逐一对应 spec.md §知识表示（格式 v2）/ prototype.md Tab③，
// 供 server 编译服务与后续 ticket（lint/curate/migration）共用。

export const WikiDomainValues = ['projects', 'workflows', 'business', 'research', 'cases'] as const
export type WikiDomain = typeof WikiDomainValues[number]

export const WikiStabilityValues = ['stable', 'volatile'] as const
export type WikiStability = typeof WikiStabilityValues[number]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 词条 front-matter schema（格式 v2）:
 * id/domain/title/summary/topics/stability/last_compiled/sources/confidence。
 * 约束：stability=volatile 必带 review_after 日期（半衰期到期复审指针）。
 */
export const WikiEntryFrontmatterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id 必须是小写字母开头的 kebab-case（禁止 '/'，那是旧库存量格式）"),
  domain: z.enum(WikiDomainValues),
  title: z.string().min(1),
  summary: z.string().min(1),
  topics: z.array(z.string()).default([]),
  stability: z.enum(WikiStabilityValues),
  review_after: z.string().regex(DATE_RE, "review_after 必须是 YYYY-MM-DD").optional(),
  last_compiled: z.string().regex(DATE_RE, "last_compiled 必须是 YYYY-MM-DD 字符串"),
  sources: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
}).superRefine((v, ctx) => {
  if (v.stability === "volatile" && !v.review_after) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["review_after"],
      message: "volatile 词条必须带 review_after 日期（到期进审核队列）",
    })
  }
})

export type WikiEntryFrontmatter = z.infer<typeof WikiEntryFrontmatterSchema>

// ── 页格式 v3（知识中心票04：五类页 taxonomy 基座）─────────────────────
// prototype Tab②「页 taxonomy」+「front-matter v3 与索引层」：v3 = v2 换 taxonomy——
// `domain`→`type`（entity/concept/topic/source/case），新增 `links`（[[wikilink]]，
// 编译期断链校验保留）与 entity 的 `aliases/entity_kind`；
// stability/confidence/sources/last_compiled 保留（stability/confidence 转可选——
// 原型样例 entity 只带 confidence、topic 只带 stability）；正文零日期纪律不变。
// v2 形态（domain 字段）兼容可读（parseWikiFile 分派，为重蒸馏票07 留路）；写路径出 v3。

export const WikiPageTypeValues = ['entity', 'concept', 'topic', 'source', 'case'] as const
export type WikiPageType = typeof WikiPageTypeValues[number]

/** v3 type → 页目录（票07 页路径面；与旧 WIKI_DOMAINS 目录并存可读）。 */
export const WIKI_PAGE_DIR_BY_TYPE: Record<WikiPageType, string> = {
  entity: "entities",
  concept: "concepts",
  topic: "topics",
  source: "sources",
  case: "cases",
}

/** v2 domain → v3 type 映射（重蒸馏规则行/语义映射的形态层近似，INDEX 分组用）。 */
export const WIKI_DOMAIN_TO_PAGE_TYPE: Record<WikiDomain, WikiPageType> = {
  projects: "topic",
  workflows: "topic",
  business: "concept",
  research: "concept",
  cases: "case",
}

/**
 * links 归一：接受 `[[a]] [[b]]` 空格串（原型逐字形）、YAML 嵌套序列
 * （`[[a], [b]]` 载入即 [['a'],['b']]）、字符串数组（元素带/不带 [[ ]]）三种输入，
 * 统一产出裸目标串数组（序列化统一回 `[[a], [b]]` 嵌套式——YAML 可解析且最贴近原型 token）。
 */
export function normalizeWikiLinks(value: unknown): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const m = s.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/) ?? [null, s]
    const t = (m[1] ?? s).trim()
    if (t && !out.includes(t)) out.push(t)
  }
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\[\[([^\]]+)\]\]/g)) push(m[1].split("|")[0].split("#")[0].trim())
      if (!/\[\[/.test(v) && v.trim()) {
        for (const piece of v.split(/[,\s]+/)) if (piece) push(piece)
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(value)
  return out
}

/**
 * 页 front-matter schema（格式 v3）。判例（case）页保留 P0 判例形态
 * （symptom/tags/…，走 WikiCaseFrontmatterSchema 管线），本 schema 拒收裸 type:case 页。
 */
export const WikiPageFrontmatterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id 必须是小写字母开头的 kebab-case（禁止 '/'，那是旧库存量格式）"),
  type: z.enum(WikiPageTypeValues),
  /** entity 专有：project/service/tool/org/person 等 */
  entity_kind: z.string().min(1).optional(),
  aliases: z.array(z.string()).default([]),
  title: z.string().min(1),
  summary: z.string().min(1),
  topics: z.array(z.string()).default([]),
  links: z.preprocess(v => (v === undefined ? [] : normalizeWikiLinks(v)), z.array(z.string()).default([])),
  stability: z.enum(WikiStabilityValues).optional(),
  review_after: z.string().regex(DATE_RE, "review_after 必须是 YYYY-MM-DD").optional(),
  last_compiled: z.string().regex(DATE_RE, "last_compiled 必须是 YYYY-MM-DD 字符串"),
  sources: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  /** 票08 页退役（故事32）：ADDITIVE 可选退役态。仅 `_retired/` 页写入；缺省=在册页
   *  无此字段（不扰动既有页 front-matter / git diff）。case 域另有 status（open/
   *  distilled/superseded），与本字段互不干涉（case 走判例管线，不经页形态）。 */
  status: z.enum(["superseded"]).optional(),
}).superRefine((v, ctx) => {
  if (v.type === "case") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "判例页保留 P0 判例形态（symptom/tags/severity/source/status），请走判例管线编译",
    })
  }
  if (v.entity_kind !== undefined && v.type !== "entity") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entity_kind"],
      message: "entity_kind 只对 entity 页有意义（prototype Tab② 实体页样例）",
    })
  }
  if (v.stability === "volatile" && !v.review_after) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["review_after"],
      message: "volatile 页必须带 review_after 日期（到期复审指针）",
    })
  }
})

export type WikiPageFrontmatter = z.infer<typeof WikiPageFrontmatterSchema>

// ── 判例 (Case) 域（票04）────────────────────────────────────────────
// cases/ 是准入例外域：历史记录天然时间绑定，front-matter 与词条 (Entry) 完全不同
// ——没有 stability/confidence/半衰期三问，只要求「真实 + source 可定位」。
// 字段与正文五段逐字对应 prototype.md Tab③ lines 514-528（CBR 案例库）。

export const WikiCaseStatusValues = ['open', 'distilled', 'superseded'] as const
export type WikiCaseStatus = typeof WikiCaseStatusValues[number]

/** 案例正文五段（现场/诊断/根因/修复/教训）——顺序即 CBR 叙事序。 */
export const WIKI_CASE_SECTIONS = ['现场', '诊断', '根因', '修复', '教训'] as const

/** 案例 id 复用词条 id 语法（kebab-case，如 case-2026-003）。 */
const CASE_ID_RE = /^[a-z][a-z0-9-]*$/

export const WikiCaseFrontmatterSchema = z.object({
  id: z.string().regex(CASE_ID_RE, "id 必须是小写字母开头的 kebab-case"),
  domain: z.literal('cases').default('cases'),
  /** 检索主键：agent 卡壳时按症状命中 */
  symptom: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  severity: z.string().min(1, "severity 必填（blocker/major/minor 等，准入看真实性不看等级）"),
  /** 同类命中次数，≥2 触发蒸馏提议 */
  occurrences: z.number().int().positive().default(1),
  /** 已蒸馏出的规则指针（可空；顺藤读规则） */
  rule_ref: z.string().regex(/^[A-Za-z0-9_-]+$/, "rule_ref 是规则锚点 id（如 oct-013）").optional(),
  /** 溯源指针（task-/exec-/commit/session 等，可定位即可入档） */
  source: z.string().min(1),
  status: z.enum(WikiCaseStatusValues),
  /**
   * 流程型标记（aa-fix 项8·spec 三路之b 契约面）：蒸馏执行体 adopt→distill 的
   * LLM seam 判定（五段内容判「可复用操作流程 vs 纯事实陈述」）。可选=诚实缺席形
   * （历史蒸馏件/seam 不可用时无此位，b 路检测降级词表启发式兜底——marker 优先）。
   * P0 兼容：zod 默认 strip 未知键，旧读者无感；序列化仅在在场时写行（旧件零迁移）。
   */
  procedural: z.boolean().optional(),
})

export type WikiCaseFrontmatter = z.infer<typeof WikiCaseFrontmatterSchema>

/**
 * 判例准入闸：source 必须「可定位」——至少含一个 task-/exec-/commit/session/archive 等
 * 指针 token（spec §准入策略 D5：豁免半衰期三问，但不豁免溯源）。
 */
export const LOCATABLE_SOURCE_RE =
  /\b(?:task|exec|session|archive|chat|doc|ws)[:_\/-][\w.\/-]+|commit\s+[0-9a-f]{7,40}|\b[0-9a-f]{7,40}\b/
