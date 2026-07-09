import type { ArchiveContext, ExistingRule } from "./context-builder"

// ── Types ────────────────────────────────────────────────────────────

export interface AnalysisReport {
  summary: string
  execution_patterns: Array<{ pattern: string; evidence: string; severity: "info" | "warning" | "critical" }>
  cost_efficiency: { assessment: "efficient" | "moderate" | "wasteful"; detail: string; optimization_suggestions: string[] }
  error_patterns: Array<{ pattern: string; root_cause_hypothesis: string; affected_workflows: string[]; fix_suggestion: string }>
  workflow_health: Array<{ name: string; grade: string; issues: string[]; improvements: string[] }>
  recommendations: Array<{ priority: "high" | "medium" | "low"; category: "cost" | "reliability" | "performance" | "process"; action: string; expected_impact: string }>
}

export interface ExperienceCandidate {
  id: string
  text: string
  scope: string
  target: string
  confidence: number
  evidence: string
  category: string
  conflicts: ConflictInfo[]
}

export interface ConflictInfo {
  existingRule: string
  type: "contradicts" | "overlaps" | "supersedes"
}

export interface SkillCandidate {
  name: string
  description: string
  content_outline: string[]
  reason: string
  evidence_workflows: string[]
  evidence_executions: number[]
  estimated_reuse: "high" | "medium" | "low"
}

export interface ArchiveStats {
  execution_count: number
  success_rate: number
  total_cost: number
  total_duration_ms: number
  avg_cost_per_execution: number
  avg_duration_ms: number
  lifespan_days: number
  workflow_count: number
}

export interface ArchivePreview {
  stats: ArchiveStats
  analysis: AnalysisReport
  experiences: ExperienceCandidate[]
  skills: SkillCandidate[]
}

// ── Main ─────────────────────────────────────────────────────────────

export function assembleAnalysis(
  ctx: ArchiveContext,
  report: AnalysisReport,
  experiences: ExperienceCandidate[],
  skills: SkillCandidate[],
): ArchivePreview {
  const stats = computeStats(ctx)
  const deduped = deduplicateExperiences(experiences)
  const withConflicts = detectConflicts(deduped, ctx.existingKnowledge)
  const ranked = rankExperiences(withConflicts)
  const rankedSkills = rankSkills(skills)

  return {
    stats,
    analysis: report,
    experiences: ranked,
    skills: rankedSkills,
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

export function computeStats(ctx: ArchiveContext): ArchiveStats {
  const { executions, workspace } = ctx

  const execution_count = executions.length
  const completed = executions.filter((e) => e.status === "completed").length
  const success_rate = execution_count > 0 ? (completed / execution_count) * 100 : 0

  const total_cost = executions.reduce((sum, e) => sum + e.cost, 0)
  const total_duration_s = executions.reduce((sum, e) => sum + e.duration_s, 0)
  const total_duration_ms = total_duration_s * 1000

  const avg_cost_per_execution = execution_count > 0 ? total_cost / execution_count : 0
  const avg_duration_ms = execution_count > 0 ? total_duration_ms / execution_count : 0

  return {
    execution_count,
    success_rate,
    total_cost,
    total_duration_ms,
    avg_cost_per_execution,
    avg_duration_ms,
    lifespan_days: workspace.lifespan_days,
    workflow_count: ctx.workflows.length,
  }
}

export function deduplicateExperiences(experiences: ExperienceCandidate[]): ExperienceCandidate[] {
  const groups = new Map<string, ExperienceCandidate>()

  for (const exp of experiences) {
    const key = normalizeText(exp.text)
    const existing = groups.get(key)

    if (!existing || exp.confidence > existing.confidence) {
      groups.set(key, exp)
    }
  }

  return Array.from(groups.values())
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

export function detectConflicts(
  experiences: ExperienceCandidate[],
  existingRules: ExistingRule[],
): ExperienceCandidate[] {
  return experiences.map((exp) => {
    const newConflicts: ConflictInfo[] = []

    for (const rule of existingRules) {
      const overlap = keywordOverlap(exp.text, rule.text)

      if (overlap > 0.6) {
        const contradicts = hasContradiction(exp.text, rule.text)
        newConflicts.push({
          existingRule: rule.id,
          type: contradicts ? "contradicts" : "overlaps",
        })
      }
    }

    // Append new conflicts to existing conflicts array (don't replace)
    return {
      ...exp,
      conflicts: [...exp.conflicts, ...newConflicts],
    }
  })
}

function keywordOverlap(a: string, b: string): number {
  const wordsA = extractKeywords(a)
  const wordsB = extractKeywords(b)

  if (wordsA.length === 0 || wordsB.length === 0) return 0

  const setA = new Set(wordsA)
  const setB = new Set(wordsB)

  let common = 0
  for (const word of setA) {
    if (setB.has(word)) common++
  }

  return common / Math.min(setA.size, setB.size)
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3)
}

function hasContradiction(a: string, b: string): boolean {
  const oppositePairs = [
    ["always", "never"],
    ["use", "avoid"],
    ["prefer", "avoid"],
    ["enable", "disable"],
    ["include", "exclude"],
    ["add", "remove"],
  ]

  const wordsA = new Set(extractKeywords(a))
  const wordsB = new Set(extractKeywords(b))

  for (const [word1, word2] of oppositePairs) {
    const has1A = wordsA.has(word1)
    const has1B = wordsB.has(word1)
    const has2A = wordsA.has(word2)
    const has2B = wordsB.has(word2)

    // One text has word1, the other has word2
    if ((has1A && has2B) || (has2A && has1B)) {
      return true
    }
  }

  return false
}

export function rankExperiences(experiences: ExperienceCandidate[]): ExperienceCandidate[] {
  return [...experiences].sort((a, b) => {
    const scoreA = a.confidence * countEvidence(a.evidence)
    const scoreB = b.confidence * countEvidence(b.evidence)
    return scoreB - scoreA
  })
}

function countEvidence(evidence: string): number {
  if (!evidence || evidence.trim() === "") return 1
  const parts = evidence.split(",").filter((s) => s.trim() !== "")
  return parts.length > 0 ? parts.length : 1
}

const REUSE_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

export function rankSkills(skills: SkillCandidate[]): SkillCandidate[] {
  return [...skills].sort((a, b) => {
    const reuseA = REUSE_ORDER[a.estimated_reuse] ?? 0
    const reuseB = REUSE_ORDER[b.estimated_reuse] ?? 0

    if (reuseB !== reuseA) return reuseB - reuseA
    return b.evidence_workflows.length - a.evidence_workflows.length
  })
}
