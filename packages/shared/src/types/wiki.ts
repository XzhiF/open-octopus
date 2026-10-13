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
})

export type WikiCaseFrontmatter = z.infer<typeof WikiCaseFrontmatterSchema>

/**
 * 判例准入闸：source 必须「可定位」——至少含一个 task-/exec-/commit/session/archive 等
 * 指针 token（spec §准入策略 D5：豁免半衰期三问，但不豁免溯源）。
 */
export const LOCATABLE_SOURCE_RE =
  /\b(?:task|exec|session|archive|chat|doc|ws)[:_\/-][\w.\/-]+|commit\s+[0-9a-f]{7,40}|\b[0-9a-f]{7,40}\b/
