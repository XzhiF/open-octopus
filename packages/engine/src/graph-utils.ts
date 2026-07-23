// packages/engine/src/graph-utils.ts
//
// Pure graph algorithm functions for DAG-based workflow execution.
// No class state — all functions take explicit parameters.
//
import type { NodeDef } from "@octopus/shared"

/**
 * Build implicit dependency edges from condition node targets.
 * When a condition node branches to target X, X implicitly depends on the condition
 * to prevent X from executing before the condition gate that controls it.
 */
export function buildConditionTargetDeps(nodes: NodeDef[]): Map<string, Set<string>> {
  const implicitDeps = new Map<string, Set<string>>()
  for (const node of nodes) {
    if (node.type === "condition" && node.cases) {
      for (const c of node.cases) {
        if (c.then && c.then !== "default") {
          if (!implicitDeps.has(c.then)) implicitDeps.set(c.then, new Set())
          implicitDeps.get(c.then)!.add(node.id)
        }
      }
    }
  }
  return implicitDeps
}

/** Merge explicit depends_on with implicit condition target deps. */
export function getEffectiveDeps(node: NodeDef, implicitDeps: Map<string, Set<string>>): string[] {
  const explicit = node.depends_on ?? []
  const implicit = implicitDeps.get(node.id)
  if (!implicit || implicit.size === 0) return explicit
  const merged = new Set(explicit)
  for (const dep of implicit) merged.add(dep)
  return Array.from(merged)
}

/** Detect circular dependencies via DFS. Throws on cycle. */
export function detectCycles(nodes: NodeDef[]): void {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const implicitDeps = buildConditionTargetDeps(nodes)
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Circular dependency detected: ${id}`)
    visiting.add(id)
    const node = nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id} (available: ${Array.from(nodeMap.keys()).join(",")})`)
    for (const dep of getEffectiveDeps(node, implicitDeps)) {
      visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const node of nodes) {
    visit(node.id)
  }
}

/** DFS topological sort producing a flat linear order. Used by retryFrom() for index-based slicing. */
export function topologicalSort(nodes: NodeDef[]): NodeDef[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const implicitDeps = buildConditionTargetDeps(nodes)
  const sorted: NodeDef[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Circular dependency detected: ${id}`)
    visiting.add(id)
    const node = nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id} (available: ${Array.from(nodeMap.keys()).join(",")})`)
    for (const dep of getEffectiveDeps(node, implicitDeps)) {
      visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
    sorted.push(node)
  }

  for (const node of nodes) {
    visit(node.id)
  }

  return sorted
}

/** Kahn's algorithm: compute DAG execution levels — sets of nodes that can run concurrently. */
export function computeExecutionLevels(nodes: NodeDef[]): NodeDef[][] {
  detectCycles(nodes)

  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const implicitDeps = buildConditionTargetDeps(nodes)
  const levels: NodeDef[][] = []
  const completed = new Set<string>()
  const remaining = new Set(nodes.map(n => n.id))

  while (remaining.size > 0) {
    const level: NodeDef[] = []
    for (const id of remaining) {
      const node = nodeMap.get(id)!
      const deps = getEffectiveDeps(node, implicitDeps)
      if (deps.every(d => completed.has(d))) {
        level.push(node)
      }
    }
    if (level.length === 0) {
      throw new Error(`Deadlock: remaining nodes have unsatisfied dependencies: ${Array.from(remaining).join(",")}`)
    }
    levels.push(level)
    for (const node of level) {
      completed.add(node.id)
      remaining.delete(node.id)
    }
  }

  return levels
}
