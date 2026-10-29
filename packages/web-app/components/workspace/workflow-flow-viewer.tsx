"use client"

import { useMemo } from "react"
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
import { InteractionNode } from "./workflow-nodes/interaction-node"
import { LoopNode } from "./workflow-nodes/loop-node"
import { LoopContainerNode } from "./workflow-nodes/loop-container-node"
import { SubWorkflowContainerNode } from "./workflow-nodes/sub-workflow-container-node"
import { OctopusAgentNode } from "./workflow-nodes/octopus-agent-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { ConditionEdge } from "./workflow-edges/condition-edge"
import { useDagAutoFit, USER_MIN_ZOOM } from "./use-dag-auto-fit"

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
  interaction: InteractionNode,
  "loop-container": LoopContainerNode,
  loop: LoopNode,
  swarm: SwarmNode,
  "sub-workflow-container": SubWorkflowContainerNode,
  sub_workflow: SubWorkflowContainerNode,
  dynamic_sub_workflow: SubWorkflowContainerNode,
  octopus_agent: OctopusAgentNode,
}

const edgeTypes = {
  condition: ConditionEdge,
}

export function WorkflowFlowViewer({ nodes, edges, isEmpty }: WorkflowFlowViewerProps) {
  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep",
      style: { stroke: "#9698A3", strokeWidth: 2 },
    }),
    []
  )

  // 横向主干的图是宽扁形状：pane 被挤矮后旧的 fitView 会把两端裁掉，交给这个 hook 兜底。
  const { containerRef, onInit } = useDagAutoFit<HTMLDivElement>({ contentKey: nodes.length })

  if (isEmpty) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        该 YAML 未包含 workflow 定义
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full w-full">
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
        minZoom={USER_MIN_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#32323B" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}