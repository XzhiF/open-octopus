// packages/engine/src/executors/experience-injector.ts
// P3: Engine-level experience injection via experience_scope in YAML node definitions.
// Uses port pattern: the engine declares what it needs (ExperienceQueryPort),
// the server provides the concrete implementation backed by ExperienceDAO.

import type { ExperienceScope } from "@octopus/shared"

/**
 * Port interface for querying experiences.
 * The server layer implements this with ExperienceDAO.findByScope().
 * The engine depends only on this interface, not on the DAO directly.
 */
export interface ExperienceQueryPort {
  findByScope(scope: {
    projects?: string[]
    packages?: string[]
    types?: string[]
    status: string
    limit: number
  }): ExperienceEntry[]
}

export interface ExperienceEntry {
  id: string
  type: string
  title: string
  content: string
  relevance_score?: number
  use_count?: number
}

/**
 * Injects relevant experiences into agent prompts based on experience_scope declarations.
 * Only returns active experiences, ordered by relevance_score DESC, use_count DESC.
 */
export class ExperienceInjector {
  constructor(private queryPort?: ExperienceQueryPort) {}

  /**
   * Build a prompt prefix from experiences matching the given scope.
   * Returns empty string if no scope or no matching experiences.
   */
  inject(scope: ExperienceScope | undefined): string {
    if (!scope || !this.queryPort) return ""

    const limit = scope.limit ?? 10
    const entries = this.queryPort.findByScope({
      projects: scope.projects,
      packages: scope.packages,
      types: scope.types,
      status: "active",
      limit,
    })

    if (entries.length === 0) return ""

    const typeIcon: Record<string, string> = {
      bug: "🐛",
      pattern: "🔧",
      cost: "💰",
      failure: "⚠️",
    }

    const lines = entries.map(e => {
      const icon = typeIcon[e.type] ?? "📝"
      return `${icon} [${e.type}] ${e.title}: ${e.content.substring(0, 200)}`
    })

    return `## 相关经验 (从历史执行中提取)\n${lines.join("\n")}\n`
  }

  /**
   * Get the IDs of injected experiences for use_count tracking.
   */
  getInjectedIds(scope: ExperienceScope | undefined): string[] {
    if (!scope || !this.queryPort) return []

    const limit = scope.limit ?? 10
    return this.queryPort.findByScope({
      projects: scope.projects,
      packages: scope.packages,
      types: scope.types,
      status: "active",
      limit,
    }).map(e => e.id)
  }
}
