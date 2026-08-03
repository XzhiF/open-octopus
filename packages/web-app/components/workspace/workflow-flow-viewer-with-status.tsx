"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
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
import { InteractionNode } from "./workflow-nodes/interaction-node"
import { LoopNode } from "./workflow-nodes/loop-node"
import { LoopContainerNode } from "./workflow-nodes/loop-container-node"
import { SubWorkflowContainerNode } from "./workflow-nodes/sub-workflow-container-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { ConditionEdge } from "./workflow-edges/condition-edge"
import { WorkflowStepEdge } from "./workflow-edges/workflow-step-edge"

import { parseYaml } from "@/lib/yaml-utils"
import { yamlToFlowData } from "@/lib/workflow-parser"
import { getServerUrl } from "@/lib/server-config"
import type { StepExecution, StatusOverlay, TokenUsage, LoopIterationSummary } from "@/lib/types"

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
  loopIterationsMap?: Map<string, LoopIterationSummary>
}

const nodeTypes = {
  bash: BashNode,
  python: PythonNode,
  agent: AgentNode,
  condition: ConditionNode,
  approval: ApprovalNode,
  interaction: InteractionNode,
  "loop-container": LoopContainerNode,
  "sub-workflow-container": SubWorkflowContainerNode,
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
  loopIterationsMap,
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

      // For iteration-suffixed steps (e.g., "call-analysis:prepare-iter0"),
      // also map to the base ID ("call-analysis:prepare") so flow-viewer can
      // find status overlays for per-iteration DB records.
      // Aggregate: running > failed > last-completed
      const iterMatch = step.stepId.match(/^(.+)-iter\d+$/)
      if (iterMatch) {
        const baseId = iterMatch[1]
        const existing = map.get(baseId)
        if (!existing || existing.status === "completed" || existing.status === "pending") {
          map.set(baseId, step)
        } else if (existing.status === "running" && step.status !== "running") {
          // Keep "running" over completed — at least one iteration is still active
        } else if (step.status === "running" || step.status === "failed") {
          map.set(baseId, step)
        }
      }
    }
    return map
  }, [executionSteps])

  // Pre-fetch sub-workflow child nodes for container rendering
  // Recursively scans all nodes including those nested inside loops
  const [subWorkflowNodes, setSubWorkflowNodes] = useState<Record<string, any[]>>({})
  useEffect(() => {
    const parsed = parseYaml(yamlContent)
    if (!parsed?.nodes) return

    // Recursively collect all sub_workflow references
    const collectRefs = (nodes: Array<Record<string, unknown>>): string[] => {
      const refs: string[] = []
      for (const n of nodes) {
        if (n.type === "sub_workflow" && n.workflow) {
          refs.push(n.workflow as string)
        }
        if (Array.isArray(n.nodes)) {
          refs.push(...collectRefs(n.nodes as Array<Record<string, unknown>>))
        }
      }
      return refs
    }

    const refs = collectRefs(parsed.nodes as Array<Record<string, unknown>>)
    if (refs.length === 0 || !workspaceId) return

    const fetchAll = async () => {
      const results: Record<string, any[]> = {}
      await Promise.all(
        refs.map(async (ref: string) => {
          try {
            const res = await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/workflows/${encodeURIComponent(ref)}`)
            if (res.ok) {
              const data = await res.json()
              if (data.parsed?.nodes) {
                results[ref] = data.parsed.nodes
              }
            }
          } catch { /* non-fatal: container will render empty */ }
        }),
      )
      setSubWorkflowNodes(results)
    }
    fetchAll()
  }, [yamlContent, workspaceId])

  const flowData = useMemo(() => {
    const parsed = parseYaml(yamlContent)
    if (!parsed) return null
    const data = yamlToFlowData(parsed, subWorkflowNodes)
    if (!data) return null

    const enrichedNodes: Node[] = data.nodes.map((node) => {
      let step = stepMap.get(node.id)
        ?? (node.id.includes(":") ? stepMap.get(node.id.slice(node.id.indexOf(":") + 1)) : undefined)

      // For inner loop nodes with "skipped" status, derive actual status from loopIterations
      if (step?.status === "skipped" && node.id.includes(":") && loopIterationsMap) {
        const loopId = node.id.slice(0, node.id.indexOf(":"))
        const innerNodeId = node.id.slice(node.id.indexOf(":") + 1)
        const loopSummary = loopIterationsMap.get(loopId)
        if (loopSummary?.iterations?.length) {
          // Find the latest non-skipped status for this inner node across iterations
          // Priority: running > completed > failed > skipped/pending
          let bestNodeResult: { status: string; durationMs?: number } | null = null

          // Check completed iterations first (from branch_end events)
          for (let i = loopSummary.iterations.length - 1; i >= 0; i--) {
            const iter = loopSummary.iterations[i]
            const nodeResult = iter?.nodes?.find(n => n.nodeId === innerNodeId)
            if (nodeResult && nodeResult.status !== "skipped") {
              bestNodeResult = nodeResult
              break
            }
          }

          // If no completed data but loop is currently running, infer running status
          // for nodes that would be executing in the current iteration
          if (!bestNodeResult && loopSummary.current) {
            const currentIter = loopSummary.iterations.find(it => it.iteration === loopSummary.current)
            if (currentIter?.status === "running") {
              // Check if this node has started (from events) or assume running
              // For simplicity, mark as running if it's the first/only inner node
              // or if we're in the middle of the loop
              bestNodeResult = { status: "running" }
            }
          }

          if (bestNodeResult && bestNodeResult.status !== "skipped") {
            step = {
              ...step,
              status: bestNodeResult.status as StepExecution["status"],
              duration: bestNodeResult.durationMs ? bestNodeResult.durationMs / 1000 : undefined,
            }
          }
        }
      }

      // Compute duration: prefer step.duration, fall back to startedAt/completedAt
      let effectiveDuration = step?.duration
      if (step && (!effectiveDuration || effectiveDuration <= 0) && step.startedAt && step.completedAt) {
        effectiveDuration = (new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000
      }

      const statusOverlay: StatusOverlay | undefined = step
        ? {
            stepStatus: step.status,
            duration: effectiveDuration,
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
  }, [yamlContent, stepMap, activeStepId, currentStepId, workspaceId, executionId, loopIterationsMap, subWorkflowNodes])

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
