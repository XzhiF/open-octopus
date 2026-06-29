import type { KnowledgeRuleDAO, KnowledgeEffectivenessDAO } from "../../db/dao"
import { getKnowledgeDir, markRuleRetired } from "./file-ops"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  id: string
  status: string
  nodes: Record<string, {
    status: string
    exitCode: number | null
    lastOutput: string | null
  }>
  poolSnapshot?: Record<string, string>
}

// ---------------------------------------------------------------------------
// P4.1 — Effectiveness tracking (zero LLM cost — pure keyword matching)
// ---------------------------------------------------------------------------

/**
 * Compute tracking results for a set of injected rule IDs.
 *
 * For each injected rule, checks whether any of its keywords appear in the
 * execution's problem text (errors + review blockers). If a significant
 * overlap (>30%) is found, the rule is considered "not helpful" because it
 * is associated with the failure.
 *
 * Returns an array of { ruleId, helpful } updates to be applied by the caller.
 */
export function computeEffectivenessUpdates(
  injectedIds: string[],
  problemText: string,
  ruleTexts: Map<string, string>,
): Array<{ ruleId: string; helpful: boolean }> {
  const problemLower = problemText.toLowerCase()

  return injectedIds.map(ruleId => {
    const ruleText = (ruleTexts.get(ruleId) ?? "").toLowerCase()
    // Extract keywords from rule text (words > 3 chars)
    const keywords = ruleText.split(/\s+/).filter(w => w.length > 3)
    // Check overlap with problem text
    const overlap = keywords.filter(kw => problemLower.includes(kw)).length
    // If significant overlap (>30%), rule is associated with the problem -> not_helpful
    const helpful = keywords.length === 0 || overlap / keywords.length < 0.3
    return { ruleId, helpful }
  })
}

/**
 * Apply effectiveness updates to the DAO.
 *
 * For each injected rule: increment the injected counter, then increment
 * either the helpful or not_helpful counter based on the tracking result.
 */
export function applyEffectivenessUpdates(
  effectivenessDAO: KnowledgeEffectivenessDAO,
  updates: Array<{ ruleId: string; helpful: boolean }>,
): void {
  for (const { ruleId, helpful } of updates) {
    effectivenessDAO.incrementInjected(ruleId)
    if (helpful) {
      effectivenessDAO.incrementHelpful(ruleId)
    } else {
      effectivenessDAO.incrementNotHelpful(ruleId)
    }
  }
}

/**
 * Track rule effectiveness after an execution.
 *
 * Reads the injected rule IDs from the pool snapshot (set by KnowledgeInjector),
 * determines whether each rule was helpful or not based on keyword overlap with
 * execution errors/review blockers, and applies the updates to the effectiveness DAO.
 *
 * Returns the number of rules tracked, or 0 if no injected rules were found.
 * The caller is responsible for passing the DAOs — this keeps the function pure.
 */
export function trackEffectiveness(
  execResult: ExecResult,
  effectivenessDAO: KnowledgeEffectivenessDAO,
  knowledgeRuleDAO: KnowledgeRuleDAO,
): number {
  // Read injected rule IDs from execution (set by KnowledgeInjector)
  const injectedIdsRaw = execResult.poolSnapshot?.__injected_rule_ids
  if (!injectedIdsRaw) return 0

  let injectedIds: string[]
  try {
    injectedIds = JSON.parse(injectedIdsRaw)
  } catch {
    return 0
  }
  if (injectedIds.length === 0) return 0

  // Build problem text from failed nodes + review blockers
  const errorText = Object.values(execResult.nodes)
    .filter(n => n.exitCode !== null && n.exitCode !== 0)
    .map(n => n.lastOutput ?? "")
    .join(" ")

  const reviewBlockers = execResult.poolSnapshot?.review_blockers ?? ""
  const problemText = errorText + " " + reviewBlockers

  // Build a map of ruleId -> rule text for keyword matching
  const ruleTexts = new Map<string, string>()
  for (const ruleId of injectedIds) {
    const rule = knowledgeRuleDAO.getById(ruleId)
    if (rule) {
      ruleTexts.set(ruleId, rule.text)
    }
  }

  // Compute and apply updates
  const updates = computeEffectivenessUpdates(injectedIds, problemText, ruleTexts)
  applyEffectivenessUpdates(effectivenessDAO, updates)

  return updates.length
}

// ---------------------------------------------------------------------------
// P4.2 — Decay / retirement
// ---------------------------------------------------------------------------

/**
 * Retire stale rules: injected >= minInjected times, confidence < maxConfidence,
 * and not injected in the last `daysSinceLastInjected` days.
 *
 * Returns the number of rules retired.
 */
export function retireStaleRules(
  effectivenessDAO: KnowledgeEffectivenessDAO,
  knowledgeRuleDAO: KnowledgeRuleDAO,
  minInjected = 3,
  maxConfidence = 0.2,
  daysSinceLastInjected = 30,
  org?: string,
): number {
  const staleRules = effectivenessDAO.listStale(minInjected, maxConfidence, daysSinceLastInjected)
  let retiredCount = 0

  for (const row of staleRules) {
    knowledgeRuleDAO.updateStatus(row.rule_id, "retired")
    // Also mark as retired in knowledge file
    if (org) {
      const rule = knowledgeRuleDAO.getById(row.rule_id)
      if (rule) {
        const knowledgeDir = getKnowledgeDir(org)
        const filePath = path.join(knowledgeDir, rule.file_name)
        markRuleRetired(filePath, row.rule_id)
      }
    }
    retiredCount++
  }

  return retiredCount
}

/**
 * Restore a retired rule to active status.
 */
export function restoreRule(
  ruleId: string,
  knowledgeRuleDAO: KnowledgeRuleDAO,
): { ok: true; ruleId: string } {
  const rule = knowledgeRuleDAO.getById(ruleId)
  if (!rule || rule.status !== "retired") {
    throw new Error("NOT_FOUND")
  }
  knowledgeRuleDAO.updateStatus(ruleId, "active")
  return { ok: true, ruleId }
}
