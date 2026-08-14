import { EvolutionDAO } from '../../db/dao'
import { getAgentSkillsDir, backupFile } from '../../services/agent/paths'
import fs from 'fs'
import path from 'path'
import type { ExperienceRow } from '../../db/types'

// ── Types ──────────────────────────────────────────────────────

export interface EvolutionEntry {
  id: number
  skill_name: string
  change_type: 'minor' | 'major' | 'rollback' | 'revert_builtin'
  level: string
  summary: string
  diff_path: string | null
  rolled_back: boolean
  org: string
  timestamp: string
}

// ── classifyLevel ───────────────────────────────────────────

/**
 * Hard safety keywords that FORCE major classification.
 * Per PRD F7: any change touching safety-related content is always major,
 * regardless of Agent's own judgement.
 */
const HARD_SAFETY_KEYWORDS = [
  '安全', '权限', '确认', '拦截', 'workspace 边界', 'workspace边界',
  '黑名单', '只读', '拒绝', '禁止', '不允许', '必须',
  'safety', 'permission', 'confirm', 'intercept', 'boundary',
  'blacklist', 'readonly', 'deny', 'forbid', 'must',
]

/**
 * Classify the level of a skill evolution change.
 * Priority order (PRD F7):
 *   1. Hard safety keywords → always major (non-downgradable)
 *   2. Structural changes (new/delete SKILL, confirm flow) → major
 *   3. Step wording / best-practice additions → minor
 */
export function classifyLevel(change: {
  change_type: string
  summary?: string
  diff_content?: string
  diff_length?: number
}): 'minor' | 'major' {
  // Rollbacks and reverts are always major
  if (change.change_type === 'rollback' || change.change_type === 'revert_builtin') {
    return 'major'
  }

  // Explicitly typed as major
  if (change.change_type === 'major') {
    return 'major'
  }

  // ── Priority 1: Hard safety keyword detection ─────────────────
  const allText = `${change.summary ?? ''} ${change.diff_content ?? ''}`.toLowerCase()
  for (const keyword of HARD_SAFETY_KEYWORDS) {
    if (allText.includes(keyword.toLowerCase())) {
      return 'major'
    }
  }

  // ── Priority 2: Structural change indicators ──────────────────
  if (change.summary) {
    const majorKeywords = [
      'breaking', '重构', 'refactor', '重写', 'rewrite',
      '新增功能', 'new feature', '新增 SKILL', 'new skill',
      '删除', 'remove', '淘汰', 'deprecate',
      '架构', 'architecture', '不兼容', 'incompatible',
      '确认流程', 'confirm flow', 'approval',
    ]
    const lowerSummary = change.summary.toLowerCase()
    for (const keyword of majorKeywords) {
      if (lowerSummary.includes(keyword)) {
        return 'major'
      }
    }
  }

  // Large diffs suggest major changes
  if (change.diff_length && change.diff_length > 5000) {
    return 'major'
  }

  return 'minor'
}

// ── EvolutionService ─────────────────────────────────────────

export class EvolutionService {
  constructor(private dao: EvolutionDAO) {}

  /**
   * List evolution changelog entries.
   */
  listChangelog(
    org: string,
    query?: { skill_name?: string; limit?: number },
  ): EvolutionEntry[] {
    const rows = this.dao.listChangelog(org, query)

    return rows.map((r) => ({
      id: r.id,
      skill_name: r.skill_name,
      change_type: r.change_type as EvolutionEntry['change_type'],
      level: r.level,
      summary: r.summary,
      diff_path: r.diff_path,
      rolled_back: r.rolled_back === 1,
      org: r.org,
      timestamp: r.timestamp,
    }))
  }

  /**
   * Record a new evolution entry.
   */
  recordEvolution(
    org: string,
    entry: {
      skill_name: string
      change_type: EvolutionEntry['change_type']
      level: string
      summary: string
      diff_path?: string
    },
  ): EvolutionEntry {
    const timestamp = new Date().toISOString()

    const result = this.dao.insertEvolution({
      skill_name: entry.skill_name,
      change_type: entry.change_type,
      level: entry.level,
      summary: entry.summary,
      diff_path: entry.diff_path ?? null,
      org,
      timestamp,
    })

    return {
      id: result.lastInsertRowid as number,
      skill_name: entry.skill_name,
      change_type: entry.change_type,
      level: entry.level,
      summary: entry.summary,
      diff_path: entry.diff_path ?? null,
      rolled_back: false,
      org,
      timestamp,
    }
  }

