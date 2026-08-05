// packages/engine/src/executors/dynamic-sub-workflow-validation.ts
//
// Three-layer validation harness for LLM-generated DAG JSON.
// L1 = Structure (JSON shape), L2 = Graph (cycles, refs), L3 = Semantics (type whitelist, prompt).
//
import type { NodeDef } from "@octopus/shared"

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * L1: Validate the raw JSON structure.
 * - Must be a non-null object
 * - Must have a `nodes` array
 * - Each node must have `id` (string), `type` (string), `prompt` (string) or `task.brief` (for octopus_agent)
 */
export function validateL1Structure(json: unknown): ValidationResult {
  const errors: string[] = []

  if (json === null || json === undefined || typeof json !== "object" || Array.isArray(json)) {
    return { valid: false, errors: ["L1: input must be a non-null object"] }
  }

  const obj = json as Record<string, unknown>

  if (!Array.isArray(obj.nodes)) {
    errors.push("L1: missing or invalid 'nodes' array")
    return { valid: false, errors }
  }

  for (let i = 0; i < obj.nodes.length; i++) {
    const node = obj.nodes[i]
    if (typeof node !== "object" || node === null) {
      errors.push(`L1: nodes[${i}] must be an object`)
      continue
    }
    const n = node as Record<string, unknown>
    if (typeof n.id !== "string" || n.id.length === 0) {
      errors.push(`L1: nodes[${i}] missing or invalid 'id'`)
    }
    if (typeof n.type !== "string" || n.type.length === 0) {
      errors.push(`L1: nodes[${i}] missing or invalid 'type'`)
    }
    // octopus_agent uses task.brief instead of prompt
    if (n.type === "octopus_agent") {
      const task = n.task as Record<string, unknown> | undefined
      if (!task || typeof task.brief !== "string" || task.brief.length === 0) {
        errors.push(`L1: nodes[${i}] (octopus_agent) missing or invalid 'task.brief'`)
      }
    } else {
      if (typeof n.prompt !== "string" || n.prompt.length === 0) {
        errors.push(`L1: nodes[${i}] missing or invalid 'prompt'`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * L2: Validate the DAG graph properties.
 * - No circular dependencies (uses DFS cycle detection)
 * - All depends_on references must point to existing node IDs
 */
export function validateL2Graph(nodes: NodeDef[]): ValidationResult {
  const errors: string[] = []
  const nodeIds = new Set(nodes.map((n) => n.id))

  // Check depends_on references
  for (const node of nodes) {
    if (node.depends_on) {
      for (const dep of node.depends_on) {
        if (!nodeIds.has(dep)) {
          errors.push(`L2: node "${node.id}" depends_on non-existent node "${dep}"`)
        }
      }
    }
  }

  // DFS cycle detection — does not short-circuit so all cycles are reported
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id)
      const cyclePath = cycleStart >= 0 ? [...path.slice(cycleStart), id] : [id]
      errors.push(`L2: dependency cycle detected (circular): ${cyclePath.join(" → ")}`)
      return
    }
    visiting.add(id)
    path.push(id)
    const node = nodeMap.get(id)
    if (node?.depends_on) {
      for (const dep of node.depends_on) {
        if (nodeIds.has(dep)) {
          visit(dep, [...path])
        }
      }
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const node of nodes) {
    if (!visited.has(node.id) && !visiting.has(node.id)) {
      visit(node.id, [])
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * L3: Validate semantic constraints.
 * - All nodes must be type "agent" or "octopus_agent" (whitelist)
 * - All prompts must be non-empty strings (or task.brief for octopus_agent)
 */
export function validateL3Semantics(nodes: NodeDef[]): ValidationResult {
  const errors: string[] = []
  const ALLOWED_TYPES = new Set(["agent", "octopus_agent"])

  for (const node of nodes) {
    if (!ALLOWED_TYPES.has(node.type)) {
      errors.push(`L3: node "${node.id}" has disallowed type "${node.type}" — only "agent" and "octopus_agent" are permitted in dynamic sub-workflow DAGs`)
    }
    // octopus_agent uses task.brief instead of prompt
    if (node.type === "octopus_agent") {
      const task = (node as any).task as { brief?: string } | undefined
      if (!task?.brief || task.brief.trim().length === 0) {
        errors.push(`L3: node "${node.id}" (octopus_agent) has empty or missing task.brief`)
      }
    } else {
      if (!node.prompt || node.prompt.trim().length === 0) {
        errors.push(`L3: node "${node.id}" has empty or missing prompt`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Run the full validation pipeline: L1 → L2 → L3.
 * Stops at the first failing layer (L1 failure short-circuits L2/L3).
 */
export function runValidationPipeline(json: unknown): { result: ValidationResult; errors: string[] } {
  // L1
  const l1 = validateL1Structure(json)
  if (!l1.valid) {
    return { result: l1, errors: l1.errors }
  }

  // Extract nodes for L2/L3
  const rawNodes = (json as { nodes: Array<Record<string, unknown>> }).nodes
  const nodes: NodeDef[] = rawNodes.map((n) => ({
    id: n.id as string,
    type: n.type as NodeDef["type"],
    prompt: n.prompt as string | undefined,
    depends_on: n.depends_on as string[] | undefined,
    // Pass through task for octopus_agent L3 validation
    ...(n.type === "octopus_agent" ? { task: n.task } : {}),
  }))

  // L2
  const l2 = validateL2Graph(nodes)
  if (!l2.valid) {
    return { result: l2, errors: l2.errors }
  }

  // L3
  const l3 = validateL3Semantics(nodes)
  return { result: l3, errors: l3.errors }
}
