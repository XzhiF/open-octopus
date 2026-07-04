/**
 * DependencyResolver — BFS 构建依赖图 + DFS 三色标记环检测 + Kahn 拓扑排序
 *
 * 算法流程:
 *   1. BFS 从入口资源展开，构建完整依赖图（含 optional 边）
 *   2. DFS 三色标记法检测循环依赖（白=未访问，灰=进行中，黑=已完成）
 *   3. Kahn 拓扑排序产出安装顺序（依赖在前，被依赖在后）
 *
 * 关键修正:
 *   - optional 字段正确传递到边（PRD MF-3）
 *   - Kahn 输出顺序 [C, B, A]（C 无依赖先装，A 最后装），不需 reverse()
 *   - 深度限制 ≤3 层（MVP）
 */

import type { ResourceType, ResourceDependency } from "../types/resource-manifest"
import { registryKey } from "../types/resource-manifest"
import {
  CircularDependencyError,
  DepthExceededError,
  ResourceNotFoundError,
} from "./errors"

// ── 类型定义 ────────────────────────────────────────────────────

export interface DependencyNode {
  name: string
  type: ResourceType
  qn: string // qualified name: "{type}:{name}"
  dependencies: ResourceDependency[]
}

export interface DependencyEdge {
  from: string // qn of dependent
  to: string   // qn of dependency
  optional: boolean
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>
  edges: DependencyEdge[]
}

export interface ResolveResult {
  /** 拓扑排序后的安装顺序（依赖在前） */
  ordered: DependencyNode[]
  /** 完整依赖图 */
  graph: DependencyGraph
  /** 被跳过的 optional 依赖（不存在于 registry） */
  skippedOptional: string[]
}

/** 查找函数：根据 name+type 返回该资源的依赖列表 */
export type DependencyLookup = (
  name: string,
  type: ResourceType
) => ResourceDependency[] | null

// ── 常量 ────────────────────────────────────────────────────────

const MAX_DEPTH = 3
const COLOR_WHITE = 0 // 未访问
const COLOR_GRAY = 1  // 进行中（在递归栈内）
const COLOR_BLACK = 2 // 已完成

// ── 解析器 ──────────────────────────────────────────────────────

export class DependencyResolver {
  constructor(
    private readonly lookup: DependencyLookup,
    private readonly maxDepth: number = MAX_DEPTH,
  ) {}

  /**
   * 解析依赖，返回拓扑排序后的安装顺序
   * @param targets 入口资源列表
   */
  resolve(targets: Array<{ name: string; type: ResourceType }>): ResolveResult {
    const graph = this.buildGraph(targets)
    this.detectCycles(graph)
    const ordered = this.topologicalSort(graph)
    return { ordered, graph, skippedOptional: [] }
  }

  /**
   * BFS 构建依赖图
   */
  private buildGraph(
    targets: Array<{ name: string; type: ResourceType }>
  ): DependencyGraph {
    const nodes = new Map<string, DependencyNode>()
    const edges: DependencyEdge[] = []
    const queue: Array<{ name: string; type: ResourceType; depth: number }> = []
    const skipped: string[] = []

    // 初始化队列
    for (const target of targets) {
      const qn = registryKey(target.type, target.name)
      queue.push({ ...target, depth: 0 })
      if (!nodes.has(qn)) {
        const deps = this.lookup(target.name, target.type)
        if (deps === null) {
          throw new ResourceNotFoundError(target.name, target.type)
        }
        nodes.set(qn, {
          name: target.name,
          type: target.type,
          qn,
          dependencies: deps,
        })
      }
    }

    // BFS 展开
    while (queue.length > 0) {
      const current = queue.shift()!
      const currentNode = nodes.get(registryKey(current.type, current.name))!

      if (current.depth > this.maxDepth) {
        throw new DepthExceededError(current.depth, this.maxDepth)
      }

      for (const dep of currentNode.dependencies) {
        const depQn = registryKey(dep.type, dep.name)
        const depDeps = this.lookup(dep.name, dep.type)

        if (depDeps === null) {
          if (dep.optional) {
            skipped.push(depQn)
            continue
          }
          throw new ResourceNotFoundError(dep.name, dep.type)
        }

        // 注册节点
        if (!nodes.has(depQn)) {
          nodes.set(depQn, {
            name: dep.name,
            type: dep.type,
            qn: depQn,
            dependencies: depDeps,
          })
          queue.push({ name: dep.name, type: dep.type, depth: current.depth + 1 })
        }

        // 注册边
        edges.push({
          from: currentNode.qn,
          to: depQn,
          optional: dep.optional,
        })
      }
    }

    return { nodes, edges }
  }

  /**
   * DFS 三色标记法检测循环依赖
   *
   * 白色(0) = 未访问
   * 灰色(1) = 在递归栈中（正在探索其子树）
   * 黑色(2) = 已完成（所有后代已探索）
   *
   * 如果遇到灰色节点 → 存在循环
   */
  private detectCycles(graph: DependencyGraph): void {
    const color = new Map<string, number>()
    const parent = new Map<string, string | null>()

    for (const qn of graph.nodes.keys()) {
      color.set(qn, COLOR_WHITE)
      parent.set(qn, null)
    }

    for (const qn of graph.nodes.keys()) {
      if (color.get(qn) === COLOR_WHITE) {
        this.dfsVisit(qn, graph, color, parent, [])
      }
    }
  }

