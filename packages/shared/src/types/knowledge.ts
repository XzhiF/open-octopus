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

// === Zod Schemas ===
export const KnowledgeRuleSchema = z.object({
  ruleId: z.string(),
  fileName: z.string(),
  text: z.string(),
  scope: z.enum(KnowledgeScopeValues),
  source: z.enum(PendingSourceValues),
  createdAt: z.string(),
  status: z.enum(['active', 'retired']),
})

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
export type KnowledgeRule = z.infer<typeof KnowledgeRuleSchema>
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
  repoName?: string
  workflowName: string
}

export interface RuleMeta {
  fileName: string
  scope: string
}
