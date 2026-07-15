'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { type Node, type Edge, useNodesState, useEdgesState } from '@xyflow/react'
import type { ExecutionStatus, ExecutionTreeNode, GateStatus, CreateNodeFormData, ExecuteNodeFormData, AgentTraceEvent, LoopIterationSummary, IterationDetail } from '@/lib/types'
import { getBranchColor } from '@/lib/branch-colors'
import { fetchExecutionTree, createExecution, startExecution, retryExecution, cancelExecution, skipExecution, deleteExecution } from '@/lib/api-client'
import { getServerUrl } from '@/lib/server-config'
import { pushAgentEvents } from '@/hooks/use-agent-traces'

const DAGRE_NODE_WIDTH = 300
const DAGRE_NODE_HEIGHT = 160

// ---- localStorage ----

const POSITIONS_KEY = (wsId: string) => `octopus:ws:${wsId}:positions`

function loadPositions(wsId: string): Record<string, { x: number; y: number }> {
  if (typeof window === "undefined") return {}
  try { const raw = localStorage.getItem(POSITIONS_KEY(wsId)); return raw ? JSON.parse(raw) : {} } catch { return {} }
}

function savePositions(wsId: string, positions: Record<string, { x: number; y: number }>): void {
  if (typeof window === "undefined") return
  try { localStorage.setItem(POSITIONS_KEY(wsId), JSON.stringify(positions)) } catch { /* quota */ }
}

// ---- dagre ----

function computeDagreLayout(nodes: ExecutionTreeNode[]): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 120, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) g.setNode(node.id, { width: DAGRE_NODE_WIDTH, height: DAGRE_NODE_HEIGHT })
  for (const node of nodes) {
    if (node.parentId && node.parentId !== "0") g.setEdge(node.parentId, node.id)
  }
  dagre.layout(g)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) { const pos = g.node(node.id); positions[node.id] = { x: pos.x, y: pos.y } }
  return positions
}

// ---- types ----

interface TreeCallbackOverrides {
  onExecute?: (nodeId: string) => void
  onRetry?: (nodeId: string) => void
  onSkip?: (nodeId: string) => void
  onDelete?: (nodeId: string) => void
  onApprove?: (nodeId: string) => void
  onPause?: (nodeId: string) => void
  onResume?: (nodeId: string) => void
  isPausing?: (nodeId: string) => boolean
}

// ---- build pure node data (no callbacks) ----

function buildNodeData(node: ExecutionTreeNode, parentGateStatus: GateStatus | null, isLastCompleted: boolean) {
  return {
    id: node.id, parentId: node.parentId, executionId: node.id,
    workflowId: node.workflowId, workflowName: node.workflowName,
    executionStatus: node.executionStatus, gateStatus: node.gateStatus,
    rollback: node.rollbackOnError ? 'git-revert' : 'none',
    progress: node.progress, childrenCount: node.childrenCount,
    isLeaf: node.isLeaf, parentGateStatus,
    startedAt: node.startedAt, triggeredBy: node.triggeredBy,
    name: node.name, workflowRef: node.workflowRef,
    rollbackOnError: node.rollbackOnError, childIndex: node.childIndex,
    inputValues: node.inputValues ?? {},
    branch: node.branch, nodeType: node.nodeType,
    isLastCompleted, completedAt: node.completedAt,
    duration: node.duration,
    branchColor: node.branch ? getBranchColor(node.branch) : null,
    tokenUsages: node.tokenUsages,
    approvalMetadata: node.approvalMetadata,
    executorType: (node as ExecutionTreeNode & { executorType?: string }).executorType,
    costUsd: (node as ExecutionTreeNode & { costUsd?: number }).costUsd,
    turnCount: (node as ExecutionTreeNode & { turnCount?: number }).turnCount,
    toolCount: (node as ExecutionTreeNode & { toolCount?: number }).toolCount,
  }
}

function buildEdges(treeNodes: ExecutionTreeNode[]): Edge[] {
  return treeNodes
    .filter(node => node.parentId && node.parentId !== "0")
    .map(node => {
      const parent = treeNodes.find(n => n.id === node.parentId)
      const status = parent?.executionStatus ?? 'pending'
      // Map status to arrow color
      const colorMap: Record<string, string> = {
        completed: '#10b981',
        running: '#f59e0b',
        failed: '#ef4444',
        paused: '#8b5cf6',
        pending_approval: '#f59e0b',
        rejected: '#ea580c',
        skipped: '#9ca3af',
        cancelled: '#d1d5db',
        pending: '#d1d5db',
      }
      return {
        id: `e-${node.parentId}-${node.id}`,
        source: node.parentId!, target: node.id, type: 'execution',
        data: { executionStatus: status },
        markerEnd: {
          type: 'arrowclosed' as const,
          color: colorMap[status] || '#d1d5db',
          width: 15,
          height: 15,
        },
      }
    })
}