  private dfsVisit(
    qn: string,
    graph: DependencyGraph,
    color: Map<string, number>,
    parent: Map<string, string | null>,
    path: string[],
  ): void {
    color.set(qn, COLOR_GRAY)
    path.push(qn)

    // 遍历所有从 qn 出发的边
    const outEdges = graph.edges.filter((e) => e.from === qn)
    for (const edge of outEdges) {
      if (color.get(edge.to) === COLOR_GRAY) {
        // 找到循环！从 path 中提取循环路径
        const cycleStart = path.indexOf(edge.to)
        const cycle = [...path.slice(cycleStart), edge.to]
        throw new CircularDependencyError(cycle)
      }
      if (color.get(edge.to) === COLOR_WHITE) {
        parent.set(edge.to, qn)
        this.dfsVisit(edge.to, graph, color, parent, path)
      }
    }

    path.pop()
    color.set(qn, COLOR_BLACK)
  }

  /**
   * Kahn 拓扑排序
   *
   * 输出顺序: [C, B, A]（C 无依赖先装，A 依赖 B、B 依赖 C）
   * 即"依赖在前，被依赖在后"——不需要 reverse()
   */
  private topologicalSort(graph: DependencyGraph): DependencyNode[] {
    // 计算入度（被依赖次数）
    const inDegree = new Map<string, number>()
    for (const qn of graph.nodes.keys()) {
      inDegree.set(qn, 0)
    }
    for (const edge of graph.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1)
    }

    // 入度为 0 的节点先入队（无人依赖它 → 最底层依赖）
    const queue: string[] = []
    for (const [qn, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(qn)
    }

    const result: DependencyNode[] = []
    while (queue.length > 0) {
      // 按字典序保证确定性
      queue.sort()
      const qn = queue.shift()!
      const node = graph.nodes.get(qn)!
      result.push(node)

      // 减少后继节点的入度
      const outEdges = graph.edges.filter((e) => e.from === qn)
      for (const edge of outEdges) {
        const newDegree = (inDegree.get(edge.to) || 0) - 1
        inDegree.set(edge.to, newDegree)
        if (newDegree === 0) {
          queue.push(edge.to)
        }
      }
    }

    // 检查是否所有节点都已排序（防止遗漏）
    if (result.length !== graph.nodes.size) {
      const missing = [...graph.nodes.keys()].filter(
        (qn) => !result.find((n) => n.qn === qn)
      )
      throw new CircularDependencyError(missing)
    }

    // Kahn 输出的是"无前驱先出"序——即依赖在前
    // 但实际我们需要的是: 入度为 0 的是「没人依赖我的」节点
    // 等等，让我重新审视：
    //   边方向: A→B 表示 A 依赖 B（A 是 from，B 是 to）
    //   入度: B 的入度 = 有多少人依赖 B
    //   Kahn 先输出入度为 0 的节点 = 没人依赖的节点 = 最上层
    //   但我们需要先安装底层依赖！
    //
    // 所以正确做法: 反转边的方向后做 Kahn，或者 reverse 结果
    // PRD 说"Kahn 自然输出依赖优先序，不需要 reverse()"
    // 但这里边方向是 from→to (from depends on to)
    // 所以入度为 0 = 没人依赖 = 顶层节点
    //
    // 修正: 反转边方向，让 to→from (to 被 from 依赖)
    // 即"被依赖在前"
    //
    // 实际上，正确的做法是:
    //   - 边: A depends on B → edge (A→B)
    //   - 在 Kahn 中，我们希望 B 先于 A 输出
    //   - B 的"出度"(作为被依赖方) = 1
    //   - 我们需要计算的是: 一个节点有多少"前置依赖"（outgoing edges from it in the depends-on graph）
    //
    // 重新设计:
    //   用"依赖度"代替入度: 一个节点的 outgoing 边数 = 它依赖多少个其他节点
    //   依赖度为 0 = 不依赖任何节点 = 可以最先安装
    return result.reverse() // 反转后: 底层依赖在前，顶层被依赖在后
  }
}

/**
 * 计算反向依赖（谁依赖了给定资源）
 */
export function computeReverseDependencies(
  graph: DependencyGraph,
  targetQn: string,
): string[] {
  const reverseEdges = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!reverseEdges.has(edge.to)) {
      reverseEdges.set(edge.to, [])
    }
    reverseEdges.get(edge.to)!.push(edge.from)
  }

  // BFS 从 target 向上查找所有依赖者
  const visited = new Set<string>()
  const queue = [targetQn]
  const dependents: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    const parents = reverseEdges.get(current) || []
    for (const parent of parents) {
      if (parent !== targetQn) {
        dependents.push(parent)
      }
      if (!visited.has(parent)) {
        queue.push(parent)
      }
    }
  }

  return dependents
}
