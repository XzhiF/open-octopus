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

const VALID_NODE_TYPES = new Set(["bash", "python", "agent", "condition", "approval", "loop", "swarm", "interaction", "sub_workflow", "dynamic_sub_workflow", "octopus_agent"])

// Node dimensions for dagre layout
// Heights account for header + duration + multi-model token display
function getNodeDimensions(node: WorkflowNode): { width: number; height: number } {
  switch (node.type) {
    case "condition": return { width: 280, height: 180 }
    case "loop": return { width: 280, height: 180 }
    case "agent": return { width: 280, height: 175 }
    case "approval": return { width: 280, height: 165 }
    case "swarm": return { width: 280, height: 180 }
    case "sub_workflow": return { width: 280, height: 180 }
    case "dynamic_sub_workflow": return { width: 280, height: 180 }
    case "octopus_agent": return { width: 280, height: 200 }
    default: return { width: 280, height: 160 }
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
  options?: { rankdir?: "TB" | "LR"; padding?: number; nodesep?: number; ranksep?: number },
  dimensionOverrides?: Map<string, { width: number; height: number }>
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
    const override = dimensionOverrides?.get(node.id)
    const dim = override ?? getNodeDimensions(node)
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
    const dim = dimensionOverrides?.get(node.id) ?? getNodeDimensions(node)
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

  // Normalize: shift so leftmost node is at x=padding, topmost at y=padding
  const minX = Math.min(...Array.from(positions.values()).map(p => p.x))
  const minY = Math.min(...Array.from(positions.values()).map(p => p.y))

  const result: Record<string, { x: number; y: number }> = {}
  for (const [id, data] of positions) {
    result[id] = {
      x: data.x - minX + padding,
      y: data.y - minY + padding,
    }
  }

  return result
}

export function yamlToFlowData(
  parsed: WorkflowDefinition,
  subWorkflowNodes?: Record<string, WorkflowNode[]>,
): { nodes: Node[]; edges: Edge[] } | null {
  if (!parsed || !parsed.nodes || !Array.isArray(parsed.nodes)) return null
  if (parsed.nodes.length === 0) return null

  const workflowNodes = parsed.nodes as WorkflowNode[]
  if (!workflowNodes.every((n) => VALID_NODE_TYPES.has(n.type))) return null

  // ─── Separate container nodes (loop + sub_workflow) with inner nodes from top-level nodes ───
  const containerNodesWithInner = new Map<string, WorkflowNode>()
  const topWorkflowNodes: WorkflowNode[] = []

  for (const node of workflowNodes) {
    if (node.type === "loop" && Array.isArray(node.nodes) && node.nodes.length > 0) {
      containerNodesWithInner.set(node.id, node)
      topWorkflowNodes.push(node) // keep as placeholder for outer layout
    } else if (node.type === "sub_workflow" || node.type === "dynamic_sub_workflow") {
      // For sub_workflow / dynamic_sub_workflow: use inline nodes if present, otherwise look up from subWorkflowNodes map
      const workflowRef = (node as Record<string, unknown>).workflow as string | undefined
      const childNodes = node.nodes ?? (workflowRef ? subWorkflowNodes?.[workflowRef] : undefined)
      if (childNodes && childNodes.length > 0) {
        // Create a synthetic node with the resolved child nodes for container rendering
        const enrichedNode = { ...node, nodes: childNodes }
        containerNodesWithInner.set(node.id, enrichedNode)
      }
      topWorkflowNodes.push(node)
    } else {
      topWorkflowNodes.push(node)
    }
  }

  // ─── Inner dagre layout constants ───
  const INNER_LAYOUT_RANKDIR = "TB" as const
  const INNER_LAYOUT_PADDING = 20
  const INNER_LAYOUT_NODESEP = 40
  const INNER_LAYOUT_RANKSEP = 60
  const HEADER_HEIGHT = 36
  const CONTAINER_SIDE_PADDING = 20

  // ─── Pre-compute container sizes (BEFORE outer layout) ───
  const containerSizes = new Map<string, { width: number; height: number }>()
  const innerLayoutData = new Map<string, {
    wfNodes: WorkflowNode[]
    edges: Edge[]
    positions: Record<string, { x: number; y: number }>
    nestedSubWfLayouts?: Map<string, {
      childNodes: WorkflowNode[]
      positions: Record<string, { x: number; y: number }>
      edges: Edge[]
      containerWidth: number
      containerHeight: number
    }>
  }>()

  for (const [loopId, loopNode] of containerNodesWithInner) {
    const innerNodes = loopNode.nodes!
    if (!innerNodes.every((n: WorkflowNode) => VALID_NODE_TYPES.has(n.type))) return null

    // Resolve sub_workflow children nested inside this loop
    const resolvedInnerNodes: WorkflowNode[] = innerNodes.map((n) => {
      if (n.type === "sub_workflow" || n.type === "dynamic_sub_workflow") {
        const workflowRef = (n as Record<string, unknown>).workflow as string | undefined
        const childNodes = n.nodes ?? (workflowRef ? subWorkflowNodes?.[workflowRef] : undefined)
        if (childNodes && childNodes.length > 0) {
          return { ...n, nodes: childNodes }
        }
      }
      return n
    })

    const innerWfNodes: WorkflowNode[] = resolvedInnerNodes.map((n) => ({
      ...n,
      id: `${loopId}:${n.id}`,
      depends_on: n.depends_on?.map((dep) => `${loopId}:${dep}`),
    }))

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

    // ─── Nested sub-workflow layout: compute child layouts BEFORE dagre ───
    // so dagre uses actual sub-workflow container dimensions (not default 280x180)
    const nestedSubWfLayouts = new Map<string, {
      childNodes: WorkflowNode[]
      positions: Record<string, { x: number; y: number }>
      edges: Edge[]
      containerWidth: number
      containerHeight: number
    }>()

    for (const innerWfNode of innerWfNodes) {
      if (innerWfNode.type !== "sub_workflow" && innerWfNode.type !== "dynamic_sub_workflow") continue
      const origId = innerWfNode.id.slice(loopId.length + 1)
      const origNode = resolvedInnerNodes.find((n) => n.id === origId)
      const childNodes = (origNode as any)?.nodes as WorkflowNode[] | undefined
      if (!childNodes || childNodes.length === 0) continue

      const subWfPrefix = innerWfNode.id
      const childWfNodes: WorkflowNode[] = childNodes.map((c) => ({
        ...c,
        id: `${subWfPrefix}:${c.id}`,
        depends_on: c.depends_on?.map((dep) => `${subWfPrefix}:${dep}`),
      }))
      const childEdges: Edge[] = []
      for (const child of childWfNodes) {
        if (child.depends_on) {
          for (const dep of child.depends_on) {
            childEdges.push({ id: `e-${dep}-${child.id}`, source: dep, target: child.id, type: "smoothstep" })
          }
        }
      }
      const childPositions = dagreLayout(childWfNodes, childEdges, {
        rankdir: INNER_LAYOUT_RANKDIR,
        padding: INNER_LAYOUT_PADDING,
        nodesep: INNER_LAYOUT_NODESEP,
        ranksep: INNER_LAYOUT_RANKSEP,
      })

      let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity
      for (const cw of childWfNodes) {
        const p = childPositions[cw.id]
        if (!p) continue
        const d = getNodeDimensions(cw)
        cMinX = Math.min(cMinX, p.x); cMinY = Math.min(cMinY, p.y)
        cMaxX = Math.max(cMaxX, p.x + d.width); cMaxY = Math.max(cMaxY, p.y + d.height)
      }
      if (cMinX === Infinity) { cMinX = 0; cMinY = 0; cMaxX = 280; cMaxY = 160 }
      const swWidth = (cMaxX - cMinX) + CONTAINER_SIDE_PADDING * 2
      const swHeight = 65 + (cMaxY - cMinY) + CONTAINER_SIDE_PADDING + 30

      nestedSubWfLayouts.set(innerWfNode.id, {
        childNodes: childWfNodes,
        positions: childPositions,
        edges: childEdges,
        containerWidth: swWidth,
        containerHeight: swHeight,
      })
    }

    // Build dimension overrides so dagre uses actual sub-workflow container sizes
    const dimOverrides = new Map<string, { width: number; height: number }>()
    for (const [nodeId, layout] of nestedSubWfLayouts) {
      dimOverrides.set(nodeId, { width: layout.containerWidth, height: layout.containerHeight })
    }

    const innerPositions = dagreLayout(innerWfNodes, innerEdges, {
      rankdir: INNER_LAYOUT_RANKDIR,
      padding: INNER_LAYOUT_PADDING,
      nodesep: INNER_LAYOUT_NODESEP,
      ranksep: INNER_LAYOUT_RANKSEP,
    }, dimOverrides)

    // Compute container size
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

    for (const innerWfNode of innerWfNodes) {
      const pos = innerPositions[innerWfNode.id]
      if (!pos) continue
      // Use nested layout dimensions for sub_workflow containers with children
      const nestedLayout = nestedSubWfLayouts.get(innerWfNode.id)
      const dim = nestedLayout
        ? { width: nestedLayout.containerWidth, height: nestedLayout.containerHeight }
        : getNodeDimensions(innerWfNode)
      minX = Math.min(minX, pos.x)
      minY = Math.min(minY, pos.y)
      maxX = Math.max(maxX, pos.x + dim.width)
      maxY = Math.max(maxY, pos.y + dim.height)
    }
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 280; maxY = 160 }

    // Sub-workflow containers have taller headers (badges)
    const loopContainerHeaderHeight = (loopNode.type === "sub_workflow" || loopNode.type === "dynamic_sub_workflow") ? 65 : HEADER_HEIGHT

    containerSizes.set(loopId, {
      width: (maxX - minX) + CONTAINER_SIDE_PADDING * 2,
      // Extra height for dynamic content (model names, multi-model tokens, duration, error text)
      height: loopContainerHeaderHeight + (maxY - minY) + CONTAINER_SIDE_PADDING + 55,
    })
    innerLayoutData.set(loopId, { wfNodes: innerWfNodes, edges: innerEdges, positions: innerPositions, nestedSubWfLayouts })
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

  // ─── Top-level dagre layout with ACTUAL container dimensions ───
  const topPositions = dagreLayout(topWorkflowNodes, outerEdges, undefined, containerSizes)

  // ─── Build inner nodes at ABSOLUTE positions (no parentId) ───
  const allInnerNodes: Node[] = []
  const allInnerEdges: Edge[] = []

  for (const [loopId, data] of innerLayoutData) {
    const containerPos = topPositions[loopId] ?? { x: 0, y: 0 }
    const containerSize = containerSizes.get(loopId)!

    // Detect if this container is a sub_workflow (taller header with badges)
    const containerOrigNode = containerNodesWithInner.get(loopId)
    const isSubWorkflowContainer = containerOrigNode?.type === "sub_workflow" || containerOrigNode?.type === "dynamic_sub_workflow"
    const containerHeaderHeight = isSubWorkflowContainer ? 65 : HEADER_HEIGHT

    for (const innerWfNode of data.wfNodes) {
      const rawPos = data.positions[innerWfNode.id] ?? { x: 0, y: 0 }
      // Find original node data
      const origId = innerWfNode.id.slice(loopId.length + 1)
      const origNode = containerNodesWithInner.get(loopId)!.nodes!.find((n: any) => n.id === origId) as WorkflowNode | undefined

      // sub_workflow inside a loop: render as sub-workflow-container (same as top-level)
      const isInnerSubWorkflow = innerWfNode.type === "sub_workflow" || innerWfNode.type === "dynamic_sub_workflow"
      const nodeType = isInnerSubWorkflow ? "sub-workflow-container" : innerWfNode.type
      const nestedLayout = data.nestedSubWfLayouts?.get(innerWfNode.id)

      // Use actual dimensions for sub_workflow containers with nested layouts
      const actualWidth = nestedLayout ? nestedLayout.containerWidth : getNodeDimensions(innerWfNode).width

      allInnerNodes.push({
        id: innerWfNode.id,
        type: nodeType,
        // Position: use dagre-computed rawPos directly (not centering, which destroys horizontal spread)
        position: {
          x: containerPos.x + rawPos.x,
          y: containerPos.y + containerHeaderHeight + rawPos.y,
        },
        data: {
          id: innerWfNode.id,
          type: nodeType,
          name: origNode?.description || origId,
          command: origNode?.command,
          script: origNode?.script,
          prompt: origNode?.prompt,
          risk_level: origNode?.risk_level,
          // sub_workflow specific data (needed by SubWorkflowContainerNode)
          ...(isInnerSubWorkflow ? {
            workflow: (origNode as Record<string, unknown>)?.workflow,
            execution_mode: (origNode as Record<string, unknown>)?.execution_mode ?? "inline",
            input_mapping: (origNode as Record<string, unknown>)?.input_mapping,
            output_mapping: (origNode as Record<string, unknown>)?.output_mapping,
            on_error: (origNode as Record<string, unknown>)?.on_error ?? "fail",
          } : {}),
        },
        ...(isInnerSubWorkflow ? {
          style: nestedLayout
            ? { width: nestedLayout.containerWidth, height: nestedLayout.containerHeight }
            : { width: 280, height: 120 },
        } : {}),
      })

      // Create nested child nodes for sub_workflow containers with resolved children
      if (nestedLayout) {
        // Sub-workflow header is taller than loop header (has badges), use larger offset
        const SUB_WF_HEADER_HEIGHT = 65
        const swContainerPos = {
          x: containerPos.x + (containerSize.width - nestedLayout.containerWidth) / 2,
          y: containerPos.y + HEADER_HEIGHT + rawPos.y,
        }
        for (const childWfNode of nestedLayout.childNodes) {
          const childPos = nestedLayout.positions[childWfNode.id] ?? { x: 0, y: 0 }
          const childOrigId = childWfNode.id.slice(innerWfNode.id.length + 1)
          allInnerNodes.push({
            id: childWfNode.id,
            type: childWfNode.type,
            position: {
              x: swContainerPos.x + childPos.x,
              y: swContainerPos.y + SUB_WF_HEADER_HEIGHT + childPos.y,
            },
            data: {
              id: childWfNode.id,
              type: childWfNode.type,
              name: childOrigId,
              command: childWfNode.command,
              script: childWfNode.script,
              prompt: childWfNode.prompt,
              risk_level: childWfNode.risk_level,
            },
          })
        }
        allInnerEdges.push(...nestedLayout.edges)
      }
    }

    allInnerEdges.push(...data.edges)
  }

  // ─── Build final nodes array ───
  const nodes: Node[] = topWorkflowNodes.map((node) => {
    const isContainerWithInner = containerNodesWithInner.has(node.id)
    const containerSize = containerSizes.get(node.id)

    // Determine node type for ReactFlow rendering:
    // - loop with inner nodes → "loop-container"
    // - sub_workflow / dynamic_sub_workflow (always) → "sub-workflow-container" (even without inner nodes)
    // - everything else → original type
    const isSubWorkflow = node.type === "sub_workflow" || node.type === "dynamic_sub_workflow"
    const containerType = isContainerWithInner
      ? isSubWorkflow ? "sub-workflow-container" : "loop-container"
      : isSubWorkflow
        ? "sub-workflow-container"
        : node.type

    // Default dimensions for sub_workflow without inner nodes
    const defaultSubWfWidth = 280
    const defaultSubWfHeight = 120

    const baseNode: Node = {
      id: node.id,
      type: containerType,
      position: topPositions[node.id] || { x: 0, y: 0 },
      data: {
        id: node.id,
        type: containerType,
        name: node.description || node.id,
        command: node.command,
        script: node.script,
        prompt: node.prompt,
        // goal-mode agent nodes (task-dev develop etc.) carry `goal` instead of
        // `prompt` — without this the node's middle content renders blank.
        goal: node.goal,
        risk_level: node.risk_level,
        iterations: node.iterations,
        loop_body: node.loop_body,
        cases: node.cases,
        // sub_workflow specific data
        ...(isSubWorkflow ? {
          workflow: (node as Record<string, unknown>).workflow,
          execution_mode: (node as Record<string, unknown>).execution_mode ?? "inline",
          input_mapping: (node as Record<string, unknown>).input_mapping,
          output_mapping: (node as Record<string, unknown>).output_mapping,
          on_error: (node as Record<string, unknown>).on_error ?? "fail",
          is_dynamic: node.type === "dynamic_sub_workflow",
        } : {}),
        ...(node.type === "swarm" ? {
          mode: (node as Record<string, unknown>).mode,
          topic: (node as Record<string, unknown>).topic,
          expertCount: Array.isArray((node as Record<string, unknown>).experts)
            ? ((node as Record<string, unknown>).experts as unknown[]).length
            : ((node as Record<string, unknown>).max_experts as number) ?? 0,
          consensusScore: null,
          status: "pending",
        } : {}),
        ...(node.type === "octopus_agent" ? {
          agent: (node as Record<string, unknown>).agent,
          version: (node as Record<string, unknown>).version,
          task_brief: ((node as Record<string, unknown>).task as Record<string, unknown> | undefined)?.brief,
        } : {}),
        ...(isContainerWithInner && containerSize ? {
          containerWidth: containerSize.width,
          containerHeight: containerSize.height,
        } : {}),
      },
      ...(isContainerWithInner && containerSize ? {
        style: {
          width: containerSize.width,
          height: containerSize.height,
        },
      } : isSubWorkflow ? {
        // sub_workflow without inner nodes — use default dimensions
        style: { width: defaultSubWfWidth, height: defaultSubWfHeight },
      } : {}),
    }

    return baseNode
  })

  nodes.push(...allInnerNodes)

  return { nodes, edges: [...outerEdges, ...allInnerEdges] }
}