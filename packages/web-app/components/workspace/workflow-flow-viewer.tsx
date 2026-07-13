"use client"

import { useCallback, useMemo } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { BashNode } from "./workflow-nodes/bash-node"
import { PythonNode } from "./workflow-nodes/python-node"
import { AgentNode } from "./workflow-nodes/agent-node"
import { ConditionNode } from "./workflow-nodes/condition-node"
import { ApprovalNode } from "./workflow-nodes/approval-node"
import { LoopNode } from "./workflow-nodes/loop-node"
import { LoopContainerNode } from "./workflow-nodes/loop-container-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { ConditionEdge } from "./workflow-edges/condition-edge"

interface WorkflowFlowViewerProps {
  nodes: Node[]
  edges: Edge[]
  isEmpty?: boolean
}

const nodeTypes = {
  bash: BashNode,
  python: PythonNode,
  agent: AgentNode,
  condition: ConditionNode,
  approval: ApprovalNode,
  "loop-container": LoopContainerNode,
  loop: LoopNode,
  swarm: SwarmNode,
}

const edgeTypes = {
  condition: ConditionEdge,
}

export function WorkflowFlowViewer({ nodes, edges, isEmpty }: WorkflowFlowViewerProps) {
  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep",
      style: { stroke: "#6b7280", strokeWidth: 2 },
    }),
    []
  )

  const onInit = useCallback((instance: unknown) => {
    setTimeout(() => {
      (instance as { fitView: (opts?: unknown) => void }).fitView({ padding: 0.2 })
    }, 50)
  }, [])

  if (isEmpty) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        该 YAML 未包含 workflow 定义
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onInit={onInit}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#333" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}