function computeParentGateMap(treeNodes: ExecutionTreeNode[]): Map<string, GateStatus | null> {
  const map = new Map<string, GateStatus | null>()
  for (const node of treeNodes) {
    if (node.parentId && node.parentId !== "0") {
      map.set(node.id, treeNodes.find(n => n.id === node.parentId)?.gateStatus ?? null)
    } else {
      map.set(node.id, null)
    }
  }
  return map
}

// ---- api transform ----

function apiNodeToTreeNode(raw: Record<string, unknown>): ExecutionTreeNode {
  return {
    id: raw.id as string,
    parentId: (raw.parent_id as string) || "0",
    executionId: raw.id as string,
    workflowId: raw.workflow_ref as string,
    workflowName: raw.workflow_name as string,
    executionStatus: raw.status as ExecutionStatus,
    gateStatus: raw.gate_status as GateStatus,
    rollback: (raw.rollback_on_error as number) === 1 ? 'git-revert' : 'none',
    progress: raw.progress as number,
    startedAt: raw.started_at as string ?? "",
    childrenCount: raw.children_count as number,
    isLeaf: (raw.is_leaf as boolean) ?? true,
    triggeredBy: (raw.triggered_by as "manual" | "schedule" | "webhook" | "chat") ?? "manual",
    logs: [], steps: [],
    name: (raw.name as string) || (raw.workflow_name as string),
    workflowRef: raw.workflow_ref as string,
    rollbackOnError: (raw.rollback_on_error as number) === 1,
    childIndex: raw.child_index as number,
    inputValues: raw.input_values ? JSON.parse(raw.input_values as string) : {},
    output: null,
    createdAt: raw.created_at as string ?? new Date().toISOString(),
    updatedAt: raw.updated_at as string ?? new Date().toISOString(),
    workspaceId: raw.workspace_id as string,
    org: raw.org as string ?? 'xzf',
    nodeType: raw.node_type as "normal" | "fork",
    branch: raw.branch as string | undefined,
    startCommitId: raw.start_commit_id as Record<string, string> | undefined,
    endCommitId: raw.end_commit_id as Record<string, string> | undefined,
    completedAt: raw.completed_at as string | undefined,
    duration: raw.duration != null ? (raw.duration as number) / 1000 : undefined,
    tokenUsages: raw.token_usages
      ? (raw.token_usages as Array<{ stepId?: string; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }>)
          .filter(u => u.model && ((u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0))
          .map(u => ({
            model: u.model ?? "",
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadTokens: u.cacheReadTokens ?? 0,
            cacheCreationTokens: u.cacheCreationTokens ?? 0,
          }))
      : undefined,
    approvalMetadata: raw.approval_metadata as import("@/lib/types").ApprovalMetadata | null | undefined,
    executorType: raw.executor_type as ExecutionTreeNode["executorType"],
  }
}

// ---- hook ----

export function useExecutionTree(
  workspaceId: string,
  onDetailCallback?: (node: ExecutionTreeNode) => void,
  callbackOverrides?: TreeCallbackOverrides,
  org?: string,
) {
  const [treeNodes, setTreeNodes] = useState<ExecutionTreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [userPositions, setUserPositions] = useState<Record<string, { x: number; y: number }>>(() => loadPositions(workspaceId))
  const eventSourceRef = useRef<EventSource | null>(null)
  const sseInitialOpenRef = useRef(false)

  // ReactFlow state — onNodesChange handles drag position updates in real-time
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges] = useEdgesState<Edge>([])

  // Track tree structure to detect add/delete vs data-only changes
  const prevTreeIdsRef = useRef<string>("")

  // Loop iteration state keyed by loopNodeId (for P4 consumption)
  const [loopIterations, setLoopIterations] = useState<Map<string, LoopIterationSummary>>(new Map())

  // ---- load ----

  const loadTree = useCallback(async () => {
    setLoading(true)
    const data = await fetchExecutionTree(workspaceId)
    const newTree = (data.nodes ?? []).map(apiNodeToTreeNode)
    setTreeNodes(newTree)
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { loadTree() }, [loadTree])

  // ---- SSE ----

  useEffect(() => {
    sseInitialOpenRef.current = false
    const es = new EventSource(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`)
    eventSourceRef.current = es

    // Detect reconnection: on first open, skip reload; on subsequent opens, refetch tree
    // to sync state that may have been missed during disconnection (e.g. server restart).
    es.addEventListener("open", () => {
      if (!sseInitialOpenRef.current) {
        sseInitialOpenRef.current = true
      } else {
        loadTree()
      }
    })

    es.addEventListener("execution_status", (e) => {
      const { executionId, status } = JSON.parse(e.data)
      setTreeNodes(prev => prev.map(n => n.id === executionId ? { ...n, executionStatus: status as ExecutionStatus } : n))
    })
    es.addEventListener("execution_paused", (e) => {
      const { executionId, nodeId, approval } = JSON.parse(e.data)
      setTreeNodes(prev => prev.map(n => n.id === executionId ? {
        ...n,
        executionStatus: 'paused' as ExecutionStatus,
        approvalMetadata: approval,
      } : n))
    })
    es.addEventListener("execution_pending_approval", (e) => {
      const { executionId, nodeId, approval } = JSON.parse(e.data)
      setTreeNodes(prev => prev.map(n => n.id === executionId ? {
        ...n,
        executionStatus: 'pending_approval' as ExecutionStatus,
        ...(approval ? { approvalMetadata: approval } : {}),
      } : n))
    })
    es.addEventListener("execution_progress", (e) => {
      const { executionId, progress } = JSON.parse(e.data)
      setTreeNodes(prev => prev.map(n => n.id === executionId ? { ...n, progress } : n))
    })
    es.addEventListener("node_start", (e) => {
      const { executionId } = JSON.parse(e.data)
      const startedAt = new Date().toISOString()
      setTreeNodes(prev => prev.map(n => n.id === executionId ? { ...n, startedAt, executionStatus: 'running' as ExecutionStatus } : n))
    })
    es.addEventListener("complete", (e) => {
      const { executionId, finalStatus } = JSON.parse(e.data)
      const isTerminal = finalStatus === 'completed' || finalStatus === 'completed_with_failures' || finalStatus === 'rejected'
      setTreeNodes(prev => prev.map(n => n.id === executionId ? {
        ...n, executionStatus: finalStatus as ExecutionStatus,
        gateStatus: isTerminal ? 'open' as GateStatus : n.gateStatus,
        progress: isTerminal ? 100 : n.progress,
        completedAt: isTerminal ? new Date().toISOString() : n.completedAt,
      } : n))
    })
    es.addEventListener("node_end", (e) => {
      try {
        const data = JSON.parse(e.data)
        const { executionId, durationMs } = data
        const tokenData = data.tokens
        const costUsd = data.costUsd as number | undefined
        const turnCount = data.turnCount as number | undefined
        const toolCount = data.toolCount as number | undefined
        const executorType = data.executorType as ExecutionTreeNode["executorType"]
        // tokenUsagesData is already aggregated per-model SUM across all steps from the server
        const tokenUsagesData = data.tokenUsages as Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }> | undefined
        const aggregatedTokenUsages = tokenUsagesData && tokenUsagesData.length > 0
          ? tokenUsagesData.map(tu => ({
            model: tu.model,
            inputTokens: tu.inputTokens,
            outputTokens: tu.outputTokens,
            cacheReadTokens: tu.cacheReadTokens,
            cacheCreationTokens: tu.cacheCreationTokens,
          }))
          : tokenData ? [{ model: "", inputTokens: tokenData.input ?? 0, outputTokens: tokenData.output ?? 0 }]
          : undefined
        setTreeNodes(prev => prev.map(n => n.id === executionId ? {
          ...n,
          duration: durationMs / 1000,
          ...(aggregatedTokenUsages ? { tokenUsages: aggregatedTokenUsages } : {}),
          ...(costUsd != null ? { costUsd } : {}),
          ...(turnCount != null ? { turnCount } : {}),
          ...(toolCount != null ? { toolCount } : {}),
          ...(executorType ? { executorType } : {}),
        } : n))
      } catch { /* skip malformed event */ }
    })

    // Agent event — batch push for live timeline updates
    es.addEventListener("agent_event", (e) => {
      try {
        const { executionId, nodeId, event } = JSON.parse(e.data) as { executionId: string; nodeId: string; event: AgentTraceEvent }
        pushAgentEvents([{ executionId, nodeId, event }])
      } catch { /* skip malformed event */ }
    })
    es.addEventListener("branch_start", (e) => {
      try {
        const { executionId, nodeExecutionId, iteration } = JSON.parse(e.data)
        // nodeExecutionId encodes the loop node — extract loop part
        const loopId = nodeExecutionId?.split("-iter-")[0] ?? executionId
        setLoopIterations(prev => {
          const next = new Map(prev)
          const existing = next.get(loopId) ?? {
            completed: 0, failed: 0, current: 0, mode: "fixed" as const, iterations: [],
          }
          const iterDetail: IterationDetail = {
            iteration,
            status: "running",
            startedAt: new Date().toISOString(),
            nodes: [],
          }
          const updatedIterations = existing.iterations.filter(i => i.iteration !== iteration)
          updatedIterations.push(iterDetail)
          next.set(loopId, {
            ...existing,
            current: iteration,
            iterations: updatedIterations,
          })
          return next
        })
      } catch { /* skip */ }
    })
    es.addEventListener("branch_end", (e) => {
      try {
        const { executionId, nodeExecutionId, iteration, status, durationMs, nodeResults } = JSON.parse(e.data)
        const loopId = nodeExecutionId?.split("-iter-")[0] ?? executionId
        setLoopIterations(prev => {
          const next = new Map(prev)
          const existing = next.get(loopId)
          if (!existing) return prev
          const updatedIterations = existing.iterations.map(i => {
            if (i.iteration !== iteration) return i
            return {
              ...i,
              status: (status ?? "completed") as IterationDetail["status"],
              completedAt: new Date().toISOString(),
              durationMs,
              nodes: nodeResults ?? i.nodes,
            }
          })
          const completed = updatedIterations.filter(i => i.status === "completed").length
          const failed = updatedIterations.filter(i => i.status === "failed").length
          next.set(loopId, { ...existing, iterations: updatedIterations, completed, failed })
          return next
        })
      } catch { /* skip */ }
    })
    es.addEventListener("gate_change", (e) => {
      const { executionId, gateStatus } = JSON.parse(e.data)
      setTreeNodes(prev => prev.map(n => n.id === executionId ? { ...n, gateStatus: gateStatus as GateStatus } : n))
    })
    es.addEventListener("execution_deleted", (e) => {
      const data = JSON.parse(e.data)
      const deletedId = data.executionId
      setTreeNodes(prev => {
        const deletedNode = prev.find(n => n.id === deletedId)
        const updated = prev.filter(n => n.id !== deletedId)
        if (deletedNode?.parentId && deletedNode.parentId !== "0") {
          const hasOther = updated.some(n => n.parentId === deletedNode.parentId)
          return updated.map(n => n.id === deletedNode.parentId ? { ...n, childrenCount: n.childrenCount - 1, isLeaf: !hasOther } : n)
        }
        return updated
      })
    })
    es.addEventListener("execution_created", (e) => {
      const raw = JSON.parse(e.data)
      const newNode = apiNodeToTreeNode(raw)
      setTreeNodes(prev => {
        if (prev.some(n => n.id === newNode.id)) return prev
        if (newNode.parentId && newNode.parentId !== "0") {
          return prev.map(n => n.id === newNode.parentId ? { ...n, childrenCount: n.childrenCount + 1, isLeaf: false } : n).concat(newNode)
        }
        return prev.concat(newNode)
      })
    })
    es.onerror = () => {}
    return () => { es.close(); eventSourceRef.current = null }
  }, [workspaceId])

  // ---- handlers ----

  const addNextNode = useCallback(async (parentId: string, formData: CreateNodeFormData) => {
    const parent = treeNodes.find(n => n.id === parentId)
    if (!parent) return
    const created = await createExecution(workspaceId, { workflow_ref: formData.workflowRef, name: formData.name, node_type: "normal", parent_id: parentId, input_values: formData.inputValues })
    setTreeNodes(prev => prev.map(n => n.id === parentId ? { ...n, childrenCount: n.childrenCount + 1, isLeaf: false } : n).concat(apiNodeToTreeNode(created)))
  }, [workspaceId, treeNodes])

  const addForkNode = useCallback(async (parentId: string, formData: CreateNodeFormData) => {
    const parent = treeNodes.find(n => n.id === parentId)
    if (!parent) return
    const siblings = treeNodes.filter(n => n.parentId === parentId)
    const maxIdx = siblings.length > 0 ? Math.max(...siblings.map(s => s.childIndex)) : -1
    const created = await createExecution(workspaceId, { workflow_ref: formData.workflowRef, name: formData.name, node_type: "fork", parent_id: parentId, child_index: maxIdx + 1, input_values: formData.inputValues })
    setTreeNodes(prev => prev.map(n => n.id === parentId ? { ...n, childrenCount: n.childrenCount + 1 } : n).concat(apiNodeToTreeNode(created)))
  }, [workspaceId, treeNodes])

  const addRootNode = useCallback(async (formData: CreateNodeFormData) => {
    if (treeNodes.length > 0) return
    const created = await createExecution(workspaceId, { workflow_ref: formData.workflowRef, name: formData.name, node_type: "normal", input_values: formData.inputValues })
    setTreeNodes([apiNodeToTreeNode(created)])
  }, [workspaceId, treeNodes])

  const executeNode = useCallback(async (nodeId: string, formData: ExecuteNodeFormData) => {
    setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'running' as ExecutionStatus, inputValues: formData.inputValues, rollbackOnError: formData.rollbackOnError, rollback: formData.rollbackOnError ? 'git-revert' : 'none' } : n))
    try { await startExecution(workspaceId, nodeId, { inputValues: formData.inputValues }) } catch { setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'failed' as ExecutionStatus } : n)) }
  }, [workspaceId])

  const retryNode = useCallback(async (nodeId: string, formData: ExecuteNodeFormData) => {
    setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'running' as ExecutionStatus, inputValues: formData.inputValues, rollbackOnError: formData.rollbackOnError, rollback: formData.rollbackOnError ? 'git-revert' : 'none', progress: 0 } : n))
    // Tree view only has the execution UUID (nodeId), not the workflow node ID (e.g. "plan").
    // Pass empty string so the server auto-detects the failed workflow node from DB.
    try { await retryExecution(workspaceId, nodeId, "", { inputValues: formData.inputValues }) } catch { setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'failed' as ExecutionStatus } : n)) }
  }, [workspaceId])

  const retryNodeWithIntervention = useCallback(async (nodeId: string, intervention: string) => {
    setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'running' as ExecutionStatus, progress: 0 } : n))
    try { await retryExecution(workspaceId, nodeId, "", { intervention }) } catch { setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'failed' as ExecutionStatus } : n)) }
  }, [workspaceId])

  const terminateNode = useCallback(async (nodeId: string) => {
    await cancelExecution(workspaceId, nodeId)
    setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, executionStatus: 'cancelled' as ExecutionStatus, gateStatus: 'closed' as GateStatus } : n))
  }, [workspaceId])

  const skipNode = useCallback(async (nodeId: string) => {
    await skipExecution(workspaceId, nodeId)
    setTreeNodes(prev => prev.map(n => n.id === nodeId ? { ...n, gateStatus: 'bypassed' as GateStatus } : n))
  }, [workspaceId])

  const deleteNode = useCallback(async (nodeId: string) => {
    const node = treeNodes.find(n => n.id === nodeId)
    if (!node || !node.isLeaf) return
    if (node.executionStatus === 'running') return
    await deleteExecution(workspaceId, nodeId)
    setTreeNodes(prev => {
      const updated = prev.filter(n => n.id !== nodeId)
      if (node.parentId && node.parentId !== "0") {
        const parent = updated.find(n => n.id === node.parentId)
        if (parent) {
          const hasOther = updated.some(n => n.parentId === node.parentId)
          return updated.map(n => n.id === node.parentId ? { ...n, childrenCount: parent.childrenCount - 1, isLeaf: !hasOther } : n)
        }
      }
      return updated
    })
  }, [workspaceId, treeNodes])

  const resetTree = useCallback(() => {
    // Clear cached positions so dagre recalculates fresh layout
    setUserPositions({})
    if (typeof window !== "undefined") {
      try { localStorage.removeItem(POSITIONS_KEY(workspaceId)) } catch { /* ignore */ }
    }
    loadTree()
  }, [loadTree, workspaceId])

  // ---- callbacks (provided via context, not stored in node data) ----

  const callbacks = useMemo(() => ({
    onDetail: onDetailCallback ? (nodeId: string) => {
      const node = treeNodes.find(n => n.id === nodeId)
      if (node) onDetailCallback(node)
    } : undefined,
    onExecute: callbackOverrides?.onExecute,
    onRetry: callbackOverrides?.onRetry,
    onSkip: callbackOverrides?.onSkip ?? skipNode,
    onTerminate: terminateNode,
    onDelete: callbackOverrides?.onDelete ?? deleteNode,
    onApprove: callbackOverrides?.onApprove,
    onPause: callbackOverrides?.onPause,
    onResume: callbackOverrides?.onResume,
    isPausing: callbackOverrides?.isPausing,
  }), [onDetailCallback, callbackOverrides, skipNode, terminateNode, deleteNode, treeNodes])

  // ---- last completed node ----

  const lastCompletedNodeId = useMemo(() => {
    const completed = treeNodes.filter(n => n.executionStatus === "completed")
    if (completed.length === 0) return null
    return completed.reduce((latest, node) => {
      const latestTime = latest.completedAt ?? latest.updatedAt ?? ""
      const nodeTime = node.completedAt ?? node.updatedAt ?? ""
      return nodeTime > latestTime ? node : latest
    }).id
  }, [treeNodes])

  // ---- sync treeNodes → ReactFlow nodes/edges ----
  // This is the ONLY useEffect that updates ReactFlow state from tree data.
  // It runs when treeNodes changes (SSE events, CRUD operations).
  // Structure changes (add/delete) reset positions from dagre.
  // Data-only changes (status/progress) preserve existing positions.

  useEffect(() => {
    const currentIds = treeNodes.map(n => n.id).sort().join(",")
    const structureChanged = currentIds !== prevTreeIdsRef.current
    const parentGateMap = computeParentGateMap(treeNodes)

    if (structureChanged) {
      prevTreeIdsRef.current = currentIds
      const dagrePositions = computeDagreLayout(treeNodes)
      // Full rebuild — use dagre positions + user overrides
      setNodes(treeNodes.map(node => ({
        id: node.id,
        type: 'execution',
        position: userPositions[node.id] ?? dagrePositions[node.id] ?? { x: 0, y: 0 },
        data: buildNodeData(node, parentGateMap.get(node.id) ?? null, node.id === lastCompletedNodeId),
      })))
    } else {
      // Data-only update — preserve positions from current ReactFlow state
      setNodes(prev => prev.map(existing => {
        const treeNode = treeNodes.find(n => n.id === existing.id)
        if (!treeNode) return existing
        return { ...existing, data: buildNodeData(treeNode, parentGateMap.get(treeNode.id) ?? null, treeNode.id === lastCompletedNodeId) }
      }))
    }

    setEdges(buildEdges(treeNodes))
  }, [treeNodes, userPositions, lastCompletedNodeId, setNodes, setEdges])

  // onNodeDragStop: persist final position to localStorage
  const onNodeDragStop = useCallback((_event: unknown, node: Node) => {
    setUserPositions(userPos => {
      const updated = { ...userPos, [node.id]: node.position }
      savePositions(workspaceId, updated)
      return updated
    })
  }, [workspaceId])

  const resetLayout = useCallback(() => {
    setUserPositions({})
    if (typeof window !== "undefined") {
      try { localStorage.removeItem(POSITIONS_KEY(workspaceId)) } catch { /* ignore */ }
    }
    // Recompute dagre layout and apply immediately
    const dagrePositions = computeDagreLayout(treeNodes)
    const parentGateMap = computeParentGateMap(treeNodes)
    setNodes(treeNodes.map(node => ({
      id: node.id,
      type: 'execution',
      position: dagrePositions[node.id] ?? { x: 0, y: 0 },
      data: buildNodeData(node, parentGateMap.get(node.id) ?? null, node.id === lastCompletedNodeId),
    })))
  }, [workspaceId, treeNodes, setNodes, lastCompletedNodeId])

  return {
    treeNodes,
    nodes,
    edges,
    loading,
    callbacks,
    onNodesChange,
    onNodeDragStop,
    addNextNode, addForkNode, addRootNode,
    skipNode, deleteNode, executeNode, retryNode, retryNodeWithIntervention, terminateNode,
    resetTree,
    resetLayout,
    loopIterations,
  }
}