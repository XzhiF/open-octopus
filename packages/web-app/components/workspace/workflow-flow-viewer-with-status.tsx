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
import { OctopusAgentNode } from "./workflow-nodes/octopus-agent-node"
import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { ConditionEdge } from "./workflow-edges/condition-edge"
import { WorkflowStepEdge } from "./workflow-edges/workflow-step-edge"

import { parseYaml } from "@/lib/yaml-utils"
import { yamlToFlowData } from "@/lib/workflow-parser"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"
import { useExecutionEvents } from "@/hooks/use-execution-events"
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
  sub_workflow: SubWorkflowContainerNode,
  dynamic_sub_workflow: SubWorkflowContainerNode,
  loop: LoopNode,
  swarm: SwarmNode,
  octopus_agent: OctopusAgentNode,
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

  // Derive execution status from steps for heartbeat polling
  const derivedStatus = useMemo(() => {
    if (executionSteps.some(s => s.status === "running")) return "running"
    if (executionSteps.some(s => s.status === "paused")) return "paused"
    return "completed"
  }, [executionSteps])

  // Poll agent-events for heartbeat data (used to inject into octopus_agent statusOverlay)
  const { heartbeat: polledHeartbeat } = useExecutionEvents(
    workspaceId ?? "",
    executionId ?? "",
    derivedStatus,
  )

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

  // Track how many sub-workflows we've successfully resolved — re-fetch when
  // executionSteps change and some dynamic sub-workflows are still unresolved
  // (the child YAML is generated at runtime by dynamic_sub_workflow executor)
  const stepCountKey = executionSteps.length

  // Bump a counter when SSE runtime_node_added fires for this execution
  // so we refetch dynamic sub-workflow YAMLs immediately (not waiting for poll)
  const [runtimeNodeVersion, setRuntimeNodeVersion] = useState(0)
  useEffect(() => {
    if (!workspaceId || !executionId) return
    return subscribeSSE(
      `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`,
      "runtime_node_added",
      (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.executionId === executionId) {
            setRuntimeNodeVersion(v => v + 1)
          }
        } catch { /* ignore */ }
      },
    )
  }, [workspaceId, executionId])

  useEffect(() => {
    const parsed = parseYaml(yamlContent)
    if (!parsed?.nodes) return

    // Recursively collect all sub_workflow references
    // Track which refs are dynamic (generated at runtime) vs static
    // Note: dynamic_sub_workflow generated files have executionId in filename,
    // so only fetch them when executionId is available (not in preview mode)
    const collectRefs = (nodes: Array<Record<string, unknown>>, parentPath = ""): Array<{ ref: string; isDynamic: boolean }> => {
      const refs: Array<{ ref: string; isDynamic: boolean }> = []
      for (const n of nodes) {
        if (n.type === "sub_workflow" && n.workflow) {
          refs.push({ ref: n.workflow as string, isDynamic: false })
        }
        // Collect dynamic_sub_workflow refs from:
        // 1. Static workflow field in YAML (if specified)
        // 2. Runtime outputs.generated_workflow from execution steps
        if (n.type === "dynamic_sub_workflow" && executionId) {
          if (n.workflow) {
            refs.push({ ref: n.workflow as string, isDynamic: true })
          }
          // Look up generated_workflow from step outputs (handles runtime DAG generation)
          const nodeId = n.id as string
          if (nodeId) {
            let foundGenWf = false
            for (const [stepId, step] of stepMap.entries()) {
              // Match base nodeId or iteration-suffixed (e.g. "spec-dag-execute-iter0")
              if (stepId === nodeId || stepId.startsWith(`${nodeId}-iter`)) {
                const genWf = (step.outputs as Record<string, unknown>)?.generated_workflow
                if (typeof genWf === "string" && genWf) {
                  refs.push({ ref: genWf, isDynamic: true })
                  foundGenWf = true
                }
              }
            }
            // Fallback: while the dynamic_sub_workflow node is RUNNING, its
            // outputs.generated_workflow is not yet in the DB (only written on
            // node_end). Derive the snapshot name from scoped child steps
            // (e.g. "spec-dag-execute:T-1-iter0" → iter0) and construct the
            // default-name snapshot the executor persists to disk, so the child
            // DAG can be fetched and shown during execution.
            if (!foundGenWf) {
              const escId = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              const iterRe = new RegExp(`^${escId}:.*-iter(\\d+)$`)
              const iters = new Set<string>()
              let hasScoped = false
              for (const stepId of stepMap.keys()) {
                const m = stepId.match(iterRe)
                if (m) { iters.add(m[1]); hasScoped = true }
                else if (stepId.startsWith(`${nodeId}:`)) hasScoped = true
              }
              for (const iter of iters) {
                refs.push({ ref: `workflow__${nodeId}-iter${iter}`, isDynamic: true })
              }
              if (iters.size === 0 && hasScoped) {
                refs.push({ ref: `workflow__${nodeId}`, isDynamic: true })
              }
            }
          }
        }
        if (Array.isArray(n.nodes)) {
          refs.push(...collectRefs(n.nodes as Array<Record<string, unknown>>, `${parentPath}${n.id}.`))
        }
      }
      return refs
    }

    const allRefs = collectRefs(parsed.nodes as Array<Record<string, unknown>>)
    // Deduplicate refs (multiple iterations may generate different workflow names)
    const seen = new Set<string>()
    const refInfos = allRefs.filter(r => { if (seen.has(r.ref)) return false; seen.add(r.ref); return true })
    if (refInfos.length === 0 || !workspaceId) return

    // Skip refs we already resolved successfully
    const unresolvedRefs = refInfos.filter(info => !subWorkflowNodes[info.ref])
    if (unresolvedRefs.length === 0 && stepCountKey === (subWorkflowNodes.__stepCount as number ?? -1)) return

    const fetchAll = async () => {
      const results: Record<string, any[]> = { ...subWorkflowNodes }
      await Promise.all(
        refInfos.map(async (info) => {
          try {
            // For dynamic_sub_workflow, add isDynamic=true to prevent fallback to workflows/
            // (should only use execution-scoped snapshot, return empty if not yet generated)
            const params = new URLSearchParams()
            if (executionId) params.set("executionId", executionId)
            if (info.isDynamic) params.set("isDynamic", "true")
            const queryString = params.toString()
            const url = `${getServerUrl()}/api/workspaces/${workspaceId}/workflows/${encodeURIComponent(info.ref)}${queryString ? `?${queryString}` : ""}`

            const res = await fetch(url)
            if (res.ok) {
              const data = await res.json()
              if (data.parsed?.nodes) {
                results[info.ref] = data.parsed.nodes
              }
            }
          } catch { /* non-fatal: container will render empty */ }
        }),
      )
      results.__stepCount = stepCountKey as any
      setSubWorkflowNodes(results)
    }
    fetchAll()
  }, [yamlContent, workspaceId, executionId, stepCountKey, stepMap, runtimeNodeVersion])

  const flowData = useMemo(() => {
    const parsed = parseYaml(yamlContent)
    if (!parsed) return null

    // Inject generated_workflow from step outputs into YAML nodes so
    // yamlToFlowData can look up child nodes in subWorkflowNodes.
    // dynamic_sub_workflow nodes don't have a static workflow field —
    // the DAG is generated at runtime and stored in outputs.generated_workflow.
    if (Array.isArray(parsed.nodes)) {
      for (const n of parsed.nodes) {
        if (n.type === "dynamic_sub_workflow" && !n.workflow) {
          const step = stepMap.get(n.id)
          const genWf = (step?.outputs as Record<string, unknown>)?.generated_workflow
          if (typeof genWf === "string" && genWf) {
            n.workflow = genWf
          }
        }
        // Also inject for nested nodes inside loops
        if (Array.isArray(n.nodes)) {
          for (const inner of n.nodes) {
            if (inner.type === "dynamic_sub_workflow" && !inner.workflow) {
              const step = stepMap.get(inner.id)
              const genWf = (step?.outputs as Record<string, unknown>)?.generated_workflow
              if (typeof genWf === "string" && genWf) {
                inner.workflow = genWf
              }
            }
          }
        }
      }
    }

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
            // Inject heartbeat for octopus_agent nodes from polled agent-events
            heartbeat: node.type === "octopus_agent" ? polledHeartbeat : undefined,
            // Harness status from step data
            harnessStatus: step.harnessStatus,
          }
        : undefined

      return {
        ...node,
        data: {
          ...node.data,
          statusOverlay,
          isCurrent: currentStepId === node.id,
          isActive: activeStepId === node.id,
          // Pass harness status directly to node data for HarnessStatusIndicator
          harnessStatus: step?.harnessStatus,
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
  }, [yamlContent, stepMap, activeStepId, currentStepId, workspaceId, executionId, loopIterationsMap, subWorkflowNodes, polledHeartbeat])

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
        key={`rf-${flowData.nodes.length}`}
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
