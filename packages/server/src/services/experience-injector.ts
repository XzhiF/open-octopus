// packages/server/src/services/experience-injector.ts
// ExperienceInjector — Phase 4 of Execution Memory: Experience Injection.
// Queries active experiences matching a node's scope and formats them as context
// to be injected into agent prompts via PromptInjector.

import type { ExperienceDAO } from "../db/dao/experience-dao"
import type { ExperienceIndexRow } from "../db/types-archive"

const TOKEN_BUDGET = 4000
const APPROX_CHARS_PER_TOKEN = 4

export class ExperienceInjector {
  constructor(private experienceDAO: ExperienceDAO) {}

  /**
   * Query active experiences matching the scope and format as context string.
   * Returns empty string if no matches or on error.
   */
  async injectExperience(scope: {
    projects: string[]
    packages?: string[]
    types?: Array<"bug" | "pattern" | "cost" | "failure">
    limit?: number
  }, varPool?: Record<string, string>): Promise<string> {
    try {
      // 5s timeout guard — injection must not block engine execution
      const timeoutMs = 5000
      const result = await Promise.race([
        this._doInject(scope, varPool),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`injectExperience timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ])
      return result
    } catch (err) {
      console.warn('[ExperienceInjector] injection failed:', err)
      return ''
    }
  }

  private async _doInject(scope: {
    projects: string[]
    packages?: string[]
    types?: Array<"bug" | "pattern" | "cost" | "failure">
    limit?: number
  }, varPool?: Record<string, string>): Promise<string> {
    // Resolve variable references in project names
    const resolvedProjects = scope.projects.map(p => this.resolveVars(p, varPool))
    const types = scope.types ?? ["bug", "pattern", "cost", "failure"]
    const limit = scope.limit ?? 10

    const experiences = this.experienceDAO.getActiveByScope(resolvedProjects, types, limit)
    if (experiences.length === 0) return ''

    // Track use_count (fire-and-forget — don't block injection on increment)
    try {
      this.experienceDAO.incrementUseCount(experiences.map(e => e.id))
    } catch (err) {
      console.warn('[ExperienceInjector] incrementUseCount failed:', err)
    }

    // Format context with token budget
    return this.formatContext(experiences)
  }

  private resolveVars(template: string, varPool?: Record<string, string>): string {
    if (!varPool) return template
    return template.replace(/\$inputs\.(\w+)|\$vars\.(\w+)/g, (_, inputKey, varKey) => {
      return varPool[inputKey || varKey] || ''
    })
  }

  private formatContext(experiences: ExperienceIndexRow[]): string {
    const groups: Record<string, ExperienceIndexRow[]> = {
      bug: [], pattern: [], cost: [], failure: [],
    }
    for (const exp of experiences) {
      const type = exp.type as keyof typeof groups
      if (groups[type]) groups[type].push(exp)
    }

    const sections: string[] = []
    const icons: Record<string, string> = { bug: 'BUG', pattern: 'PATTERN', cost: 'COST', failure: 'FAILURE' }
    const labels: Record<string, string> = { bug: 'BUG 模式', pattern: '修复模式', cost: '成本基准', failure: '失败模式' }

    for (const [type, items] of Object.entries(groups)) {
      if (items.length === 0) continue
      const lines = items.map(item => `- **${item.title}**: ${item.content}`)
      sections.push(`### [${icons[type]}] ${labels[type]}\n${lines.join('\n')}`)
    }

    if (sections.length === 0) return ''

    // search_experience tool hint — agent can dynamically query via REST API
    const serverUrl = process.env.OCTOPUS_SERVER_URL ?? 'http://localhost:3001'
    sections.push(
      `### [TOOL] search_experience\n` +
      `需要更多历史经验时，用 Bash 调用:\n` +
      `\`\`\`bash\ncurl -s "${serverUrl}/api/archive/lessons?q=<关键词>&type=bug,pattern&limit=10"\n\`\`\`\n` +
      `参数: q(搜索词), type(bug/pattern/cost/failure), status(active/resolved), limit(条数)`
    )

    let context = `[Experience Injection] 系统注入的历史经验:\n\n${sections.join('\n\n')}`

    // Token budget truncation
    const maxChars = TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN
    if (context.length > maxChars) {
      context = context.slice(0, maxChars) + '\n...(truncated due to token budget)'
    }

    return context
  }
}
