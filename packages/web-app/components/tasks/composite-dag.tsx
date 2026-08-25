"use client"

import { useMemo, useCallback } from "react"
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
import { cn } from "@/lib/utils"
import { Handle, Position } from "@xyflow/react"
import type { JobDetailDag, JobDetailChild } from "@/lib/scheduler-api"

export interface CompositeDagProps {
  dag: JobDetailDag
  children: JobDetailChild[]
  /** Parent (integration) status — drives the integration node appearance. */
  integrationStatus: string
  /** Called when a subunit node is clicked; receives the node id (subunit name). */
  onChildClick?: (subunitName: string) => void
}

const DAGRE_NODE_WIDTH = 170
const DAGRE_NODE_HEIGHT = 64

const STATUS_TONE: Record<string, string> = {
  queued: "border-blue-500/60 bg-blue-500/5",
  claimed: "border-amber-500/60 bg-amber-500/5",
  running: "border-blue-500/60 bg-blue-500/5",
  done: "border-emerald-500/60 bg-emerald-500/5",
  failed: "border-red-500/60 bg-red-500/5",
  aborted: "border-zinc-500/60 bg-zinc-500/5",
}

const STATUS_DOT: Record<string, string> = {
  queued: "bg-blue-500",
  claimed: "bg-amber-500",
  running: "bg-blue-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  aborted: "bg-zinc-500",
}

const STATUS_LABEL: Record<string, string> = {
  queued: "待执行", claimed: "已认领", running: "执行中",
  done: "完成", failed: "失败", aborted: "已中止", pending: "等待",
}

/** Custom ReactFlow node for a composition subunit / integration node. */
function DagNode({ data }: { data: Record<string, unknown> }) {
  const { label, status, kind, workflowRef } = data as {
    label: string
    status: string
    kind: "subunit" | "integration"
    workflowRef?: string
  }
  const tone = STATUS_TONE[status] ?? "border-border bg-card"
  return (
    <div
      className={cn(
        "rounded-md border-2 px-3 py-2 min-w-[150px] max-w-[190px] shadow-sm",
        tone,
        kind === "integration" && "border-dashed"
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-1.5 !h-1.5" />
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full shrink-0", STATUS_DOT[status] ?? "bg-muted-foreground")} />
        <span className="text-xs font-medium truncate flex-1">{label}</span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-muted-foreground">
          {kind === "integration" ? "聚合" : workflowRef ? workflowRef : "—"}
        </span>
        <span className="text-[10px] text-muted-foreground">{STATUS_LABEL[status] ?? status}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-1.5 !h-1.5" />
    </div>
  )
}

const nodeTypes = { composite: DagNode }

/** Layout the composition DAG with dagre (left-to-right) and return ReactFlow
 *  nodes/edges. Pure function — extracted so the component is a thin renderer. */
export function layoutCompositionDag(
  dag: JobDetailDag,
  children: JobDetailChild[],
  integrationStatus: string
): { nodes: Node[]; edges: Edge[] } {
  const childBySubunit = new Map(children.map((c) => [c.subunit_name, c]))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of dag.nodes) {
    g.setNode(node.id, { width: DAGRE_NODE_WIDTH, height: DAGRE_NODE_HEIGHT })
  }
  for (const edge of dag.edges) {
    g.setEdge(edge.from, edge.to)
  }
  dagre.layout(g)

  const nodes: Node[] = dag.nodes.map((n) => {
    const pos = g.node(n.id)
    const status =
      n.type === "integration"
        ? integrationStatus
        : childBySubunit.get(n.id)?.status ?? "pending"
    return {
      id: n.id,
      type: "composite",
      position: { x: pos.x - DAGRE_NODE_WIDTH / 2, y: pos.y - DAGRE_NODE_HEIGHT / 2 },
      data: {
        label: n.label,
        status,
        kind: n.type,
        workflowRef: n.workflow_ref,
      },
    }
  })

  const edges: Edge[] = dag.edges.map((e, i) => ({
    id: `e-${i}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    type: "smoothstep",
    style: { stroke: "var(--border)", strokeWidth: 1.5 },
    markerEnd: { type: "arrowclosed", color: "var(--border)", width: 10, height: 10 },
  }))

  return { nodes, edges }
}

export function CompositeDag({ dag, children, integrationStatus, onChildClick }: CompositeDagProps) {
  const { nodes, edges } = useMemo(
    () => layoutCompositionDag(dag, children, integrationStatus),
    [dag, children, integrationStatus]
  )

  const handleNodeClick: NodeMouseHandler<Node> = useCallback(
    (_event, node) => {
      // Only subunit nodes are drill-down targets (integration has no schedule).
      const def = dag.nodes.find((n) => n.id === node.id)
      if (def?.type === "subunit") onChildClick?.(node.id)
    },
    [dag, onChildClick]
  )

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        DAG 为空
      </div>
    )
  }

  return (
    <div className="w-full h-[260px]" data-testid="composite-dag-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
