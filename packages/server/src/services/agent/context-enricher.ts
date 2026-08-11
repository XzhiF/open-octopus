import type { EvolutionDAO } from "../../db/dao"
import type { ExperienceRowV2 } from "../../db/types"

/**
 * EnrichParams — parameters for experience enrichment.
 */
export interface EnrichParams {
  /** Scope dimension: 'agent' | 'harness' | 'workflow' */
  scope: "agent" | "harness" | "workflow"
  /** Search query (user message for agent, pattern/detector for harness, task desc for workflow) */
  query: string
  /** Organization ID */
  org: string
  /** Maximum token budget for the experience segment (default 1200) */
  budget: number
  /** Skip keyword detection and search directly (default false) */
  forceSearch?: boolean
}

/**
 * EnrichResult — result of experience enrichment.
 */
export interface EnrichResult {
  /** Formatted markdown segment, or null if no injection needed */
  segment: string | null
  /** Number of experiences included */
  count: number
  /** Estimated tokens used */
  tokensUsed: number
}

/**
 * Scope visibility rules — each scope can see its own experiences + global.
 */
const SCOPE_VISIBILITY: Record<string, string[]> = {
  agent: ["agent", "global"],
  harness: ["harness", "global"],
  workflow: ["workflow", "global"],
}

/**
 * Trigger keywords for agent scope (Chinese + English).
 * When user message contains any of these, experience search is triggered.
 */
const TRIGGER_PATTERNS = [
  // Chinese trigger words
  "之前",
  "上次",
  "历史",
  "经验",
  "怎么解决的",
  "遇到过",
  // English trigger words
  "error",
  "failed",
  "bug",
  "fix",
  "remember",
  "last time",
]

// Build a single regex from all trigger patterns (case-insensitive)
const TRIGGER_REGEX = new RegExp(TRIGGER_PATTERNS.map(p => escapeRegex(p)).join("|"), "i")

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Estimate token count for a string (rough: ~4 chars per token for mixed content).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Format a single experience as a markdown line.
 */
function formatExperience(exp: ExperienceRowV2): string {
  // Extract date from created_at
  const date = exp.created_at.slice(0, 10)

  // Parse pattern_tags to get the first tag as pattern identifier
  let patternTag = "unknown"
  try {
    const tags = JSON.parse(exp.pattern_tags || "[]")
    if (Array.isArray(tags) && tags.length > 0) {
      patternTag = tags[0]
    }
  } catch {
    // Keep default
  }

  // Parse outcome to determine success/failure
  let outcomeLabel = "pending"
  let outcomeMarker = "⏳"
  try {
    const outcome = exp.outcome ? JSON.parse(exp.outcome) : null
    if (outcome?.label === "success") {
      outcomeLabel = "成功"
      outcomeMarker = "✅"
    } else if (outcome?.label === "failed") {
      outcomeLabel = "失败"
      outcomeMarker = "❌"
    }
  } catch {
    // Keep default
  }

  // Truncate content to ~200 chars for summary
  const summary = exp.content.length > 200
    ? exp.content.slice(0, 197) + "..."
    : exp.content

  return `**[${date}] ${patternTag}**\n   决策: ${patternTag} ${outcomeMarker} ${outcomeLabel}\n   摘要: ${summary}`
}

/**
 * ContextEnricher — unified experience enrichment layer.
 *
 * Searches historical experiences based on scope, applies visibility rules,
 * manages token budget, and formats output as structured markdown.
 */
export class ContextEnricher {
  constructor(private dao: EvolutionDAO) {}

  /**
   * Enrich context with relevant historical experiences (async API).
   */
  async enrich(params: EnrichParams): Promise<EnrichResult> {
    return this.enrichSync(params)
  }

  /**
   * Synchronous enrichment — same logic as enrich() but returns directly.
   * All underlying DAO operations (better-sqlite3) are synchronous.
   */
  enrichSync(params: EnrichParams): EnrichResult {
    const { scope, query, org, budget, forceSearch = false } = params

    // Step 1: Check if search should be triggered
    if (scope === "agent" && !forceSearch) {
      if (!TRIGGER_REGEX.test(query)) {
        return { segment: null, count: 0, tokensUsed: 0 }
      }
    }

    // Step 2: Determine visible scopes
    const scopes = SCOPE_VISIBILITY[scope] ?? [scope, "global"]

    // Step 3: Search experiences (start with max 5)
    let limit = 5
    let experiences = this.dao.searchByScopes(query, scopes, limit)

    // Filter by org
    experiences = experiences.filter(e => e.org === org)

    if (experiences.length === 0) {
      return { segment: null, count: 0, tokensUsed: 0 }
    }

    // Step 4: Budget management — reduce count if over budget
    const formatAll = (exps: ExperienceRowV2[]): string => {
      const header = `## 📚 相关历史经验 (${exps.length}条)\n`
      const items = exps.map((exp, i) => `${i + 1}. ${formatExperience(exp)}`).join("\n\n")
      return header + items
    }

    let segment = formatAll(experiences)
    let tokensUsed = estimateTokens(segment)

    // Reduce count if over budget: 5 → 3 → 1
    if (tokensUsed > budget && experiences.length > 3) {
      experiences = experiences.slice(0, 3)
      segment = formatAll(experiences)
      tokensUsed = estimateTokens(segment)
    }

    if (tokensUsed > budget && experiences.length > 1) {
      experiences = experiences.slice(0, 1)
      segment = formatAll(experiences)
      tokensUsed = estimateTokens(segment)
    }

    // If still over budget with 1 item, return null (can't fit even one)
    if (tokensUsed > budget) {
      return { segment: null, count: 0, tokensUsed: 0 }
    }

    return {
      segment,
      count: experiences.length,
      tokensUsed,
    }
  }
}