  /**
   * Rollback an evolution entry.
   */
  rollback(org: string, id: number): boolean {
    const timestamp = new Date().toISOString()

    // Check if entry exists
    const entry = this.dao.findEvolutionByIdAndOrg(id, org)
    if (!entry) return false

    // Mark as rolled back
    this.dao.markRolledBack(id)

    // Create rollback entry
    this.dao.insertEvolution({
      skill_name: entry.skill_name,
      change_type: 'rollback',
      level: entry.change_type,
      summary: `Rollback of evolution entry #${id}`,
      org,
      timestamp,
    })

    return true
  }

  /**
   * Reflect on execution results and identify improvement patterns.
   * Maps to PRD F1 (execution-based reflection) and F5 (user feedback).
   *
   * Analyzes execution results to find repeated patterns, failures, or
   * user corrections that suggest SKILL improvements.
   *
   * When scope is provided (e.g. 'harness'), filters experiences by scope
   * and uses scope-specific analysis (e.g. getSuccessStats for decision rates).
   * Identified insights are written as experience rows with source_type='reflection'
   * so they become searchable via FTS5.
   */
  reflect(
    org: string,
    input: {
      type: 'execution' | 'user_feedback' | 'self_check'
      skill_name?: string
      content: string
      session_id?: string
      result_summary?: string
      scope?: string
    },
  ): {
    identified: boolean
    level: 'minor' | 'major'
    candidate?: {
      skill_name: string
      change_type: 'minor' | 'major'
      summary: string
      proposed_diff?: string
    }
    reasoning: string
  } {
    const scope = input.scope

    // ── Execution-based reflection (F1) ─────────────────────────
    if (input.type === 'execution') {
      // Look for repeated failure patterns in recent experiences
      const recentFailures = scope
        ? this.dao.findExperiencesWithFailurePatternByScope(org, scope)
        : this.dao.findExperiencesWithFailurePattern(org)

      if (recentFailures.length > 0) {
        const target = recentFailures[0]
        const result = {
          identified: true as const,
          level: 'minor' as const,
          candidate: {
            skill_name: target.skill_name,
            change_type: 'minor' as const,
            summary: `Repeated failure pattern detected (${target.count} times in 7 days). Suggest adding error-handling best practices.`,
          },
          reasoning: scope
            ? `Scope "${scope}": skill "${target.skill_name}" had ${target.count} failure-related experiences in the past week.`
            : `Skill "${target.skill_name}" had ${target.count} failure-related experiences in the past week.`,
        }
        this.writeReflectionExperience(org, scope, result)
        return result
      }

      // Check if execution result suggests an improvement
      if (input.result_summary && input.skill_name) {
        const isImprovable = /可以改进|建议|better|improve|优化|优化建议/.test(input.result_summary)
        if (isImprovable) {
          const result = {
            identified: true as const,
            level: 'minor' as const,
            candidate: {
              skill_name: input.skill_name,
              change_type: 'minor' as const,
              summary: `Execution result suggests improvement opportunity: ${input.result_summary.slice(0, 200)}`,
            },
            reasoning: scope
              ? `Scope "${scope}": execution result contains improvement indicators.`
              : 'Execution result contains improvement indicators.',
          }
          this.writeReflectionExperience(org, scope, result)
          return result
        }
      }
    }

    // ── User feedback reflection (F5) ───────────────────────────
    if (input.type === 'user_feedback') {
      // Detect correction patterns in user messages
      const correctionPatterns = [
        /不要这样|以后别|别再|不要再|stop doing|don't do/,
        /应该先|先检查|先确认|always check|make sure to/,
        /以后.*先|今后.*先|from now on/,
      ]

      const isCorrection = correctionPatterns.some((p) => p.test(input.content))
      if (isCorrection) {
        const skillName = input.skill_name ?? 'octo-agent-orchestrator'
        const level = classifyLevel({
          change_type: 'minor',
          summary: input.content,
          diff_content: input.content,
        })

        const result = {
          identified: true as const,
          level,
          candidate: {
            skill_name: skillName,
            change_type: level,
            summary: `User feedback correction: ${input.content.slice(0, 200)}`,
            proposed_diff: `--- a/SKILL.md\n+++ b/SKILL.md\n@@ improvement @@\n+ ${input.content}`,
          },
          reasoning: 'User explicitly corrected Agent behavior, converted to SKILL improvement.',
        }
        this.writeReflectionExperience(org, scope, result)
        return result
      }
    }

    // ── Periodic self-check (F6) ────────────────────────────────
    if (input.type === 'self_check') {
      if (scope) {
        // Scope-aware self-check: use listByScope and getSuccessStats
        const result = this.reflectWithScope(org, scope)
        if (result) return result
      } else {
        // Original path: analyze recent work memory for repeated patterns
        const recentExperiences = this.dao.findRecentExperiencesForReflection(org, 20)

        if (recentExperiences.length >= 5) {
          // Simple frequency analysis: find most common skill with experiences
          const skillCounts = new Map<string, number>()
          for (const exp of recentExperiences) {
            skillCounts.set(exp.skill_name, (skillCounts.get(exp.skill_name) ?? 0) + 1)
          }
          const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])

          if (sorted.length > 0 && sorted[0][1] >= 3) {
            const result = {
              identified: true as const,
              level: 'minor' as const,
              candidate: {
                skill_name: sorted[0][0],
                change_type: 'minor' as const,
                summary: `Self-check: ${sorted[0][1]} experiences recorded for "${sorted[0][0]}" in 7 days. Consider consolidating best practices.`,
              },
              reasoning: `Skill "${sorted[0][0]}" has the highest experience frequency (${sorted[0][1]} in 7 days).`,
            }
            this.writeReflectionExperience(org, scope, result)
            return result
          }
        }
      }
    }

    return {
      identified: false,
      level: 'minor',
      reasoning: scope ? `Scope "${scope}": no improvement patterns detected.` : 'No improvement patterns detected.',
    }
  }

  /**
   * Scope-aware reflection for harness-like scopes.
   * Analyzes decision success rates, detector accuracy, and pattern frequency.
   * Returns a reflection result if insights are found, null otherwise.
   */
  private reflectWithScope(
    org: string,
    scope: string,
  ): {
    identified: boolean
    level: 'minor' | 'major'
    candidate?: {
      skill_name: string
      change_type: 'minor' | 'major'
      summary: string
    }
    reasoning: string
  } | null {
    // Get scope-specific experiences
    const recentExperiences = this.dao.findRecentExperiencesForReflectionByScope(org, scope, 20)

    if (recentExperiences.length < 3) {
      return null
    }

    // Get success stats for this scope
    const stats = this.dao.getSuccessStats(org, scope)

    // Analyze: find decisions with low success rates (potential insights)
    const lowSuccessDecisions: Array<{ decision: string; rate: number; total: number }> = []
    const highSuccessDecisions: Array<{ decision: string; rate: number; total: number }> = []

    for (const [decision, stat] of Object.entries(stats.decisionStats)) {
      const resolved = stat.success + stat.failed
      if (resolved < 2) continue // Skip decisions with too few data points
      if (stat.rate < 0.5) {
        lowSuccessDecisions.push({ decision, rate: stat.rate, total: resolved })
      } else if (stat.rate >= 0.8) {
        highSuccessDecisions.push({ decision, rate: stat.rate, total: resolved })
      }
    }

    // Analyze: find most common detector (scope_ref) patterns
    const detectorCounts = new Map<string, number>()
    for (const exp of recentExperiences) {
      if (exp.scope_ref) {
        detectorCounts.set(exp.scope_ref, (detectorCounts.get(exp.scope_ref) ?? 0) + 1)
      }
    }
    const topDetector = [...detectorCounts.entries()].sort((a, b) => b[1] - a[1])[0]

    // Generate insight: low success rate decisions with alternative recommendations
    if (lowSuccessDecisions.length > 0 && highSuccessDecisions.length > 0) {
      const low = lowSuccessDecisions[0]
      const high = highSuccessDecisions[0]
      const lowPct = Math.round(low.rate * 100)
      const highPct = Math.round(high.rate * 100)
      const insightText = `${low.decision} 成功率仅 ${lowPct}% (${low.total} 次)，建议优先使用 ${high.decision}（成功率 ${highPct}%）`

      const result = {
        identified: true as const,
        level: 'minor' as const,
        candidate: {
          skill_name: topDetector ? `harness-${topDetector[0]}` : `harness-${scope}`,
          change_type: 'minor' as const,
          summary: `Scope "${scope}" reflection: ${insightText}`,
        },
        reasoning: `Scope "${scope}": analyzed ${recentExperiences.length} experiences. ${low.decision} has ${lowPct}% success rate vs ${high.decision} at ${highPct}%.`,
      }
      this.writeReflectionExperience(org, scope, result, low, high)
      return result
    }

    // Generate insight: low success rate decision with no alternative found
    if (lowSuccessDecisions.length > 0) {
      const low = lowSuccessDecisions[0]
      const lowPct = Math.round(low.rate * 100)
      const insightText = `${low.decision} 成功率仅 ${lowPct}% (${low.total} 次)，建议分析失败原因并考虑替代策略`

      const result = {
        identified: true as const,
        level: 'minor' as const,
        candidate: {
          skill_name: topDetector ? `harness-${topDetector[0]}` : `harness-${scope}`,
          change_type: 'minor' as const,
          summary: `Scope "${scope}" reflection: ${insightText}`,
        },
        reasoning: `Scope "${scope}": analyzed ${recentExperiences.length} experiences. ${low.decision} has low success rate at ${lowPct}%.`,
      }
      this.writeReflectionExperience(org, scope, result, low)
      return result
    }

    // Generate insight: frequency-based (similar to original self_check)
    if (recentExperiences.length >= 5) {
      const skillCounts = new Map<string, number>()
      for (const exp of recentExperiences) {
        skillCounts.set(exp.skill_name, (skillCounts.get(exp.skill_name) ?? 0) + 1)
      }
      const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])

      if (sorted.length > 0 && sorted[0][1] >= 3) {
        const result = {
          identified: true as const,
          level: 'minor' as const,
          candidate: {
            skill_name: sorted[0][0],
            change_type: 'minor' as const,
            summary: `Self-check (${scope}): ${sorted[0][1]} experiences recorded for "${sorted[0][0]}" in 7 days. Consider consolidating best practices.`,
          },
          reasoning: `Scope "${scope}": skill "${sorted[0][0]}" has the highest experience frequency (${sorted[0][1]} in 7 days).`,
        }
        this.writeReflectionExperience(org, scope, result)
        return result
      }
    }

    return null
  }

  /**
   * Write a reflection insight as an experience row with source_type='reflection'.
   * This makes the insight searchable via FTS5 for future interventions.
   *
   * @param org - organization
   * @param scope - scope (e.g. 'harness') or undefined for agent scope
   * @param result - the reflection result containing the insight
   * @param lowSuccess - optional low success decision info for pattern tags
   * @param highSuccess - optional high success decision info for pattern tags
   */
  private writeReflectionExperience(
    org: string,
    scope: string | undefined,
    result: {
      identified: boolean
      candidate?: { skill_name: string; summary: string }
      reasoning: string
    },
    lowSuccess?: { decision: string; rate: number },
    highSuccess?: { decision: string; rate: number },
  ): void {
    if (!result.identified || !result.candidate) return

    const effectiveScope = scope ?? 'agent'
    const timestamp = new Date().toISOString()

    // Build pattern tags for the reflection experience
    const tags: string[] = ['reflection']
    if (lowSuccess) {
      tags.push('low_success_rate', lowSuccess.decision)
    }
    if (highSuccess) {
      tags.push('high_success_rate', highSuccess.decision)
    }

    // Build content: the insight text that future interventions can retrieve
    const content = [
      result.candidate.summary,
      result.reasoning,
    ].join('\n')

    try {
      this.dao.insertExperienceV2({
        skill_name: result.candidate.skill_name,
        content,
        source_session_id: null,
        org,
        created_at: timestamp,
        scope: effectiveScope,
        scope_ref: lowSuccess?.decision ?? null,
        pattern_tags: JSON.stringify(tags),
        outcome: null,
        source_type: 'reflection',
        execution_id: null,
        node_id: null,
      })
    } catch {
      // Reflection write failure is non-fatal — don't break the reflect() return
    }
  }

  /**
   * Record an insight mark for a skill (I4 encapsulation — replaces direct DAO access).
   */
  markInsight(
    skillName: string,
    insight: string,
    sessionId: string,
    org: string,
  ): { id: number } {
    const result = this.dao.insertMark({
      skill_name: skillName,
      insight,
      session_id: sessionId,
      org,
    })
    return { id: result.lastInsertRowid as number }
  }

  /**
   * Record an experience for a skill (I4 file-level reuse).
   */
  recordExperience(
    org: string,
    entry: { skill_name: string; content: string; session_id?: string },
  ): { id: number } {
    const timestamp = new Date().toISOString()

    const result = this.dao.insertExperienceWithFts({
      skill_name: entry.skill_name,
      content: entry.content,
      source_session_id: entry.session_id ?? null,
      org,
      created_at: timestamp,
    })

    return { id: result.lastInsertRowid as number }
  }

  /**
   * Search experiences using FTS5 with scope filtering.
   * Delegates to EvolutionDAO.searchByScope().
   */
  searchExperiences(
    query: string,
    scope?: string,
    limit: number = 10,
  ): Array<{
    id: number; skill_name: string; content: string; scope: string;
    scope_ref: string | null; pattern_tags: string; outcome: string | null
  }> {
    return this.dao.searchByScope(query, scope, limit)
  }

  /**
   * List experiences for a skill.
   */
  listExperiences(org: string, skillName?: string): Array<{
    id: number
    skill_name: string
    content: string
    source_session_id: string | null
    org: string
    created_at: string
  }> {
    return this.dao.listExperiences(org, skillName)
  }

  /**
   * Process unprocessed insight marks — reflect on each, optionally evolve skills.
   * Called automatically at session end (P4 auto-trigger).
   */
  processUnprocessedMarks(
    org: string,
    sessionId?: string,
  ): { processed: number; total: number; results: Array<{ skill_name: string; identified: boolean; level: string; mark_id: number }> } {
    const marks = this.dao.listUnprocessedMarks(org, 50)
    if (marks.length === 0) {
      return { processed: 0, total: 0, results: [] }
    }

    const results: Array<{ skill_name: string; identified: boolean; level: string; mark_id: number }> = []

    for (const mark of marks) {
      try {
        const reflection = this.reflect(org, {
          type: 'user_feedback',
          skill_name: mark.skill_name,
          content: mark.insight,
          session_id: sessionId ?? mark.session_id ?? undefined,
        })

        if (reflection.identified && reflection.candidate) {
          this.recordExperience(org, {
            skill_name: mark.skill_name,
            content: `Insight: ${mark.insight}`,
            session_id: sessionId ?? mark.session_id ?? undefined,
          })

          if (reflection.level === 'minor') {
            const skillPath = path.join(getAgentSkillsDir(), mark.skill_name, 'SKILL.md')
            if (fs.existsSync(skillPath)) {
              backupFile(skillPath)
              const current = fs.readFileSync(skillPath, 'utf-8')
              fs.writeFileSync(
                skillPath,
                current + `\n\n> Insight (${new Date().toISOString().split('T')[0]}): ${mark.insight.slice(0, 200)}`,
                'utf-8',
              )
            }
            this.recordEvolution(org, {
              skill_name: mark.skill_name,
              change_type: 'minor',
              level: 'minor',
              summary: `Batch insight: ${mark.insight.slice(0, 200)}`,
            })
          }
        }

        results.push({
          skill_name: mark.skill_name,
          identified: reflection.identified,
          level: reflection.level,
          mark_id: mark.id,
        })

        this.dao.markProcessed(mark.id)
      } catch {
        // Individual mark failure is non-fatal — continue processing
        results.push({
          skill_name: mark.skill_name,
          identified: false,
          level: 'minor',
          mark_id: mark.id,
        })
      }
    }

    return { processed: results.filter(r => r.identified).length, total: marks.length, results }
  }
}

// Singleton
let evolutionServiceInstance: EvolutionService | null = null

export function initEvolutionService(dao: EvolutionDAO): EvolutionService {
  evolutionServiceInstance = new EvolutionService(dao)
  return evolutionServiceInstance
}

export function getEvolutionService(): EvolutionService {
  if (!evolutionServiceInstance) {
    throw new Error('EvolutionService not initialized. Call initEvolutionService() first.')
  }
  return evolutionServiceInstance
}
