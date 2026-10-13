// packages/engine/src/executors/identity-assembly.ts
//
// LLM-WIKI P1 ticket 10 — execution-identity assembly for workflow agent nodes
// (spec §执行身份 P1, ADR-0029 "纯引擎 + 执行身份").
//
// The engine itself stays persona-less: identity is NODE data (`as:`), resolved
// through the shared IdentityResolver (same seam octopus_agent uses) at executor
// construction time:
//   snapshot.persona → systemPrompt (merged, never replacing the claude_code
//                      preset or the host-safety block — safety rules > task
//                      brief > knowledge reference)
//   snapshot.skills  → Skill Filter whitelist (unioned with node-declared
//                      skills; empty grant = unrestricted shared discovery per
//                      ADR-0006 — skills still reach the model ONLY via SDK
//                      native discovery, never as prompt text)
//   cwd              → NOT an identity input; zero change (workspace isolation
//                      stays on AgentNodeRunner construction in the factory).
//
// Failure semantics:
//   explicit `as:` unresolvable → throw (engine-init L3 gate is the earlier
//   hard line of defense; this is the runtime backstop — no doomed execution).
//   default identity missing    → graceful no-identity passthrough (existing
//   workflows must never break because the default clone is absent).

import type { NodeDef, ResolvedVersion } from "@octopus/shared"
import { WORKFLOW_OPERATOR_CLONE_NAME } from "@octopus/shared"
import type { SystemPromptInput } from "@octopus/providers"
import { IdentityResolver } from "./identity-resolver"

/** Default execution identity for agent nodes without `as:` (ticket 09 clone). */
export const DEFAULT_IDENTITY_REF: string = WORKFLOW_OPERATOR_CLONE_NAME

export interface AgentIdentityBase {
  /** The systemPrompt the call site would use WITHOUT identity (e.g. host-safety preset). */
  systemPrompt?: SystemPromptInput
}

export interface AgentIdentityAssembly {
  /** Node to hand to AgentExecutor — identical ref when nothing changed. */
  node: NodeDef
  /** Assembled system prompt — base merged with persona, or base untouched. */
  systemPrompt?: SystemPromptInput
  /** The identity actually assembled (undefined on graceful default-missing). */
  identityRef?: string
  /** 身份快照 config（票 12: knowledge.mode 影子双轨开关的读取源，
   *  agent_versions snapshot / clone config.json 形态；undefined on graceful
   *  default-missing → resolveKnowledgeMode 落缺省 both = 现状）。 */
  snapshotConfig?: Record<string, unknown>
}

export function assembleAgentNodeIdentity(
  node: NodeDef,
  resolver: IdentityResolver,
  base?: AgentIdentityBase,
): AgentIdentityAssembly {
  const ref = node.as ?? DEFAULT_IDENTITY_REF

  let resolved: ResolvedVersion
  try {
    resolved = resolver.resolve(ref)
  } catch (err) {
    if (node.as) throw err // explicit author intent — fail fast, never silently drop identity
    return { node, systemPrompt: base?.systemPrompt } // default missing → today's behavior, untouched
  }

  const { persona, skills } = resolved.snapshot
  const assembledNode =
    skills.length > 0
      ? { ...node, skills: [...new Set([...(node.skills ?? []), ...skills])] }
      : node

  return {
    node: assembledNode,
    systemPrompt: mergePersonaIntoSystemPrompt(base?.systemPrompt, persona, ref),
    identityRef: ref,
    snapshotConfig: resolved.snapshot.config,
  }
}

function mergePersonaIntoSystemPrompt(
  base: SystemPromptInput | undefined,
  persona: string,
  ref: string,
): SystemPromptInput | undefined {
  if (!persona.trim()) return base

  const block = `## 执行身份 (Execution Identity — as: ${ref})\n\n${persona}`

  if (base === undefined) {
    // Never silently drop the claude_code preset the provider would default to.
    return { type: "preset", preset: "claude_code", append: block }
  }
  if (typeof base === "string") return `${base}\n\n${block}`
  return { ...base, append: [base.append, block].filter((s) => s && s.trim()).join("\n\n") }
}
