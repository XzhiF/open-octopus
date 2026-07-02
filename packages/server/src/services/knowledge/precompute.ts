import { getEffectiveUserPreference, listAllActiveRules } from "./file-ops"
import type { KnowledgeScopeFilter, RuleMeta } from "@octopus/shared"

/**
 * Pre-compute relevant rules and user preferences for a workflow execution.
 * Writes results to VarPool for KnowledgeInjector to read:
 *   - __user_preference_text: merged global+org user preferences
 *   - __knowledge_rule_cache: JSON map of ruleId → ruleText
 *   - __knowledge_rule_meta: JSON map of ruleId → { fileName, scope }
 *   - __knowledge_scope_filter: { repoNames, workflowName }
 *   - __relevant_rule_ids: JSON array of relevant rule IDs
 */
export async function precomputeRelevantRules(
  org: string,
  repoNames: string[],
  workflowName: string,
  inputValues: Record<string, string>,
  pool: { set: (key: string, value: unknown) => void },
): Promise<void> {
  try {
    // 1. User preference (always inject, merged global+org)
    const userPref = getEffectiveUserPreference(org)
    if (userPref.trim()) {
      pool.set("__user_preference_text", userPref)
    }

    // 2. Scope filter — tells injector which repos/workflow are current
    const scopeFilter: KnowledgeScopeFilter = {
      repoNames,
      workflowName,
    }
    pool.set("__knowledge_scope_filter", JSON.stringify(scopeFilter))

    // 3. Knowledge rules — load all active from files, filtering happens in injector
    const activeRules = listAllActiveRules(org)
    if (activeRules.length === 0) return

    const ruleCache: Record<string, string> = {}
    const ruleMeta: Record<string, RuleMeta> = {}
    const relevantIds: string[] = []

    for (const rule of activeRules) {
      ruleCache[rule.rule_id] = rule.text
      ruleMeta[rule.rule_id] = { fileName: rule.file_name, scope: rule.scope }
      relevantIds.push(rule.rule_id)
    }

    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(relevantIds))
  } catch (err) {
    console.warn("[knowledge] precomputeRelevantRules failed:", err)
  }
}
