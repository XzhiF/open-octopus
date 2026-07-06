import { ResourceError } from "./errors"
import type { RegistryEntry } from "./types"

export class DependencyResolver {
  private getEntry: (name: string) => RegistryEntry | undefined
  private maxDepth: number

  constructor(getEntry: (name: string) => RegistryEntry | undefined, maxDepth = 10) {
    this.getEntry = getEntry
    this.maxDepth = maxDepth
  }

  resolveTree(name: string): string[] {
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const order: string[] = []

    const dfs = (current: string, depth: number, path: string[]): void => {
      if (depth > this.maxDepth) {
        throw new ResourceError("DEPENDENCY_DEPTH_EXCEEDED", `Dependency chain exceeds max depth of ${this.maxDepth}: ${path.join(" → ")}`)
      }
      if (recursionStack.has(current)) {
        const cycle = [...path.slice(path.indexOf(current)), current].join(" → ")
        throw new ResourceError("CIRCULAR_DEPENDENCY", `Circular dependency detected: ${cycle}`)
      }
      if (visited.has(current)) return

      recursionStack.add(current)
      const entry = this.getEntry(current)
      if (entry?.dependencies) {
        for (const dep of entry.dependencies) {
          dfs(dep, depth + 1, [...path, current])
        }
      }
      recursionStack.delete(current)
      visited.add(current)
      order.push(current)
    }

    dfs(name, 0, [])
    return order
  }

  getReverseDeps(name: string): string[] {
    const result: string[] = []
    const allEntries = this.getAllEntries()
    for (const entry of allEntries) {
      if (entry.dependencies.includes(name)) {
        result.push(entry.name)
      }
    }
    return result
  }

  private getAllEntries: () => RegistryEntry[] = () => {
    // This will be overridden by the manager to provide all entries
    return []
  }

  setGetAllEntries(fn: () => RegistryEntry[]): void {
    this.getAllEntries = fn
  }
}
