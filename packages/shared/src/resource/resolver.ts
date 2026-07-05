import type { ResourceManifest } from './schema'
import { ResourceError, ResourceErrorCode } from './errors'

/**
 * DependencyResolver — DFS + 拓扑排序
 * 解析资源依赖图，检测循环依赖，输出安装顺序
 */
export class DependencyResolver {
  private graph = new Map<string, Set<string>>()
  private manifests = new Map<string, ResourceManifest>()

  addManifest(manifest: ResourceManifest): void {
    const key = manifest.name
    this.manifests.set(key, manifest)
    if (!this.graph.has(key)) {
      this.graph.set(key, new Set())
    }
    for (const dep of manifest.dependencies) {
      this.graph.get(key)!.add(dep)
    }
  }

  /**
   * 拓扑排序（Kahn 算法），返回安装顺序（依赖在前）
   * @throws Error if cycle detected
   */
  resolve(targetNames: string[]): string[] {
    // Build in-degree map for target subgraph
    const inDegree = new Map<string, number>()
    const adjList = new Map<string, string[]>()

    // Collect all reachable nodes from targets
    const reachable = new Set<string>()
    const queue = [...targetNames]
    while (queue.length > 0) {
      const node = queue.pop()!
      if (reachable.has(node)) continue
      reachable.add(node)
      const deps = this.graph.get(node) ?? new Set()
      for (const dep of deps) {
        queue.push(dep)
      }
    }

    // Initialize in-degree and adjacency list
    // graph[node] = set of nodes that `node` depends on
    // Edge direction: dep → node (dep must be installed before node)
    for (const node of reachable) {
      if (!inDegree.has(node)) inDegree.set(node, 0)
      if (!adjList.has(node)) adjList.set(node, [])
      const deps = this.graph.get(node) ?? new Set()
      for (const dep of deps) {
        if (!reachable.has(dep)) continue
        if (!inDegree.has(dep)) inDegree.set(dep, 0)
        if (!adjList.has(dep)) adjList.set(dep, [])
        inDegree.set(node, (inDegree.get(node) ?? 0) + 1)
        adjList.get(dep)!.push(node)
      }
    }

    // Kahn's algorithm
    const sorted: string[] = []
    const workQueue: string[] = []
    for (const [node, deg] of inDegree) {
      if (deg === 0) workQueue.push(node)
    }

    while (workQueue.length > 0) {
      const node = workQueue.shift()!
      sorted.push(node)
      for (const neighbor of (adjList.get(node) ?? [])) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) workQueue.push(neighbor)
      }
    }

    if (sorted.length !== reachable.size) {
      // Cycle detected
      const remaining = [...reachable].filter(n => !sorted.includes(n))
      throw new ResourceError(ResourceErrorCode.DEPENDENCY_CYCLE, `DEPENDENCY_CYCLE: Cycle detected among: ${remaining.join(', ')}`)
    }

    return sorted
  }

  getManifest(name: string): ResourceManifest | undefined {
    return this.manifests.get(name)
  }
}
