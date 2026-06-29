// packages/engine/src/knowledge-injector.ts
import type { VarPool } from "@octopus/shared"

/**
 * KnowledgeInjector — reads pre-computed knowledge from VarPool
 * and returns formatted prompt strings for agent node injection.
 *
 * Works alongside PromptInjector (not replacing it).
 * Reads from VarPool keys set by the precompute hook:
 * - __user_preference_text: user preference markdown
 * - __knowledge_rule_cache: JSON map of ruleId → ruleText
 * - __relevant_rule_ids: JSON array of relevant rule IDs
 */
export class KnowledgeInjector {
  constructor(private pool: VarPool) {}

  /**
   * Get knowledge prompts to inject for a given workflow/node.
   * Returns string[] to be prepended to the agent prompt.
   */
  getInjectedPrompts(workflowName: string, nodeId: string): string[] {
    const prompts: string[] = []

    // 1. User preference (always inject if present)
    const prefText = this.pool.get("__user_preference_text") as string | undefined
    if (prefText?.trim()) {
      prompts.push(`## User Preferences\n${prefText}`)
    }

    // 2. Relevant rules from pre-computed cache
    const ruleCache = this.getRuleCache()
    const relevantIds = this.getRelevantIds()

    if (ruleCache.size > 0 && relevantIds.length > 0) {
      // Filter by knowledge_scope if node has one
      const filteredIds = this.filterByScope(relevantIds, workflowName, nodeId)

      // Get rule texts, apply budget
      const ruleTexts = this.getRuleTexts(ruleCache, filteredIds)

      if (ruleTexts.length > 0) {
        prompts.push(`## Knowledge Rules\n${ruleTexts.join("\n")}`)
      }
    }

    return prompts
  }

  private getRuleCache(): Map<string, string> {
    try {
      const raw = this.pool.get("__knowledge_rule_cache") as string | undefined
      if (!raw) return new Map()
      return new Map(Object.entries(JSON.parse(raw)))
    } catch {
      return new Map()
    }
  }

  private getRelevantIds(): string[] {
    try {
      const raw = this.pool.get("__relevant_rule_ids") as string | undefined
      if (!raw) return []
      return JSON.parse(raw) as string[]
    } catch {
      return []
    }
  }

  private filterByScope(ids: string[], workflowName: string, _nodeId: string): string[] {
    // ponytail: scope filtering reads from VarPool __knowledge_scope_filter
    // If no scope filter is set, return all IDs
    const scopeFilter = this.pool.get("__knowledge_scope_filter") as string | undefined
    if (!scopeFilter) return ids

    try {
      const filter = JSON.parse(scopeFilter) as { projects?: string[]; workflows?: string[] }
      // If workflows filter exists, only include rules for matching workflows
      if (filter.workflows?.length && !filter.workflows.includes(workflowName)) {
        return []
      }
      return ids
    } catch {
      return ids
    }
  }

  /**
   * Get rule texts with budget control.
   * Max 10 rules, max ~4000 chars total (~1000 tokens).
   */
  private getRuleTexts(cache: Map<string, string>, ids: string[]): string[] {
    const MAX_RULES = 10
    const MAX_CHARS = 4000

    const texts: string[] = []
    let totalChars = 0

    for (const id of ids.slice(0, MAX_RULES)) {
      const text = cache.get(id)
      if (!text) continue
      const entry = `- ${text}`
      if (totalChars + entry.length > MAX_CHARS) break
      texts.push(entry)
      totalChars += entry.length
    }

    return texts
  }
}
