import type { KnowledgeRuleDAO } from "../../db/dao"

/**
 * Pre-compute relevant rules for a workflow execution.
 * Called by the engine's precomputeHook before node execution.
 * Writes results to VarPool for KnowledgeInjector to read.
 */
export async function precomputeRelevantRules(
  org: string,
  workflowName: string,
  inputValues: Record<string, string>,
  knowledgeRuleDAO: KnowledgeRuleDAO,
  pool: { set: (key: string, value: unknown) => void },
): Promise<void> {
  try {
    const activeRules = knowledgeRuleDAO.listActive()
    if (activeRules.length === 0) return

    // ponytail: simple heuristic matching — LLM-based relevance scoring deferred
    // For now, inject all active rules (budget control is in KnowledgeInjector)
    const ruleCache: Record<string, string> = {}
    const relevantIds: string[] = []

    for (const rule of activeRules) {
      ruleCache[rule.rule_id] = rule.text
      relevantIds.push(rule.rule_id)
    }

    pool.set("__knowledge_rules_cache", JSON.stringify(ruleCache))
    pool.set("__relevant_rule_ids", JSON.stringify(relevantIds))
  } catch (err) {
    console.warn("[knowledge] precomputeRelevantRules failed:", err)
  }
}
