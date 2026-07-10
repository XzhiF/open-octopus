import type { RouterDecision } from "./swarm-types"
import type { RoleRegistry, RoleDef } from "./role-registry"

export interface RouterConfig {
  maxExperts?: number
  llmCall: (prompt: string, model?: string) => Promise<string>
}

/**
 * SwarmRouter — dynamic router that uses LLM to select experts and orchestration mode.
 *
 * Two-phase selection:
 *   Phase 1: keyword pre-filter narrows all roles to ~30 candidates
 *   Phase 2: LLM selects 2-5 best experts and determines orchestration mode
 *
 * Falls back to keyword-based selection if the LLM call fails.
 */
export class SwarmRouter {
  constructor(private registry: RoleRegistry) {}

  async analyze(topic: string, config: RouterConfig): Promise<RouterDecision> {
    // Load role index
    await this.registry.loadIndex()
    const allRoles = this.registry.list()

    if (allRoles.length === 0) {
      throw new Error("No roles available. Install agency-agents-zh: `octopus setup`")
    }

    // Phase 1: keyword pre-filter to narrow candidates to 20-30
    const candidates = this.prefilter(topic, allRoles, 30)

    // Phase 2: LLM selection from candidates
    const decision = await this.llmSelect(topic, candidates, config)

    // Apply max_experts truncation
    if (config.maxExperts && decision.experts.length > config.maxExperts) {
      const originalCount = decision.experts.length
      decision.experts = decision.experts.slice(0, config.maxExperts)
      decision.alternatives_considered.push(
        `Truncated from ${originalCount} to ${config.maxExperts} experts`,
      )
    }

    return decision
  }

  private prefilter(topic: string, roles: RoleDef[], maxCandidates: number): RoleDef[] {
    const keywords = topic
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)

    // Score each role by keyword overlap
    const scored = roles.map(role => {
      const text = `${role.name} ${role.description} ${role.category}`.toLowerCase()
      const score = keywords.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0)
      return { role, score }
    })

    // Take top candidates, or all if fewer than max
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxCandidates).map(s => s.role)
  }

  private async llmSelect(
    topic: string,
    candidates: RoleDef[],
    config: RouterConfig,
  ): Promise<RouterDecision> {
    const candidateList = candidates
      .map((r, i) => `${i + 1}. ${r.name} (${r.category}): ${r.description}`)
      .join("\n")

    const prompt = `You are a router that selects the best experts for a topic.

## Topic
${topic}

## Available Experts
${candidateList}

## Instructions
1. Select 2-5 experts most relevant to this topic
2. Determine the best orchestration mode:
   - "review" — for audits, reviews, assessments
   - "debate" — for decisions, trade-offs, comparisons
   - "dispatch" — for implementation, development, coding tasks

Respond in JSON:
{
  "mode": "review" | "debate" | "dispatch",
  "mode_reasoning": "why this mode was chosen",
  "experts": [
    { "role": "exact role name", "match_reasoning": "why selected", "match_score": 0.0-1.0 }
  ],
  "alternatives_considered": ["other roles considered but not selected"]
}`

    try {
      const response = await config.llmCall(prompt, "se")
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error("No JSON in router response")

      const parsed = JSON.parse(jsonMatch[0])
      return {
        mode: parsed.mode || "debate",
        mode_reasoning: parsed.mode_reasoning || "",
        experts: (parsed.experts || []).map((e: any) => ({
          role: e.role,
          match_reasoning: e.match_reasoning || "",
          match_score: e.match_score || 0.5,
        })),
        alternatives_considered: parsed.alternatives_considered || [],
      }
    } catch (e: any) {
      // Fallback: use top candidates by score, default to debate mode
      return {
        mode: "debate",
        mode_reasoning: `Router LLM failed (${e.message}), using fallback`,
        experts: candidates.slice(0, 3).map(r => ({
          role: r.name,
          match_reasoning: "Fallback selection based on keyword matching",
          match_score: 0.3,
        })),
        alternatives_considered: [],
      }
    }
  }
}
