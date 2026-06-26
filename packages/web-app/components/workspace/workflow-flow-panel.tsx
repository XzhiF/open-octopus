"use client"

import { useCallback, useState, useEffect } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type ReactFlowInstance,
  type NodeMouseHandler,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Play, RotateCcw, LayoutGrid, ChevronRight, GitBranch, Loader2, CheckCircle, PauseCircle, PlayCircle, ShieldCheck } from "lucide-react"
import { ExecutionNode } from "./workflow-nodes/execution-node"
import { ExecutionEdge } from "./workflow-edges/execution-edge"
import { ExecutionNodeProvider } from "./workflow-nodes/execution-node-context"
import { CreateNodeDialog } from "./create-node-dialog"
import { ExecuteNodeDialog } from "./execute-node-dialog"
import { ApprovalDialog } from "./approval-dialog"
import { InterventionDialog } from "./intervention-dialog"
import { useExecutionTree } from "@/hooks/use-execution-tree"
import { getServerUrl } from "@/lib/server-config"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import type { Execution, ExecutionTreeNode, CreateNodeFormData, ExecuteNodeFormData, WorkflowOption } from "@/lib/types"

interface WorkflowFlowPanelProps {
  workspaceId: string
  executions: Execution[]
  workflowOptions: WorkflowOption[]
  org: string
  onNodeClick?: (execution: Execution) => void
  onRefresh?: () => void
}

const nodeTypes = { execution: ExecutionNode }
const edgeTypes = { execution: ExecutionEdge }

