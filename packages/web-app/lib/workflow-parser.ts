import type { Node, Edge } from "@xyflow/react"
import dagre from "@dagrejs/dagre"

interface WorkflowNode {
  id: string
  type: string
  depends_on?: string[]
  cases?: Array<{ when: string; then: string }>
  command?: string
  script?: string
  prompt?: string
  description?: string
  risk_level?: string
  iterations?: number
  loop_body?: Array<Record<string, unknown>>
  nodes?: WorkflowNode[]
  [key: string]: unknown
}

interface WorkflowDefinition {
  name?: string
  nodes?: WorkflowNode[]
  [key: string]: unknown
}

const VALID_NODE_TYPES = new Set(["bash", "python", "agent", "condition", "approval", "loop", "swarm"])

// Node dimensions for dagre layout
function getNodeDimensions(node: WorkflowNode): { width: number; height: number } {
  switch (node.type) {
    case "condition": return { width: 280, height: 160 }
    case "loop": return { width: 280, height: 160 }
    case "agent": return { width: 280, height: 140 }
    case "approval": return { width: 280, height: 140 }
    case "swarm": return { width: 280, height: 160 }
    default: return { width: 280, height: 130 }
  }
}

/**
 * Compute rank per node (longest path from any root).
 * Used to detect skip edges — edges that span more than one rank.
 */
function computeRanks(workflowNodes: WorkflowNode[]): Record<string, number> {
  const rank: Record<string, number> = {}
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()
  for (const n of workflowNodes) {
    inDegree.set(n.id, n.depends_on?.length ?? 0)
    adjList.set(n.id, [])
  }
  for (const n of workflowNodes) {
    for (const parentId of n.depends_on ?? []) {
      adjList.get(parentId)?.push(n.id)
    }
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      rank[id] = 0
      queue.push(id)
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    for (const childId of adjList.get(id) ?? []) {
      rank[childId] = Math.max(rank[childId] ?? 0, rank[id] + 1)
      inDegree.set(childId, inDegree.get(childId)! - 1)
      if (inDegree.get(childId) === 0) queue.push(childId)
    }
  }

  return rank
}

/**
 * Use dagre for DAG layout — minimizes edge crossings automatically.
 * After dagre computes positions, skip-edge intermediate nodes are offset right
 * so long-range edges don't pass through node bodies.
 */
function dagreLayout(
  workflowNodes: WorkflowNode[],
  edges: Edge[],
  options?: { rankdir?: "TB" | "LR"; padding?: number; nodesep?: number; ranksep?: number }
): Record<string, { x: number; y: number }> {
  const {
    rankdir = "TB",
    padding = 50,
    nodesep = 100,
    ranksep = 70,
  } = options ?? {}
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir,
    nodesep,
    ranksep,
    edgesep: 40,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of workflowNodes) {
    const dim = getNodeDimensions(node)
    g.setNode(node.id, dim)
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  // Build rank map from dagre positions
  const nodeRank = new Map<string, number>()
  for (const node of workflowNodes) {
    const pos = g.node(node.id)
    if (pos) nodeRank.set(node.id, pos.rank)
  }

  // Collect positions — convert dagre center to top-left
  const positions = new Map<string, { x: number; y: number; rank: number }>()
  for (const node of workflowNodes) {
    const pos = g.node(node.id)
    const dim = getNodeDimensions(node)
    if (pos) {
      positions.set(node.id, {
        x: pos.x - dim.width / 2,
        y: pos.y - dim.height / 2,
        rank: pos.rank,
      })
    }
  }

  // Detect skip edges and offset intermediate nodes right
  for (const edge of edges) {
    const srcRank = nodeRank.get(edge.source)
    const tgtRank = nodeRank.get(edge.target)
    if (srcRank === undefined || tgtRank === undefined) continue
    if (tgtRank - srcRank <= 1) continue

    for (const [id, data] of positions) {
      if (data.rank > srcRank && data.rank < tgtRank) {
        data.x += 150
      }
    }
  }

  // Normalize: use first node's position as anchor (don't collapse all to x=0)
  const firstNode = workflowNodes[0]
  const anchorX = positions.get(firstNode.id)?.x ?? 0
  const anchorY = Math.min(...Array.from(positions.values()).map(p => p.y))

  const result: Record<string, { x: number; y: number }> = {}
  for (const [id, data] of positions) {
    result[id] = {
      x: data.x - anchorX + padding,
      y: data.y - anchorY + padding,
    }
  }

  return result
}

