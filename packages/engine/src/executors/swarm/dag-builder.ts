import type { ExpertDef } from "@octopus/shared"

export class SwarmDAGCycleError extends Error {
  constructor(public cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(" → ")}`)
    this.name = "SwarmDAGCycleError"
  }
}

export interface DAGResult {
  levels: string[][]  // each level contains role names that can run in parallel
}

/**
 * Build a DAG from expert definitions using Kahn's algorithm.
 * Returns levels where each level's experts can execute in parallel,
 * with levels executing sequentially (level 0 first, then level 1, etc.)
 */
export function buildDAG(experts: ExpertDef[]): DAGResult {
  // Build adjacency list and in-degree count
  const roles = new Set(experts.map(e => e.role))
  const adj = new Map<string, string[]>()  // role → dependents
  const inDegree = new Map<string, number>()

  for (const expert of experts) {
    adj.set(expert.role, [])
    inDegree.set(expert.role, 0)
  }

  for (const expert of experts) {
    if (expert.depends_on) {
      for (const dep of expert.depends_on) {
        if (!roles.has(dep)) continue  // skip unknown deps (validated by schema)
        adj.get(dep)!.push(expert.role)
        inDegree.set(expert.role, (inDegree.get(expert.role) ?? 0) + 1)
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = []
  for (const [role, degree] of inDegree) {
    if (degree === 0) queue.push(role)
  }

  const levels: string[][] = []
  let processed = 0

  while (queue.length > 0) {
    // All items currently in queue form one level
    const level = [...queue]
    levels.push(level)
    queue.length = 0  // clear

    for (const role of level) {
      processed++
      for (const dependent of (adj.get(role) ?? [])) {
        const newDegree = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDegree)
        if (newDegree === 0) {
          queue.push(dependent)
        }
      }
    }
  }

  if (processed < experts.length) {
    // Find cycle for error reporting
    const remaining = experts.filter(e => inDegree.get(e.role)! > 0).map(e => e.role)
    throw new SwarmDAGCycleError(remaining)
  }

  return { levels }
}
