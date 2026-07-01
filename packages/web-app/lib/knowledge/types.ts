import type { PendingItem } from '@octopus/shared'

export type {
  PendingStatus, PendingSource, PendingType, KnowledgeScope, ConflictType,
  ProposedRule, ConflictInfo, PendingItem, ProposedSkill, ParsedRule,
  KnowledgeEffectiveness
} from '@octopus/shared'

// UI-specific types
export interface KnowledgeFile {
  name: string
  type: 'project' | 'workflow'
  scope: 'global' | 'org'
  ruleCount: number
  retiredCount: number
  lineCount: number
  compactNeeded: boolean
}

export interface KnowledgeFileDetail {
  content: string
  rules: Array<{
    id: string
    text: string
    source: string
    date: string
    status: 'active' | 'retired'
  }>
  filePath: string
}

export interface ReviewListResponse {
  data: PendingItem[]
  total: number
  page: number
  pageSize: number
}

export interface ReviewActionResponse {
  ok: true
  id: string
  newStatus: string
}

export interface BatchReviewResponse {
  ok: true
  succeeded: number
  failed: number
  details: Array<{ id: string; status: 'ok' | 'error'; error?: string }>
}

export interface ArchiveSummaryResponse {
  executionId: string
  nodes: Array<{
    id: string
    status: 'completed' | 'failed' | 'skipped'
    durationMs: number
    exitCode: number | null
    lastOutput: string | null
  }>
  reviewBlockers: string[]
  e2eResults: string
  poolSnapshot: Record<string, string> | null
}

export interface ArchiveProposeResponse {
  rules: Array<{
    text: string
    scope: string
    target: string
    conflicts: Array<{ existingRule: string; conflictType: string }> | null
  }>
  skills: Array<{
    skillName: string
    category: string
    content: string
    confidence: number
  }> | null
  pendingCount: number
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestion?: string
}

export type ReviewFilter = 'all' | 'rule' | 'skill'