export function yamlToFlowData(parsed: WorkflowDefinition): { nodes: Node[]; edges: Edge[] } | null {
  if (!parsed || !parsed.nodes || !Array.isArray(parsed.nodes)) return null
  if (parsed.nodes.length === 0) return null

  const workflowNodes = parsed.nodes as WorkflowNode[]
  if (!workflowNodes.every((n) => VALID_NODE_TYPES.has(n.type))) return null

  // ─── Separate loop nodes with inner nodes from top-level nodes ───
  const loopNodesWithInner = new Map<string, WorkflowNode>()
  const topWorkflowNodes: WorkflowNode[] = []

  for (const node of workflowNodes) {
    if (node.type === "loop" && Array.isArray(node.nodes) && node.nodes.length > 0) {
      loopNodesWithInner.set(node.id, node)
      topWorkflowNodes.push(node) // keep as placeholder for outer layout
    } else {
      topWorkflowNodes.push(node)
    }
  }

  // ─── Build outer edges (top-level graph) ───
  const outerEdges: Edge[] = []

  for (const node of topWorkflowNodes) {
    if (node.depends_on && Array.isArray(node.depends_on)) {
      for (const parentId of node.depends_on) {
        outerEdges.push({
          id: `e-${parentId}-${node.id}`,
          source: parentId,
          target: node.id,
          type: "smoothstep",
        })
      }
    }

    if (node.type === "condition" && node.cases) {
      for (const caseItem of node.cases) {
        const existing = outerEdges.find(
          (e) => e.source === node.id && e.target === caseItem.then
        )
        if (!existing) {
          outerEdges.push({
            id: `e-${node.id}-${caseItem.then}-case`,
            source: node.id,
            target: caseItem.then,
            type: "condition",
            data: { label: caseItem.when },
          })
        }
      }
    }
  }

  // ─── Top-level dagre layout ───
  const topPositions = dagreLayout(topWorkflowNodes, outerEdges)

  // ─── Extract inner nodes and edges from loop containers ───
  const allInnerNodes: Node[] = []
  const allInnerEdges: Edge[] = []
  const containerSizes = new Map<string, { width: number; height: number }>()

  // ─── Inner dagre layout constants ───
  const INNER_LAYOUT_RANKDIR = "TB" as const
  const INNER_LAYOUT_PADDING = 20
  const INNER_LAYOUT_NODESEP = 40
  const INNER_LAYOUT_RANKSEP = 60
  const CONTAINER_PADDING = 20

  for (const [loopId, loopNode] of loopNodesWithInner) {
    const innerNodes = loopNode.nodes!

    // Validate inner node types
    if (!innerNodes.every((n: WorkflowNode) => VALID_NODE_TYPES.has(n.type))) return null

    // Note: nested loops (loop inside loop) are not yet supported — inner loop
    // nodes are treated as regular inner nodes without recursive expansion.
    const innerWfNodes: WorkflowNode[] = innerNodes.map((n) => ({
      ...n,
      id: `${loopId}:${n.id}`,
      depends_on: n.depends_on?.map((dep) => `${loopId}:${dep}`),
    }))

    // Build inner edges
    const innerEdges: Edge[] = []
    for (const innerNode of innerWfNodes) {
      if (innerNode.depends_on) {
        for (const dep of innerNode.depends_on) {
          innerEdges.push({
            id: `e-${dep}-${innerNode.id}`,
            source: dep,
            target: innerNode.id,
            type: "smoothstep",
          })
        }
      }
    }

    // Inner dagre layout with LR direction and tighter padding
    const innerPositions = dagreLayout(innerWfNodes, innerEdges, {
      rankdir: INNER_LAYOUT_RANKDIR,
      padding: INNER_LAYOUT_PADDING,
      nodesep: INNER_LAYOUT_NODESEP,
      ranksep: INNER_LAYOUT_RANKSEP,
    })

    // Build a lookup map for original inner nodes (avoids O(n²) find)
    const origNodeMap = new Map(innerNodes.map(n => [`${loopId}:${n.id}`, n]))

    // Offset inner node Y positions by header height so they render below the container header
    const HEADER_HEIGHT = 36

    // Build inner React Flow nodes with parentId and extent
    for (const innerWfNode of innerWfNodes) {
      const origNode = origNodeMap.get(innerWfNode.id)!
      const rawPos = innerPositions[innerWfNode.id] ?? { x: 0, y: 0 }
      allInnerNodes.push({
        id: innerWfNode.id,
        type: innerWfNode.type,
        position: { x: rawPos.x, y: rawPos.y + HEADER_HEIGHT },
        parentId: loopId,
        extent: "parent",
        data: {
          id: innerWfNode.id,
          type: innerWfNode.type,
          name: origNode.description || origNode.id,
          command: origNode.command,
          script: origNode.script,
          prompt: origNode.prompt,
          risk_level: origNode.risk_level,
        },
      })
    }

    allInnerEdges.push(...innerEdges)

    // Compute container size from inner node bounding box + padding
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const innerWfNode of innerWfNodes) {
      const pos = innerPositions[innerWfNode.id]
      if (!pos) continue
      const dim = getNodeDimensions(innerWfNode)
      minX = Math.min(minX, pos.x)
      minY = Math.min(minY, pos.y)
      maxX = Math.max(maxX, pos.x + dim.width)
      maxY = Math.max(maxY, pos.y + dim.height)
    }
    // Guard: if no positions found, use minimum size
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 280; maxY = 130 }
    // Container size: padding around nodes + header height
    // minX/minY already include INNER_LAYOUT_PADDING (20px) and HEADER_HEIGHT (36px)
    // We need: 20px top + 36px header + node height + 20px bottom
    containerSizes.set(loopId, {
      width: (maxX - minX) + INNER_LAYOUT_PADDING * 2,
      height: HEADER_HEIGHT + (maxY - minY) + INNER_LAYOUT_PADDING,
    })
  }

  // ─── Build final nodes array ───
  const nodes: Node[] = topWorkflowNodes.map((node) => {
    const isLoopContainer = loopNodesWithInner.has(node.id)
    const containerSize = containerSizes.get(node.id)

    const baseNode: Node = {
      id: node.id,
      type: isLoopContainer ? "loop-container" : node.type,
      position: topPositions[node.id] || { x: 0, y: 0 },
      data: {
        id: node.id,
        type: isLoopContainer ? "loop-container" : node.type,
        name: node.description || node.id,
        command: node.command,
        script: node.script,
        prompt: node.prompt,
        risk_level: node.risk_level,
        iterations: node.iterations,
        loop_body: node.loop_body,
        cases: node.cases,
        ...(node.type === "swarm" ? {
          mode: (node as Record<string, unknown>).mode,
          topic: (node as Record<string, unknown>).topic,
          expertCount: Array.isArray((node as Record<string, unknown>).experts)
            ? ((node as Record<string, unknown>).experts as unknown[]).length
            : ((node as Record<string, unknown>).max_experts as number) ?? 0,
          consensusScore: null,
          status: "pending",
        } : {}),
        ...(isLoopContainer && containerSize ? {
          containerWidth: containerSize.width,
          containerHeight: containerSize.height,
        } : {}),
      },
      ...(isLoopContainer && containerSize ? {
        style: {
          width: containerSize.width,
          height: containerSize.height,
        },
      } : {}),
    }

    return baseNode
  })

  nodes.push(...allInnerNodes)

  return { nodes, edges: [...outerEdges, ...allInnerEdges] }
}