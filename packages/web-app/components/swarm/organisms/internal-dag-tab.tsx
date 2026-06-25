"use client"

import { useCallback, useMemo } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import dagre from "@dagrejs/dagre"
import { DispatchDagNode } from "../molecules/dispatch-dag-node"
import type { TaskBreakdown, ExpertInfo } from "@/lib/swarm-types"

export interface InternalDagTabProps {
  taskBreakdown: TaskBreakdown | null
  experts: ExpertInfo[]
  onNodeClick?: (role: string) => void
}

const DAGRE_NODE_WIDTH = 180
const DAGRE_NODE_HEIGHT = 60

const nodeTypes = {
  dispatchExpert: DispatchDagNode,
}

export function InternalDagTab({ taskBreakdown, experts, onNodeClick }: InternalDagTabProps) {
  const { nodes, edges } = useMemo(() => {
    if (!taskBreakdown) return { nodes: [] as Node[], edges: [] as Edge[] }

    const expertMap = new Map(experts.map(e => [e.role, e]))
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 })
    g.setDefaultEdgeLabel(() => ({}))

    const allRoles = new Set<string>()
    for (const level of taskBreakdown.dag.levels) {
      for (const role of level) {
        allRoles.add(role)
      }
    }

    for (const role of allRoles) {
      g.setNode(role, { width: DAGRE_NODE_WIDTH, height: DAGRE_NODE_HEIGHT })
    }

    for (const expertDef of taskBreakdown.experts) {
      for (const dep of expertDef.dependsOn) {
        g.setEdge(dep, expertDef.role)
      }
    }

    dagre.layout(g)

    const flowNodes: Node[] = []
    for (const role of allRoles) {
      const pos = g.node(role)
      const expert = expertMap.get(role)
      flowNodes.push({
        id: role,
        type: "dispatchExpert",
        position: { x: pos.x - DAGRE_NODE_WIDTH / 2, y: pos.y - DAGRE_NODE_HEIGHT / 2 },
        data: {
          role,
          status: expert?.status ?? "pending",
          level: taskBreakdown.experts.find(e => e.role === role)?.level ?? 0,
        },
      })
    }

    const flowEdges: Edge[] = []
    for (const expertDef of taskBreakdown.experts) {
      for (const dep of expertDef.dependsOn) {
        flowEdges.push({
          id: `e-${dep}-${expertDef.role}`,
          source: dep,
          target: expertDef.role,
          type: "smoothstep",
          style: { stroke: "var(--border)", strokeWidth: 1.5 },
          markerEnd: {
            type: "arrowclosed",
            color: "var(--border)",
            width: 10,
            height: 10,
          },
        })
      }
    }

    return { nodes: flowNodes, edges: flowEdges }
  }, [taskBreakdown, experts])

  const handleNodeClick: NodeMouseHandler<Node> = useCallback((_event, node) => {
    onNodeClick?.(node.id)
  }, [onNodeClick])

  if (!taskBreakdown) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        暂无任务分解数据
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        DAG 为空
      </div>
    )
  }

  return (
    <div className="w-full h-[400px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
