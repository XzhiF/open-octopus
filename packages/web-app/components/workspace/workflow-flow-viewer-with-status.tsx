"use client"

import { useCallback, useMemo, useState } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Info, Network } from "lucide-react"

import { BashNode } from "./workflow-nodes/bash-node"
import { PythonNode } from "./workflow-nodes/python-node"
import { AgentNode } from "./workflow-nodes/agent-node"
import { ConditionNode } from "./workflow-nodes/condition-node"
import { ApprovalNode } from "./workflow-nodes/approval-node"
import { LoopNode } from "./workflow-nodes/loop-node"
import { LoopContainerNode } from "./workflow-nodes/loop-container-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { ConditionEdge } from "./workflow-edges/condition-edge"
import { WorkflowStepEdge } from "./workflow-edges/workflow-step-edge"

import { parseYaml } from "@/lib/yaml-utils"
import { yamlToFlowData } from "@/lib/workflow-parser"
import type { StepExecution, StatusOverlay, TokenUsage } from "@/lib/types"

interface WorkflowFlowViewerWithStatusProps {
  yamlContent: string
  executionSteps: StepExecution[]
  activeStepId?: string | null
  currentStepId?: string | null
  onNodeClick?: (stepId: string) => void
  onNodeContextMenu?: (stepId: string, nodeType: string) => void
  onSwarmClick?: (stepId: string) => void
  workspaceId?: string
  executionId?: string
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
  workflowStep: WorkflowStepEdge,
}

export function WorkflowFlowViewerWithStatus({
  yamlContent,
  executionSteps,
  activeStepId,
  currentStepId,
  onNodeClick,
  onNodeContextMenu,
  onSwarmClick,
  workspaceId,
  executionId,
}: WorkflowFlowViewerWithStatusProps) {
  const [contextMenu, setContextMenu] = useState<{
    stepId: string
    nodeType: string
    x: number
    y: number
  } | null>(null)

  const stepMap = useMemo(() => {
    const map = new Map<string, StepExecution>()
    for (const step of executionSteps ?? []) {
      map.set(step.stepId, step)
    }
    return map
  }, [executionSteps])

  const flowData = useMemo(() => {
    const parsed = parseYaml(yamlContent)
    if (!parsed) return null
    const data = yamlToFlowData(parsed)
    if (!data) return null

    const enrichedNodes: Node[] = data.nodes.map((node) => {
      const step = stepMap.get(node.id)
        ?? (node.id.includes(":") ? stepMap.get(node.id.split(":")[1]) : undefined)
      const statusOverlay: StatusOverlay | undefined = step
        ? {
            stepStatus: step.status,
            duration: step.duration,
            startedAt: step.startedAt,
            error: step.error,
            tokenUsage: ((step.tokensInput ?? 0) > 0 || (step.tokensOutput ?? 0) > 0)
              ? {
                  model: step.model ?? "",
                  inputTokens: step.tokensInput ?? 0,
                  outputTokens: step.tokensOutput ?? 0,
                }
              : undefined,
            tokenUsages: step.tokenUsages && step.tokenUsages.length > 0
              ? step.tokenUsages
              : undefined,
          }
        : undefined

      return {
        ...node,
        data: {
          ...node.data,
          statusOverlay,
          isCurrent: currentStepId === node.id,
          isActive: activeStepId === node.id,
          // Pass workspace/execution context to swarm nodes for SSE + replay
          ...(node.type === "swarm" ? { workspaceId, executionId } : {}),
        },
      }
    })

    const enrichedEdges: Edge[] = data.edges.map((edge) => {
      const sourceStep = stepMap.get(edge.source)
      return {
        ...edge,
        type: edge.type === "condition" ? "condition" : "workflowStep",
        data: {
          ...edge.data,
          sourceStepStatus: sourceStep?.status ?? "pending",
        },
      }
    })

    return { nodes: enrichedNodes, edges: enrichedEdges }
  }, [yamlContent, stepMap, activeStepId, currentStepId])

  const onInit = useCallback((instance: unknown) => {
    setTimeout(() => {
      (instance as { fitView: (opts?: { padding?: number }) => void }).fitView({ padding: 0.2 })
    }, 50)
  }, [])

  // Left-click: only swarm nodes trigger a callback (open swarm dialog)
  const handleNodeClick: NodeMouseHandler<Node> = useCallback((_event, node) => {
    if (node.type === "swarm") {
      onSwarmClick?.(node.id)
    }
    // Non-swarm nodes: no action on left-click
  }, [onSwarmClick])

  // Right-click: open context menu for any node
  const handleNodeContextMenu: NodeMouseHandler<Node> = useCallback((event, node) => {
    event.preventDefault()
    setContextMenu({
      stepId: node.id,
      nodeType: node.type ?? "unknown",
      x: (event as unknown as MouseEvent).clientX,
      y: (event as unknown as MouseEvent).clientY,
    })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  if (!flowData) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        {yamlContent ? "该 YAML 未包含 workflow 定义" : "暂无工作流内容"}
      </div>
    )
  }

  return (
    <div className="h-full w-full" onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={flowData.nodes}
        edges={flowData.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onInit={onInit}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#333" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* Right-click context menu */}
      {contextMenu && (
        <DropdownMenu open={true} onOpenChange={(open) => !open && closeContextMenu()}>
          <DropdownMenuTrigger asChild>
            <div style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => {
              onNodeContextMenu?.(contextMenu.stepId, contextMenu.nodeType)
              closeContextMenu()
            }}>
              <Info className="mr-2 h-4 w-4" />
              查看信息
            </DropdownMenuItem>
            {contextMenu.nodeType === "swarm" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  onSwarmClick?.(contextMenu.stepId)
                  closeContextMenu()
                }}>
                  <Network className="mr-2 h-4 w-4" />
                  Swarm 信息
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
