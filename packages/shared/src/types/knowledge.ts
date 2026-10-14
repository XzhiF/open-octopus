import { z } from "zod"

// 票08 清理账（spec 故事28）：pending_review 审批族类型（PendingStatus/PendingSource/
// PendingType/KnowledgeScope/ConflictType/ConflictInfoSchema/PendingReviewSchema/
// ProposedRule/ProposedSkill）随表物理 drop + 生产者 extract.ts 下线一并删除——skill 草案
// 走卡片通道后零消费者，红线3「审批不复活」。KnowledgeConfigSchema（agent 设置）、
// KnowledgeEffectivenessSchema（P4 预留面）、ParsedRule（file-ops 运行时护栏）保留。

export const KnowledgeEffectivenessSchema = z.object({
  ruleId: z.string(),
  injectedCount: z.number().int(),
  helpfulCount: z.number().int(),
  notHelpfulCount: z.number().int(),
  lastInjected: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})

export const KnowledgeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  auto_extract: z.boolean().default(true),
  auto_inject: z.boolean().default(true),
  review_strategy: z.enum(['auto', 'background', 'inline', 'auto_approve']).default('auto'),
  compact_threshold: z.number().default(100),
})

// === TS Interfaces ===
export type KnowledgeEffectiveness = z.infer<typeof KnowledgeEffectivenessSchema>
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>

export interface ParsedRule {
  id: string
  text: string
  date: string
  source: string
}

// ===== 查阅记录信道（知识中心票 08：knowledge.mode 三态与注入链配套类型已随
// 物理删除退役；以下两常量仍被 vars_update→VarPool 查阅信道与 shadow-compare 消费）=====

/** vars_update 里查阅记录的 VarPool 键名（票 11 指针行 token；执行者经
 *  既有 vars_update → VarPool 通道写入，随 executions.var_pool 落 JSONL/DB）。 */
export const WIKI_REFS_KEY = 'wiki_refs'

/** wiki_refs 条目内的 stale 上报前缀（消费侧反哺生产侧，单独可筛）。 */
export const STALE_REF_PREFIX = 'stale:'
