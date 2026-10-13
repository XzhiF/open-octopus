// packages/engine/src/identity-gate.ts
//
// LLM-WIKI P1 ticket 10 — L3 semantic gate for the `as:` execution-identity
// field (spec §执行身份, ADR-0029). An explicit `as:` whose target cannot be
// resolved through the shared IdentityResolver chain (published snapshot →
// built-in/clones directories) is rejected BEFORE execution — engine-init on
// the server path, pre-run check on the CLI path (dual-entry parity) —
// mirroring the `requires.clones` existence hard gate (engine-init Step 0):
// no doomed execution.
//
// Nodes without `as:` are NOT scanned: the default workflow-operator identity
// assembles gracefully-or-not at runtime (existing flows never break here).
// sub_workflow references resolved at runtime are covered by the runtime
// backstop (assembleAgentNodeIdentity throws for explicit as:), not by this gate.

import type { NodeDef } from "@octopus/shared"
import type { IdentityResolver } from "./executors/identity-resolver"
import { parseIdentityRef } from "./executors/identity-resolver"

export interface AsRefSite {
  /** The clone code written in the YAML `as:` field. */
  ref: string
  /** Node that carries it. */
  nodeId: string
}

/** Collect every explicit `as:` target from agent nodes, recursing into
 *  loop-nested nodes (same inheritance scope as runtime assembly). */
export function collectAsRefs(nodes: NodeDef[] | undefined): AsRefSite[] {
  const sites: AsRefSite[] = []
  const walk = (list: NodeDef[] | undefined): void => {
    for (const n of list ?? []) {
      if (n.type === "agent" && n.as) sites.push({ ref: n.as, nodeId: n.id })
      if (n.nodes) walk(n.nodes)
    }
  }
  walk(nodes)
  return sites
}

/**
 * Resolve-check every collected `as:` target; return one readable error per
 * unresolvable site (empty array = gate passes). A pinned ref (story 25,
 * "name@version") is reported with the full ref for traceability, but the
 * install hint names the bare clone — the pin is not a package name.
 */
export function checkAsRefs(nodes: NodeDef[] | undefined, resolver: IdentityResolver): string[] {
  const errors: string[] = []
  for (const { ref, nodeId } of collectAsRefs(nodes)) {
    try {
      resolver.resolve(ref)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const { name } = parseIdentityRef(ref)
      errors.push(
        `Identity '${ref}' referenced by node '${nodeId}' (as:) is not resolvable: ${msg} ` +
        `Install it with: octopus resource install builtin:${name} --type clone`,
      )
    }
  }
  return errors
}