export function WorkflowFlowPanel({
  workspaceId,
  executions,
  workflowOptions,
  org,
  onNodeClick,
  onRefresh,
}: WorkflowFlowPanelProps) {
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string
    x: number
    y: number
  } | null>(null)

  const [createNodeDialog, setCreateNodeDialog] = useState<{
    parentId: string
    mode: "next" | "fork"
  } | null>(null)

  // Persist execute dialog state to localStorage so it survives tab switches
  const executeDialogKey = `octopus:ws:${workspaceId}:executeDialog`
  const [executeNodeDialog, setExecuteNodeDialog] = useState<{
    nodeId: string
    mode: "execute" | "retry"
  } | null>(() => {
    if (typeof window === "undefined") return null
    try {
      const stored = localStorage.getItem(executeDialogKey)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  // Sync executeNodeDialog to localStorage
  useEffect(() => {
    if (executeNodeDialog) {
      localStorage.setItem(executeDialogKey, JSON.stringify(executeNodeDialog))
    } else {
      localStorage.removeItem(executeDialogKey)
    }
  }, [executeNodeDialog, executeDialogKey])

  const [pendingSkip, setPendingSkip] = useState<{ nodeId: string; nodeName: string } | null>(null)
  const [pendingDeleteNode, setPendingDeleteNode] = useState<{ nodeId: string; nodeName: string } | null>(null)
  const [approvalDialog, setApprovalDialog] = useState<{ nodeId: string } | null>(null)
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [interventionDialog, setInterventionDialog] = useState<{ nodeId: string; nodeName: string } | null>(null)
  const [interventionLoading, setInterventionLoading] = useState(false)
  const [retryInterventionDialog, setRetryInterventionDialog] = useState<{ nodeId: string; nodeName: string } | null>(null)
  const [retryInterventionLoading, setRetryInterventionLoading] = useState(false)
  const [pausingNodeIds, setPausingNodeIds] = useState<Set<string>>(new Set())

  // API calls for pause/resume
  const pauseExecution = async (executionId: string) => {
    setPausingNodeIds(prev => new Set(prev).add(executionId))
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    } catch (err) {
      console.error("Failed to pause execution", err)
    } finally {
      setPausingNodeIds(prev => {
        const next = new Set(prev)
        next.delete(executionId)
        return next
      })
    }
  }

  const resumeExecution = async (executionId: string, intervention?: string) => {
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: intervention ? JSON.stringify({ intervention }) : undefined,
      })
    } catch (err) {
      console.error("Failed to resume execution", err)
    }
  }

  const handleDetail = useCallback((treeNode: ExecutionTreeNode) => {
    onNodeClick?.(treeNode as any)
  }, [onNodeClick])

  const {
    treeNodes,
    nodes,
    edges,
    loading,
    callbacks,
    resetTree,
    resetLayout,
    addNextNode,
    addForkNode,
    addRootNode,
    executeNode,
    retryNode,
    retryNodeWithIntervention,
    skipNode,
    deleteNode,
    onNodesChange,
    onNodeDragStop,
  } = useExecutionTree(workspaceId, handleDetail, {
    onExecute: (nodeId) => setExecuteNodeDialog({ nodeId, mode: "execute" }),
    onRetry: (nodeId) => {
      const node = treeNodes.find(n => n.id === nodeId)
      setRetryInterventionDialog({ nodeId, nodeName: node?.name || node?.workflowName || nodeId })
    },
    onSkip: (nodeId) => {
      const node = treeNodes.find(n => n.id === nodeId)
      setPendingSkip({ nodeId, nodeName: node?.name || node?.workflowName || nodeId })
    },
    onDelete: (nodeId) => {
      const node = treeNodes.find(n => n.id === nodeId)
      setPendingDeleteNode({ nodeId, nodeName: node?.name || node?.workflowName || nodeId })
    },
    onApprove: (nodeId) => setApprovalDialog({ nodeId }),
    onPause: (nodeId) => pauseExecution(nodeId),
    onResume: (nodeId) => {
      const node = treeNodes.find(n => n.id === nodeId)
      // pending_resume → resume directly (crash recovery), no intervention needed
      if (node?.executionStatus === "pending_resume") {
        resumeExecution(nodeId)
        return
      }
      setInterventionDialog({ nodeId, nodeName: node?.name || node?.workflowName || nodeId })
    },
    isPausing: (nodeId) => pausingNodeIds.has(nodeId),
  }, org)

  // ★ 自动清除 pausing 状态：当执行状态变为非 running 时（如 paused），清除"暂停中"
  useEffect(() => {
    if (pausingNodeIds.size === 0) return
    setPausingNodeIds(prev => {
      const next = new Set<string>()
      for (const id of prev) {
        const node = treeNodes.find(n => n.id === id)
        if (node && node.executionStatus === "running") {
          next.add(id)  // 仍在运行，保留
        }
        // 状态已变化（paused/completed/failed 等），不保留
      }
      return next.size === prev.size ? prev : next
    })
  }, [pausingNodeIds, treeNodes])

  // Calculate statistics
  const stats = treeNodes.reduce((acc, node) => {
    acc[node.executionStatus] = (acc[node.executionStatus] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // Derive active execution state from tree nodes
  const activeExecution = treeNodes.find(n => n.executionStatus === "running")
    ?? treeNodes.find(n => n.executionStatus === "paused")
    ?? treeNodes.find(n => n.executionStatus === "pending_approval")
  const activeExecutionId = activeExecution?.id
  const executionStatus = activeExecution?.executionStatus

  const executeNodeData = executeNodeDialog
    ? treeNodes.find((n) => n.id === executeNodeDialog.nodeId)
    : null

  const approvalNodeData = approvalDialog
    ? treeNodes.find((n) => n.id === approvalDialog.nodeId)
    : null

  const handleApprove = async (value: string, comment: string) => {
    if (!approvalNodeData?.approvalMetadata) return
    setApprovalLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${approvalNodeData.executionId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: approvalNodeData.approvalMetadata.nodeId,
          answer: value,
          comment,
        }),
      })
      setApprovalDialog(null)
    } catch (err) {
      console.error("Approval failed:", err)
    } finally {
      setApprovalLoading(false)
    }
  }

  const interventionNodeData = interventionDialog
    ? treeNodes.find((n) => n.id === interventionDialog.nodeId)
    : null

  const handleIntervention = async (intervention: string) => {
    if (!interventionNodeData) return
    setInterventionLoading(true)
    try {
      await resumeExecution(interventionNodeData.executionId, intervention)
      setInterventionDialog(null)
      onRefresh?.()
    } catch (err) {
      console.error("Intervention failed:", err)
    } finally {
      setInterventionLoading(false)
    }
  }

  const retryInterventionNodeData = retryInterventionDialog
    ? treeNodes.find((n) => n.id === retryInterventionDialog.nodeId)
    : null

  const handleRetryIntervention = async (intervention: string) => {
    if (!retryInterventionNodeData) return
    setRetryInterventionLoading(true)
    try {
      await retryNodeWithIntervention(retryInterventionNodeData.executionId, intervention)
      setRetryInterventionDialog(null)
      onRefresh?.()
    } catch (err) {
      console.error("Retry intervention failed:", err)
    } finally {
      setRetryInterventionLoading(false)
    }
  }

  const handleNodeContextMenu: NodeMouseHandler<Node> = useCallback((_reactEvent, node) => {
    _reactEvent.preventDefault()
    setContextMenu({ nodeId: node.id, x: _reactEvent.clientX, y: _reactEvent.clientY })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const contextNode = contextMenu
    ? treeNodes.find((n) => n.id === contextMenu.nodeId)
    : null

  const onInit = useCallback((instance: ReactFlowInstance) => {
    setTimeout(() => {
      instance.fitView({ padding: 0.2 })
    }, 50)
  }, [])

  const handleCreateNodeConfirm = useCallback((parentId: string, formData: CreateNodeFormData) => {
    if (parentId === "0") {
      addRootNode(formData)
    } else if (createNodeDialog?.mode === "next") {
      addNextNode(parentId, formData)
    } else {
      addForkNode(parentId, formData)
    }
    setCreateNodeDialog(null)
  }, [createNodeDialog, addRootNode, addNextNode, addForkNode])

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex h-10 items-center border-b border-border bg-background px-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            执行流程
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (treeNodes.length === 0) {
    return (
      <ExecutionNodeProvider callbacks={callbacks}>
        <div className="h-full flex flex-col">
          <div className="flex h-10 items-center border-b border-border bg-background px-3">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              执行流程
            </span>
          </div>
          <div className="flex-1 flex items-center justify-center">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Play />
                </EmptyMedia>
                <EmptyTitle>创建第一个执行工作流节点</EmptyTitle>
                <EmptyDescription>
                  选择一个工作流定义，创建执行树的根节点
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => setCreateNodeDialog({ parentId: "0", mode: "next" })}>
                  <Play className="mr-2 h-4 w-4" />
                  创建节点
                </Button>
              </EmptyContent>
            </Empty>
          </div>
          {createNodeDialog && (
            <CreateNodeDialog
              open={true}
              onOpenChange={(open) => { if (!open) setCreateNodeDialog(null) }}
              mode={createNodeDialog.mode}
              parentId={createNodeDialog.parentId}
              workspaceId={workspaceId}
              workflowOptions={workflowOptions}
              onConfirm={handleCreateNodeConfirm}
            />
          )}
        </div>
      </ExecutionNodeProvider>
    )
  }

  return (
    <ExecutionNodeProvider callbacks={callbacks}>
      <div className="h-full w-full flex flex-col" onContextMenu={(e) => e.preventDefault()} data-testid="workflow-flow-panel">
        <div className="flex h-10 items-center justify-between border-b border-border bg-background px-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              执行流程
            </span>
            {/* Statistics */}
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              {stats.completed && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                  <CheckCircle className="h-3 w-3" />{stats.completed}
                </span>
              )}
              {stats.running && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  <Loader2 className="h-3 w-3 animate-spin" />{stats.running}
                </span>
              )}
              {stats.paused && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />{stats.paused}
                </span>
              )}
              {stats.pending_approval && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  <ShieldCheck className="h-3 w-3" />{stats.pending_approval}
                </span>
              )}
              {stats.failed && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />{stats.failed}
                </span>
              )}
              {stats.pending && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />{stats.pending}
                </span>
              )}
              {stats.rejected && (
                <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />{stats.rejected}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={resetLayout} title="复位节点布局">
              <LayoutGrid className="h-3.5 w-3.5" />
              复位
            </Button>
            <Button variant="ghost" size="sm" onClick={resetTree}>
              <RotateCcw className="h-3.5 w-3.5" />
              重置
            </Button>
          </div>
        </div>
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={true}
            nodesConnectable={false}
            elementsSelectable={true}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={handleNodeContextMenu}
            onInit={onInit}
            fitView
            proOptions={{ hideAttribution: true }}
            aria-label="执行流程图"
          >
            <Background color="#333" gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={(node) => {
                const status = (node.data as any)?.executionStatus
                if (status === "completed") return "#10b981"
                if (status === "completed_with_failures") return "#f59e0b"
                if (status === "running") return "#f59e0b"
                if (status === "failed") return "#ef4444"
                if (status === "paused") return "#8b5cf6"
                if (status === "pending_approval") return "#f59e0b"
                if (status === "rejected") return "#ea580c"
                return "#d1d5db"
              }}
              maskColor="rgba(0, 0, 0, 0.1)"
              className="!bg-background/80 !border-border"
            />
          </ReactFlow>
        </div>
        {contextMenu && contextNode && (
          <DropdownMenu open={true} onOpenChange={(open) => !open && closeContextMenu()}>
            <DropdownMenuTrigger asChild>
              <div style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {contextNode.executionStatus === 'pending_approval' && contextNode.approvalMetadata && (
                <DropdownMenuItem onClick={() => { closeContextMenu(); setTimeout(() => setApprovalDialog({ nodeId: contextNode.id }), 50) }}>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  审批
                </DropdownMenuItem>
              )}
              {contextNode.childrenCount === 0 ? (
                <DropdownMenuItem onClick={() => { setCreateNodeDialog({ parentId: contextNode.id, mode: "next" }); closeContextMenu() }}>
                  <ChevronRight className="mr-2 h-4 w-4" />
                  Next 节点
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => { setCreateNodeDialog({ parentId: contextNode.id, mode: "fork" }); closeContextMenu() }}>
                  <GitBranch className="mr-2 h-4 w-4" />
                  Fork 分支
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {createNodeDialog && (
          <CreateNodeDialog
            open={true}
            onOpenChange={(open) => { if (!open) setCreateNodeDialog(null) }}
            mode={createNodeDialog.mode}
            parentId={createNodeDialog.parentId}
            workspaceId={workspaceId}
            workflowOptions={workflowOptions}
            onConfirm={handleCreateNodeConfirm}
          />
        )}
        {executeNodeDialog && executeNodeData && executeNodeDialog.mode === "execute" && (
          <ExecuteNodeDialog
            open={true}
            onOpenChange={(open) => { if (!open) setExecuteNodeDialog(null) }}
            mode={executeNodeDialog.mode}
            nodeId={executeNodeDialog.nodeId}
            workspaceId={workspaceId}
            workflowName={executeNodeData.workflowName}
            workflowRef={executeNodeData.workflowRef}
            workflowOptions={workflowOptions}
            initialInputValues={
              // Use the node's pre-filled inputValues, fall back to workflow defaults
              Object.fromEntries(
                Object.entries(
                  workflowOptions.find((o) => o.value === executeNodeData.workflowRef)?.inputs ?? {}
                ).map(([key, def]) => [key, executeNodeData.inputValues?.[key] ?? def.default ?? ""])
              )
            }
            initialRollbackOnError={executeNodeData.rollbackOnError}
            onConfirm={(nodeId, formData: ExecuteNodeFormData) => {
              executeNode(nodeId, formData)
              setExecuteNodeDialog(null)
            }}
          />
        )}
        {approvalDialog && approvalNodeData?.approvalMetadata && (
          <ApprovalDialog
            open={true}
            onOpenChange={(open) => { if (!open) setApprovalDialog(null) }}
            approval={approvalNodeData.approvalMetadata}
            onSubmit={handleApprove}
            loading={approvalLoading}
            storageKey={`octopus:ws:${workspaceId}:approval:${approvalDialog.nodeId}`}
          />
        )}
        {interventionDialog && interventionNodeData && (
          <InterventionDialog
            open={true}
            onOpenChange={(open) => { if (!open) setInterventionDialog(null) }}
            onSubmit={handleIntervention}
            loading={interventionLoading}
            mode="resume"
            storageKey={`octopus:ws:${workspaceId}:intervention:${interventionDialog.nodeId}`}
          />
        )}
        {retryInterventionDialog && retryInterventionNodeData && (
          <InterventionDialog
            open={true}
            onOpenChange={(open) => { if (!open) setRetryInterventionDialog(null) }}
            onSubmit={handleRetryIntervention}
            loading={retryInterventionLoading}
            mode="retry"
            storageKey={`octopus:ws:${workspaceId}:intervention:${retryInterventionDialog.nodeId}`}
          />
        )}
        <AlertDialog open={pendingSkip !== null} onOpenChange={(open) => { if (!open) setPendingSkip(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>跳过确认</AlertDialogTitle>
              <AlertDialogDescription>
                确定要跳过节点「{pendingSkip?.nodeName}」吗？跳过后该节点将不再执行。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingSkip(null)}>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => { skipNode(pendingSkip!.nodeId); setPendingSkip(null) }} className="bg-destructive text-white hover:bg-destructive/90">
                确认跳过
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={pendingDeleteNode !== null} onOpenChange={(open) => { if (!open) setPendingDeleteNode(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除确认</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除节点「{pendingDeleteNode?.nodeName}」吗？删除将不可恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingDeleteNode(null)}>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => { deleteNode(pendingDeleteNode!.nodeId); setPendingDeleteNode(null) }} className="bg-destructive text-white hover:bg-destructive/90">
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ExecutionNodeProvider>
  )
}