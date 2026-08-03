// packages/engine/src/executors/dynamic-sub-workflow-hash.ts
//
// Input hash computation for context-aware rerun detection.
// Uses SHA-256 on canonical (sorted-key) JSON to ensure deterministic hashing.
//
import { createHash } from "crypto"
import type { NodeDef } from "@octopus/shared"
import { VarPool } from "@octopus/shared"
import type { NodeExecutionResult } from "./types"

/**
 * Produce canonical JSON: keys sorted recursively, no whitespace.
 */
function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (typeof obj !== "object") return JSON.stringify(obj)
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]"
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  const pairs = sorted.map((k) => JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k]))
  return "{" + pairs.join(",") + "}"
}

/**
 * Compute a SHA-256 hex hash of the input snapshot.
 * Uses canonical JSON (sorted keys) so key ordering doesn't affect the hash.
 */
export function computeInputHash(inputSnapshot: Record<string, unknown>): string {
  const canonical = canonicalJson(inputSnapshot)
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Build an input snapshot from the node's upstream dependencies.
 * Collects:
 * - All VarPool variables (under "vars" key)
 * - Output of each upstream node listed in depends_on (under node ID key)
 */
export function buildInputSnapshot(
  node: NodeDef,
  pool: VarPool,
  nodeResults: Record<string, NodeExecutionResult>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}

  // Include pool snapshot
  snapshot["vars"] = pool.snapshot()

  // Include upstream node outputs
  const deps = node.depends_on ?? []
  for (const depId of deps) {
    const result = nodeResults[depId]
    if (result) {
      const outputs: Record<string, any> = { ...(result.outputs ?? {}) }
      if (result.lastOutput !== undefined) {
        outputs["output"] = result.lastOutput
      }
      snapshot[depId] = outputs
    }
  }

  return snapshot
}
