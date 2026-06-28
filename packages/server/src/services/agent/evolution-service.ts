import { EvolutionDAO } from '../../db/dao'
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
   */
  reflect(
    org: string,
    input: {
      type: 'execution' | 'user_feedback' | 'self_check'
      skill_name?: string
      content: string
      session_id?: string
      result_summary?: string
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
    // ── Execution-based reflection (F1) ─────────────────────────
    if (input.type === 'execution') {
      // Look for repeated failure patterns in recent experiences
      const recentFailures = this.dao.findExperiencesWithFailurePattern(org)

      if (recentFailures.length > 0) {
        const target = recentFailures[0]
        return {
          identified: true,
          level: 'minor',
          candidate: {
            skill_name: target.skill_name,
            change_type: 'minor',
            summary: `Repeated failure pattern detected (${target.count} times in 7 days). Suggest adding error-handling best practices.`,
          },
          reasoning: `Skill "${target.skill_name}" had ${target.count} failure-related experiences in the past week.`,
        }
      }

      // Check if execution result suggests an improvement
      if (input.result_summary && input.skill_name) {
        const isImprovable = /可以改进|建议|better|improve|优化|优化建议/.test(input.result_summary)
        if (isImprovable) {
          return {
            identified: true,
            level: 'minor',
            candidate: {
              skill_name: input.skill_name,
              change_type: 'minor',
              summary: `Execution result suggests improvement opportunity: ${input.result_summary.slice(0, 200)}`,
            },
            reasoning: 'Execution result contains improvement indicators.',
          }
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

        return {
          identified: true,
          level,
          candidate: {
            skill_name: skillName,
            change_type: level,
            summary: `User feedback correction: ${input.content.slice(0, 200)}`,
            proposed_diff: `--- a/SKILL.md\n+++ b/SKILL.md\n@@ improvement @@\n+ ${input.content}`,
          },
          reasoning: 'User explicitly corrected Agent behavior, converted to SKILL improvement.',
        }
      }
    }

    // ── Periodic self-check (F6) ────────────────────────────────
    if (input.type === 'self_check') {
      // Analyze recent work memory for repeated patterns
      const recentExperiences = this.dao.findRecentExperiencesForReflection(org, 20)

      if (recentExperiences.length >= 5) {
        // Simple frequency analysis: find most common skill with experiences
        const skillCounts = new Map<string, number>()
        for (const exp of recentExperiences) {
          skillCounts.set(exp.skill_name, (skillCounts.get(exp.skill_name) ?? 0) + 1)
        }
        const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])

        if (sorted.length > 0 && sorted[0][1] >= 3) {
          return {
            identified: true,
            level: 'minor',
            candidate: {
              skill_name: sorted[0][0],
              change_type: 'minor',
              summary: `Self-check: ${sorted[0][1]} experiences recorded for "${sorted[0][0]}" in 7 days. Consider consolidating best practices.`,
            },
            reasoning: `Skill "${sorted[0][0]}" has the highest experience frequency (${sorted[0][1]} in 7 days).`,
          }
        }
      }
    }

    return {
      identified: false,
      level: 'minor',
      reasoning: 'No improvement patterns detected.',
    }
  }

  /**
   * P4.7: Reflect from execution archives.
   * Query execution_archive for past 7 days, detect repeating patterns
   * (same node failing >= 3 times), generate evolution suggestion,
   * and write to evolution_log table.
   */
  reflectFromArchives(org: string): {
    identified: boolean
    level: 'minor' | 'major'
    candidate?: {
      skill_name: string
      change_type: 'minor' | 'major'
      summary: string
    }
    reasoning: string
    patterns_found: number
  } {
    try {
      const db = (this.dao as any).db
      if (!db) {
        return { identified: false, level: 'minor', reasoning: 'No database access', patterns_found: 0 }
      }

      // Query execution_archive for past 7 days — find nodes that fail repeatedly
      const failingNodes = db.prepare(`
        SELECT
          json_each.value as node_info,
          ea.workflow_name,
          ea.workflow_ref
        FROM execution_archive ea,
          json_each(ea.failed_nodes)
        WHERE ea.created_at >= datetime('now', '-7 days')
          AND ea.workspace_id IN (SELECT id FROM workspaces WHERE org = ?)
      `).all(org) as Array<{ node_info: string; workflow_name: string; workflow_ref: string }>

      // Group by node_id
      const nodeFailureCounts = new Map<string, { count: number; workflows: Set<string> }>()
      for (const row of failingNodes) {
        const nodeId = typeof row.node_info === 'string' ? row.node_info : JSON.stringify(row.node_info)
        if (!nodeFailureCounts.has(nodeId)) {
          nodeFailureCounts.set(nodeId, { count: 0, workflows: new Set() })
        }
        const entry = nodeFailureCounts.get(nodeId)!
        entry.count++
        entry.workflows.add(row.workflow_name)
      }

      // Find nodes failing >= 3 times
      const repeatingFailures: Array<{ nodeId: string; count: number; workflows: string[] }> = []
      for (const [nodeId, data] of nodeFailureCounts) {
        if (data.count >= 3) {
          repeatingFailures.push({
            nodeId,
            count: data.count,
            workflows: Array.from(data.workflows),
          })
        }
      }

      if (repeatingFailures.length > 0) {
        const topFailure = repeatingFailures.sort((a, b) => b.count - a.count)[0]
        const skillName = `node-${topFailure.nodeId}`
        const summary = `Node "${topFailure.nodeId}" failed ${topFailure.count} times across workflows: ${topFailure.workflows.join(', ')}. Consider improving error handling or retry logic.`

        // Write to evolution_log
        this.dao.insertEvolution({
          skill_name: skillName,
          change_type: 'minor',
          level: 'minor',
          summary,
          org,
          timestamp: new Date().toISOString(),
        })

        return {
          identified: true,
          level: 'minor',
          candidate: {
            skill_name: skillName,
            change_type: 'minor',
            summary,
          },
          reasoning: `Found ${repeatingFailures.length} node(s) with repeated failures in the past 7 days.`,
          patterns_found: repeatingFailures.length,
        }
      }

      return {
        identified: false,
        level: 'minor',
        reasoning: 'No repeating failure patterns found in execution archives.',
        patterns_found: 0,
      }
    } catch (err) {
      console.warn("[evolution] reflectFromArchives failed:", err)
      return {
        identified: false,
        level: 'minor',
        reasoning: `Error during archive reflection: ${err instanceof Error ? err.message : String(err)}`,
        patterns_found: 0,
      }
    }
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
