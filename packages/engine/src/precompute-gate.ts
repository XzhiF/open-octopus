// packages/engine/src/precompute-gate.ts
//
// Review fix #4 — precompute query-gate (spec 故事 30, 票 12 knowledge.mode).
// engine.run() used to invoke the server-injected precomputeHook
// unconditionally; under knowledge.mode=query the whole injection chain
// (incl. its precompute segment) must not run. This module is the PURE
// decision table; the call-site wiring lives in engine.ts. The precompute
// implementation and the injection chain sources/tests stay byte-unchanged
// (hard red line #1 — gating is additive at the call site only).
//
// Effective mode = the resolved identity knowledge.mode over ALL agent nodes
// (loop-nested included, same walk as the ticket-10 as: gate). Conservative
// directions by design:
//   · no agent nodes                     → run   (bash-only flows unchanged)
//   · any identity unresolvable          → run   (never silently switch tracks)
//   · any node inject/both               → run   (default path byte-identical)
//   · every agent node resolves to query → skip

import type { NodeDef, KnowledgeMode } from "@octopus/shared"
import { injectionEnabled } from "@octopus/shared"
import { DEFAULT_IDENTITY_REF } from "./executors/identity-assembly"

/** Probe the resolved knowledge.mode of an identity ref; undefined = unresolvable. */
export type IdentityModeProbe = (ref: string) => KnowledgeMode | undefined

/**
 * Collect the identity refs of every agent node (recursing into loop-style
 * containers), deduped. Nodes without `as:` probe the default identity.
 */
export function collectAgentIdentityRefs(nodes: NodeDef[] | undefined): string[] {
  const refs = new Set<string>()
  const walk = (list: NodeDef[] | undefined): void => {
    for (const n of list ?? []) {
      if (n.type === "agent") refs.add(n.as ?? DEFAULT_IDENTITY_REF)
      if (n.nodes) walk(n.nodes)
    }
  }
  walk(nodes)
  return [...refs]
}

/**
 * Pure decision: should the precompute hook run for this workflow?
 */
export function precomputeShouldRun(
  nodes: NodeDef[] | undefined,
  probe: IdentityModeProbe,
): boolean {
  const refs = collectAgentIdentityRefs(nodes)
  if (refs.length === 0) return true
  for (const ref of refs) {
    const mode = probe(ref)
    if (mode === undefined || injectionEnabled(mode)) return true
  }
  return false
}
