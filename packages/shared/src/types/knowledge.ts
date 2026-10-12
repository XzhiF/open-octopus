import { z } from "zod"

// === Enums ===
export const PendingStatusValues = ['pending', 'approved', 'edited', 'rejected', 'deferred'] as const
export type PendingStatus = typeof PendingStatusValues[number]

export const PendingSourceValues = [
  'workspace_archive', 'agent_conversation', 'clone_merge',
  'system', 'recurring_pitfall', 'knowledge_pattern', 'scheduler'
] as const
export type PendingSource = typeof PendingSourceValues[number]

export const PendingTypeValues = ['rule', 'skill'] as const
export type PendingType = typeof PendingTypeValues[number]

export const KnowledgeScopeValues = ['project', 'workflow', 'global'] as const
export type KnowledgeScope = typeof KnowledgeScopeValues[number]

export const ConflictTypeValues = ['contradicts', 'overlaps', 'supersedes'] as const
export type ConflictType = typeof ConflictTypeValues[number]


export const ConflictInfoSchema = z.object({
  existingRule: z.string(),
  existingFile: z.string(),
  conflictType: z.enum(ConflictTypeValues),
})

export const PendingReviewSchema = z.object({
  id: z.string(),
  type: z.enum(PendingTypeValues),
  source: z.enum(PendingSourceValues),
  sourceRef: z.string(),
  sourceLabel: z.string(),
  content: z.string(),
  targetFile: z.string(),
  scope: z.enum(KnowledgeScopeValues),
  conflicts: z.array(ConflictInfoSchema).nullable(),
  confidence: z.number().min(0).max(1),
  autoApprove: z.boolean(),
  status: z.enum(PendingStatusValues),
  createdAt: z.string(),
  reviewedAt: z.string().optional(),
  userNotes: z.string().optional(),
})

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
export type ConflictInfo = z.infer<typeof ConflictInfoSchema>
export type PendingItem = z.infer<typeof PendingReviewSchema>
export type KnowledgeEffectiveness = z.infer<typeof KnowledgeEffectivenessSchema>
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>

export interface ProposedRule {
  text: string
  scope: KnowledgeScope
  target: string
  source: PendingSource
  id?: string
}

export interface ProposedSkill {
  id: string
  skillName: string
  category: string
  source: PendingSource
  sourceRef: string
  content: string
  confidence: number
  status: PendingStatus
}

export interface ParsedRule {
  id: string
  text: string
  date: string
  source: string
}

export interface KnowledgeScopeFilter {
  repoNames: string[]
  workflowName: string
}

export interface RuleMeta {
  fileName: string
  scope: string
}

// ===== Knowledge Mode — 影子双轨开关（LLM-WIKI P1 票 12, spec §执行身份/故事 30）=====
//
// inject  = 只跑注入链，关闭查阅记录（= 现状回滚态，P1 回滚开关）
// query   = 只记录查阅，注入链不运行（P2 预演态）
// both    = 注入链原样运行 + wiki_refs 查阅记录开启（本期缺省；默认路径与
//           现状字节一致 —— 开关是纯附加条件，不改注入链本体，红线 #1）
export const KnowledgeModeValues = ['inject', 'query', 'both'] as const
export type KnowledgeMode = typeof KnowledgeModeValues[number]

export const DEFAULT_KNOWLEDGE_MODE: KnowledgeMode = 'both'

/** vars_update 里查阅记录的 VarPool 键名（票 11 指针行 token；执行者经
 *  既有 vars_update → VarPool 通道写入，随 executions.var_pool 落 JSONL/DB）。 */
export const WIKI_REFS_KEY = 'wiki_refs'

/** wiki_refs 条目内的 stale 上报前缀（消费侧反哺生产侧，单独可筛）。 */
export const STALE_REF_PREFIX = 'stale:'

function isKnowledgeMode(v: unknown): v is KnowledgeMode {
  return typeof v === 'string' && (KnowledgeModeValues as readonly string[]).includes(v)
}

/**
 * 从分身配置宽容读取 knowledge.mode。
 * 接受两种形态：CloneDef.config（`{ knowledge: { mode } }`）与克隆目录
 * config.json 全文（`{ config: { knowledge: { mode } } }`，clone-init-service
 * 写盘形态 / agent_versions snapshot.config）。缺失或非法 → 缺省 both
 * （现状不变，且永不因脏配置悄悄切轨）。
 */
export function resolveKnowledgeMode(config: unknown): KnowledgeMode {
  if (typeof config !== 'object' || config === null) return DEFAULT_KNOWLEDGE_MODE
  const cfg = config as Record<string, unknown>
  const candidates: unknown[] = []
  if (typeof cfg.knowledge === 'object' && cfg.knowledge !== null) {
    candidates.push((cfg.knowledge as Record<string, unknown>).mode)
  }
  if (typeof cfg.config === 'object' && cfg.config !== null) {
    const inner = cfg.config as Record<string, unknown>
    if (typeof inner.knowledge === 'object' && inner.knowledge !== null) {
      candidates.push((inner.knowledge as Record<string, unknown>).mode)
    }
  }
  for (const mode of candidates) {
    if (isKnowledgeMode(mode)) return mode
  }
  return DEFAULT_KNOWLEDGE_MODE
}

/** 注入链是否运行。undefined mode = 缺省 both = 运行（默认路径零变化）。 */
export function injectionEnabled(mode?: KnowledgeMode): boolean {
  return mode !== 'query'
}

/** wiki_refs 查阅记录是否写入 VarPool。undefined mode = 缺省 both = 记录。 */
export function recordingEnabled(mode?: KnowledgeMode): boolean {
  return mode !== 'inject'
}

/**
 * recording 闸：mode=inject 时从 vars_update 摘掉 wiki_refs 键
 * （其余键原样保留）。就地修改——调用方持有的是刚解析出的更新对象。
 */
export function stripWikiRefs(varsUpdate: Record<string, unknown>, mode?: KnowledgeMode): void {
  if (recordingEnabled(mode)) return
  delete varsUpdate[WIKI_REFS_KEY]
}
