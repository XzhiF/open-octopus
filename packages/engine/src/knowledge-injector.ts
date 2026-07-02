// packages/engine/src/knowledge-injector.ts
import type { VarPool, KnowledgeScopeFilter, RuleMeta } from "@octopus/shared"

/**
 * KnowledgeInjector — reads pre-computed knowledge from VarPool
 * and returns formatted prompt strings for agent node injection.
 *
 * Works alongside PromptInjector (not replacing it).
 * Reads from VarPool keys set by the precompute hook:
 * - __user_preference_text: user preference markdown
 * - __knowledge_rule_cache: JSON map of ruleId → ruleText
 * - __knowledge_rule_meta: JSON map of ruleId → { fileName, scope }
 * - __knowledge_scope_filter: { repoNames, workflowName }
 * - __relevant_rule_ids: JSON array of relevant rule IDs
 */
export interface InjectorConfig {
  auto_inject?: boolean
}

interface GroupedRules {
  global: string[]
  project: Map<string, string[]> // projectName → ruleIds
  workflow: Map<string, string[]> // workflowName → ruleIds
}

export class KnowledgeInjector {
  constructor(private pool: VarPool, private config?: InjectorConfig) {}

  /**
   * Get knowledge prompts to inject for a given workflow/node.
   * Returns string[] to be prepended to the agent prompt.
   * Also writes __injected_rule_ids to VarPool for effectiveness tracking.
   */
  getInjectedPrompts(workflowName: string, nodeId: string): string[] {
    const prompts: string[] = []

    // 1. User preference (always inject if present, even when auto_inject is false)
    const prefText = this.pool.get("__user_preference_text") as string | undefined
    if (prefText?.trim()) {
      prompts.push(`## User Preferences\n${prefText}`)
    }

    // Config gate: if auto_inject is false, only inject user_preference
    if (this.config?.auto_inject === false) {
      this.pool.set("__injected_rule_ids", JSON.stringify([]))
      return prompts
    }

    // 2. Relevant rules from pre-computed cache
    const ruleCache = this.getRuleCache()
    const relevantIds = this.getRelevantIds()
    const ruleMetaMap = this.getRuleMetaMap()
    const scopeFilter = this.getScopeFilter(workflowName)

    let injectedIds: string[] = []

    if (ruleCache.size > 0 && relevantIds.length > 0) {
      // Filter by scope using rule meta
      const filteredIds = this.filterByScope(relevantIds, scopeFilter, ruleMetaMap)

      // Group by scope for formatted output
      const grouped = this.groupByScope(filteredIds, ruleMetaMap)

      // Format grouped prompts with budget control
      const { sections, usedIds } = this.formatGroupedPrompts(grouped, ruleCache)

      if (sections.length > 0) {
        prompts.push(...sections)
        injectedIds = usedIds
      }
    }

    // Write injected rule IDs to VarPool for effectiveness tracking
    this.pool.set("__injected_rule_ids", JSON.stringify(injectedIds))

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

  private getRuleMetaMap(): Map<string, RuleMeta> {
    try {
      const raw = this.pool.get("__knowledge_rule_meta") as string | undefined
      if (!raw) return new Map()
      return new Map(Object.entries(JSON.parse(raw))) as Map<string, RuleMeta>
    } catch {
      return new Map()
    }
  }

  private getScopeFilter(workflowName: string): KnowledgeScopeFilter {
    try {
      const raw = this.pool.get("__knowledge_scope_filter") as string | undefined
      if (!raw) return { repoNames: [], workflowName }
      return JSON.parse(raw) as KnowledgeScopeFilter
    } catch {
      return { repoNames: [], workflowName }
    }
  }

  private filterByScope(
    ids: string[],
    scopeFilter: KnowledgeScopeFilter,
    ruleMetaMap: Map<string, RuleMeta>,
  ): string[] {
    const result: string[] = []

    for (const id of ids) {
      const meta = ruleMetaMap.get(id)
      if (!meta) continue // no meta → skip

      switch (meta.scope) {
        case "global":
          // Global rules always inject
          result.push(id)
          break
        case "project":
          // Project rules match against any repoName in the list
          if (scopeFilter.repoNames.length > 0) {
            const projectName = this.extractProjectName(meta.fileName)
            if (scopeFilter.repoNames.includes(projectName)) {
              result.push(id)
            }
          }
          break
        case "workflow":
          // Workflow rules match against workflowName
          const wfName = this.extractWorkflowName(meta.fileName)
          if (wfName === scopeFilter.workflowName) {
            result.push(id)
          }
          break
        default:
          // Unknown scope → don't inject
          break
      }
    }

    return result
  }

  private groupByScope(ids: string[], ruleMetaMap: Map<string, RuleMeta>): GroupedRules {
    const grouped: GroupedRules = {
      global: [],
      project: new Map(),
      workflow: new Map(),
    }

    for (const id of ids) {
      const meta = ruleMetaMap.get(id)
      if (!meta) continue

      switch (meta.scope) {
        case "global":
          grouped.global.push(id)
          break
        case "project": {
          const name = this.extractProjectName(meta.fileName)
          const list = grouped.project.get(name) ?? []
          list.push(id)
          grouped.project.set(name, list)
          break
        }
        case "workflow": {
          const name = this.extractWorkflowName(meta.fileName)
          const list = grouped.workflow.get(name) ?? []
          list.push(id)
          grouped.workflow.set(name, list)
          break
        }
      }
    }

    return grouped
  }

  /**
   * Format grouped rules into prompt sections with budget control.
   * Max 10 rules total, max ~4000 chars total (~1000 tokens).
   */
  private formatGroupedPrompts(
    grouped: GroupedRules,
    ruleCache: Map<string, string>,
  ): { sections: string[]; usedIds: string[] } {
    const MAX_RULES = 10
    const MAX_CHARS = 4000

    const sections: string[] = []
    const usedIds: string[] = []
    let totalChars = 0
    let totalRules = 0

    const addRule = (id: string): string | null => {
      if (totalRules >= MAX_RULES) return null
      const text = ruleCache.get(id)
      if (!text) return null
      const entry = `- ${text}`
      if (totalChars + entry.length > MAX_CHARS) return null
      totalChars += entry.length
      totalRules++
      usedIds.push(id)
      return entry
    }

    // 1. Global rules
    const globalEntries: string[] = []
    for (const id of grouped.global) {
      const entry = addRule(id)
      if (entry) globalEntries.push(entry)
    }
    if (globalEntries.length > 0) {
      sections.push(`## Knowledge Rules — Global\n${globalEntries.join("\n")}`)
    }

    // 2. Project rules (grouped by project name)
    for (const [projectName, ids] of grouped.project) {
      const entries: string[] = []
      for (const id of ids) {
        const entry = addRule(id)
        if (entry) entries.push(entry)
      }
      if (entries.length > 0) {
        sections.push(`## Knowledge Rules — Project: ${projectName}\n${entries.join("\n")}`)
      }
    }

    // 3. Workflow rules (grouped by workflow name)
    for (const [wfName, ids] of grouped.workflow) {
      const entries: string[] = []
      for (const id of ids) {
        const entry = addRule(id)
        if (entry) entries.push(entry)
      }
      if (entries.length > 0) {
        sections.push(`## Knowledge Rules — Workflow: ${wfName}\n${entries.join("\n")}`)
      }
    }

    return { sections, usedIds }
  }

  private extractProjectName(fileName: string): string {
    return fileName.replace(/^projects\//, "").replace(/\.md$/, "")
  }

  private extractWorkflowName(fileName: string): string {
    return fileName.replace(/^workflows\//, "").replace(/\.md$/, "")
  }
}
