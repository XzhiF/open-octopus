// packages/engine/src/prompt-injector.ts
import type { PromptsConfig, ExperienceScope } from "@octopus/shared"
import { VarPool } from "@octopus/shared"

export class PromptInjector {
  private readonly MAX_LENGTH = 5000

  constructor(private config: PromptsConfig | undefined) {}

  /**
   * 获取注入的 prompt 列表
   * 优先级: global → targeted (精确匹配) → targeted (通配符)
   * 总长度限制: 5000 字符
   */
  getInjectedPrompts(workflowName: string, nodeId: string): string[] {
    if (!this.config) {
      return []
    }

    const prompts: string[] = []

    // 1. 添加 global prompts
    prompts.push(...(this.config.global || []))

    // 2. 添加 targeted prompts（精确匹配优先）
    const exactMatches = (this.config.targeted || []).filter(
      t => this.matchWorkflow(t.workflow, workflowName) &&
           this.matchNode(t.node, nodeId) &&
           t.node !== "*"
    )
    prompts.push(...exactMatches.map(t => t.prompt))

    // 3. 添加 targeted prompts（通配符匹配）
    const wildcardMatches = (this.config.targeted || []).filter(
      t => this.matchWorkflow(t.workflow, workflowName) && t.node === "*"
    )
    prompts.push(...wildcardMatches.map(t => t.prompt))

    // 4. 检查总长度，截断
    const totalLength = prompts.reduce((sum, p) => sum + p.length, 0)
    if (totalLength > this.MAX_LENGTH) {
      console.warn(`Injected prompts exceed ${this.MAX_LENGTH} chars (${totalLength}), truncating`)
      return this.truncatePrompts(prompts, this.MAX_LENGTH)
    }

    return prompts
  }

  private matchWorkflow(pattern: string, name: string): boolean {
    return pattern === name || pattern === "*"
  }

  private matchNode(pattern: string, nodeId: string): boolean {
    return pattern === nodeId || pattern === "*"
  }

  private truncatePrompts(prompts: string[], maxLength: number): string[] {
    const result: string[] = []
    let currentLength = 0
    for (const prompt of prompts) {
      if (currentLength + prompt.length > maxLength) {
        break
      }
      result.push(prompt)
      currentLength += prompt.length
    }
    return result
  }
}

// ── Experience Injection ─────────────────────────────────────────

/** Minimal experience entry shape returned by the query function. */
export interface ExperienceEntry {
  id: number
  type: string
  title: string
  content: string
}

/** Query function type: server layer passes ExperienceDAO.findByScope. */
export type ExperienceQueryFn = (scope: {
  projects: string[]
  packages?: string[]
  types: string[]
  limit: number
}) => ExperienceEntry[]

/** Increment use count callback: server layer passes ExperienceDAO.incrementUseCount. */
export type ExperienceIncrementFn = (ids: number[]) => void

/** Maximum total character length (~2000 tokens ≈ 8000 chars). */
const EXPERIENCE_MAX_CHARS = 8000
/** Truncation limit per individual experience entry. */
const EXPERIENCE_ENTRY_MAX_CHARS = 800

const EXPERIENCE_TYPE_HEADERS: Record<string, string> = {
  bug: "🐛 Bug Experiences:",
  pattern: "🔧 Pattern Experiences:",
  cost: "💰 Cost Experiences:",
  failure: "⚠️ Failure Experiences:",
}

/**
 * Resolve $inputs.xxx / $vars.xxx references in scope fields.
 * Returns a deep-copied scope with all variable references replaced by actual values.
 */
function resolveScopeVariables(scope: ExperienceScope, pool: VarPool): {
  projects: string[]
  packages?: string[]
  types: string[]
  limit: number
} {
  const snapshot = pool.snapshot()
  const resolve = (val: string): string => {
    return val.replace(/\$(?:inputs|vars)\.([\w.-]+)/g, (_match, key) => {
      const resolved = snapshot[key]
      return resolved !== undefined ? String(resolved) : _match
    })
  }
  return {
    projects: scope.projects.map(resolve),
    packages: scope.packages?.map(resolve),
    types: scope.types,
    limit: scope.limit ?? 10,
  }
}

/**
 * Inject relevant experiences into a node's prompt/script based on experience_scope.
 *
 * @param scope - The node's experience_scope configuration
 * @param nodeType - The node type ("agent", "bash", etc.)
 * @param pool - VarPool for resolving variable references in scope
 * @param queryFn - Callback to query matching experiences (typically ExperienceDAO.findByScope)
 * @param incrementFn - Callback to increment use counts (typically ExperienceDAO.incrementUseCount)
 * @returns Formatted text to prepend to prompt (agent) or comment block (bash), empty string otherwise
 */
export function injectExperience(
  scope: ExperienceScope | undefined,
  nodeType: string,
  pool: VarPool,
  queryFn: ExperienceQueryFn,
  incrementFn?: ExperienceIncrementFn,
): string {
  if (!scope) return ""

  // Only agent and bash nodes support experience injection
  if (nodeType !== "agent" && nodeType !== "bash") {
    if (scope) {
      console.warn(`[injectExperience] experience_scope ignored for node type "${nodeType}" — only "agent" and "bash" are supported`)
    }
    return ""
  }

  // Resolve variables in scope
  const resolved = resolveScopeVariables(scope, pool)

  // Query matching experiences
  const entries = queryFn(resolved)
  if (entries.length === 0) return ""

  // Track usage
  if (incrementFn) {
    incrementFn(entries.map(e => e.id))
  }

  // Group by type
  const grouped = new Map<string, ExperienceEntry[]>()
  for (const entry of entries) {
    const list = grouped.get(entry.type) ?? []
    list.push(entry)
    grouped.set(entry.type, list)
  }

  // Format output
  const sections: string[] = []
  let totalChars = 0

  for (const [type, items] of grouped) {
    const header = EXPERIENCE_TYPE_HEADERS[type] ?? `${type} Experiences:`
    const lines: string[] = [header]
    for (const item of items) {
      const truncated = item.content.length > EXPERIENCE_ENTRY_MAX_CHARS
        ? item.content.slice(0, EXPERIENCE_ENTRY_MAX_CHARS) + "..."
        : item.content
      lines.push(`- ${item.title}: ${truncated}`)
    }
    const sectionText = lines.join("\n")
    if (totalChars + sectionText.length > EXPERIENCE_MAX_CHARS) {
      break
    }
    sections.push(sectionText)
    totalChars += sectionText.length
  }

  const formatted = sections.join("\n\n")

  // For agent nodes: return as-is (will be prepended to prompt)
  if (nodeType === "agent") {
    return formatted
  }

  // For bash nodes: wrap as comments
  if (nodeType === "bash") {
    return formatted.split("\n").map(line => `# Experience: ${line}`).join("\n")
  }

  return ""
}
