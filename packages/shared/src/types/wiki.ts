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
