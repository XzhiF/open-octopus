// packages/server/src/services/agent/experience-precompute.ts
import type { EvolutionDAO } from "../../db/dao"
import type { VarPool } from "@octopus/shared"
import { ContextEnricher } from "./context-enricher"

/**
 * Pre-compute experience segment for workflow agent nodes.
 * Writes result to VarPool for AgentExecutor to read:
 *   - __experience_segment: formatted markdown with relevant historical experiences
 *
 * Uses ContextEnricher with scope='workflow', forceSearch=true (always-on).
 * The budget is set to 1000 tokens (~4000 chars) to leave room for other prompt sections.
 */
export function precomputeExperience(
  org: string,
  workflowName: string,
  dao: EvolutionDAO,
  pool: { set: (key: string, value: unknown) => void },
): void {
  try {
    const enricher = new ContextEnricher(dao)
    const result = enricher.enrichSync({
      scope: "workflow",
      query: workflowName,
      org,
      budget: 1000,
      forceSearch: true,
    })

    if (result.segment) {
      pool.set("__experience_segment", result.segment)
      console.log(`[experience-precompute] org=${org} workflow=${workflowName} count=${result.count} tokens=${result.tokensUsed}`)
    }
  } catch (err) {
    console.warn("[experience] precomputeExperience failed:", err)
  }
}
