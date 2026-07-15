"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { formatDuration, formatTokenCount } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import type { Execution, StepExecution, StepExecutionStatus, Workflow, TokenUsage, LoopIterationSummary, ApprovalMetadata } from "@/lib/types"
import { fetchAgentEvents } from "@/lib/api-client"
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  Terminal,
  CheckCircle2,
  FileCode2,
  Timer as TimerIcon,
  Brain,
  Coins,
  Loader2,
  X,
  Archive as ArchiveIcon,
} from "lucide-react"
import { WorkflowFlowViewerWithStatus } from "./workflow-flow-viewer-with-status"
import { TokenUsageDisplay } from "./workflow-nodes/token-usage-display"
import { ExecutionLogViewer } from "./execution-log-viewer"
import { InterventionDialog } from "./intervention-dialog"
import { ApprovalDialog } from "./approval-dialog"
import { NodeInfoDialog } from "./node-info-dialog"
import { SwarmDetailDialog } from "@/components/swarm/organisms/swarm-detail-dialog"
import { ArchiveDialog } from "@/components/agent/knowledge/archive/ArchiveDialog"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { getServerUrl } from "@/lib/server-config"
import { useAgentTraces } from "@/hooks/use-agent-traces"
import { useLLMCalls } from "@/hooks/use-llm-calls"
import { AgentTimeline } from "@/components/agent-timeline/agent-timeline"
import { CostLine } from "@/components/cost-line"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import type { LLMCallData, LLMCallAggregates } from "@/lib/types"

const POLL_INTERVAL_MS = 3000
const RUNNING_STATUSES = new Set(["running", "paused", "pending_approval"])

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    running: { color: "bg-amber-500", label: "运行中" },
    paused: { color: "bg-violet-500", label: "已暂停" },
    completed: { color: "bg-emerald-500", label: "已完成" },
    failed: { color: "bg-red-500", label: "失败" },
    pending: { color: "bg-blue-500", label: "待开始" },
    pending_approval: { color: "bg-amber-500", label: "待审批" },
    cancelled: { color: "bg-gray-500", label: "已取消" },
    rejected: { color: "bg-orange-500", label: "已拒绝" },
  }

  const { color, label } = config[status] || { color: "bg-gray-500", label: status }

  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white", color)}>
      {label}
    </span>
  )
}

interface RawStepRow {
  stepId: string
  stepName: string
  status: string
  startedAt?: string
  completedAt?: string
  duration?: number
  output?: string
  error?: string
  model?: string
  tokensInput?: number
  tokensOutput?: number
  tokenUsages?: TokenUsage[]
  token_usages?: { model: string; inputTokens: number; outputTokens: number }[]
}

function mapRawStep(raw: RawStepRow): StepExecution {
  return {
    stepId: raw.stepId,
    stepName: raw.stepName,
    status: raw.status as StepExecutionStatus,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    duration: raw.duration,
    output: raw.output,
    error: raw.error,
    model: raw.model,
    tokensInput: raw.tokensInput,
    tokensOutput: raw.tokensOutput,
    tokenUsages: raw.tokenUsages ?? raw.token_usages,
  }
}

interface WorkflowDetailPanelProps {
  execution: Execution
  workflow?: Workflow
  workspaceId: string
}

export function WorkflowDetailPanel({ execution, workflow, workspaceId }: WorkflowDetailPanelProps) {
  const [activeStepId, setActiveStepId] = useState<string | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [yamlContent, setYamlContent] = useState(workflow?.yamlContent || "")
  const [liveStatus, setLiveStatus] = useState(execution.status)
  const [liveSteps, setLiveSteps] = useState(execution.steps)
  const [loopIterationsMap, setLoopIterationsMap] = useState<Map<string, LoopIterationSummary>>(new Map())

  // Dialog states (replacing drawer)
  const [nodeInfoDialog, setNodeInfoDialog] = useState<{ stepId: string; executorType: string | undefined } | null>(null)
  const [swarmDialogStepId, setSwarmDialogStepId] = useState<string | null>(null)

  // New state for action handlers
  const [pausing, setPausing] = useState(false)
  const [interventionDialog, setInterventionDialog] = useState(false)
  const [interventionLoading, setInterventionLoading] = useState(false)
  const [retryInterventionDialog, setRetryInterventionDialog] = useState(false)
  const [retryInterventionLoading, setRetryInterventionLoading] = useState(false)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [liveApprovalMetadata, setLiveApprovalMetadata] = useState<ApprovalMetadata | null>(
    execution.approvalMetadata ?? null,
  )
  const [archiveOpen, setArchiveOpen] = useState(false)

  // Always poll when panel is open — ensures recovery from stale prop data
  const fetchStatus = useCallback(() => {
    fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}`)
      .then(r => r.json())
      .then(d => {
        if (d.status) setLiveStatus(d.status)
        if (d.steps) setLiveSteps(d.steps.map(mapRawStep))
        if (d.workflow_content && !yamlContent) setYamlContent(d.workflow_content)
        setLiveApprovalMetadata(d.approvalMetadata ?? null)
      })
      .catch(() => {})
    // Fetch loop iterations data for NodeInfoDialog (S9/S10/S11)
    fetchAgentEvents(workspaceId, execution.id)
      .then(data => {
        if (data.loopIterations) {
          setLoopIterationsMap(new Map(Object.entries(data.loopIterations)))
        }
      })
      .catch(() => {})
  }, [workspaceId, execution.id, yamlContent])

  useEffect(() => {
    fetchStatus()
    const isRunning = RUNNING_STATUSES.has(liveStatus)
    const interval = isRunning
      ? setInterval(fetchStatus, POLL_INTERVAL_MS)
      : setInterval(fetchStatus, 10000) // slow poll when not running (10s)
    return () => clearInterval(interval)
  }, [liveStatus, fetchStatus])

  // Auto-open approval dialog when status transitions to pending_approval
  useEffect(() => {
    if (liveStatus === "pending_approval" && liveApprovalMetadata) {
      setApprovalOpen(true)
    }
  }, [liveStatus, liveApprovalMetadata])

  const handleApprove = async (value: string, comment: string) => {
    if (!liveApprovalMetadata) return
    setApprovalLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: liveApprovalMetadata.nodeId,
          answer: value,
          comment,
        }),
      })
      setApprovalOpen(false)
    } catch (err) {
      console.error("Approval failed:", err)
    } finally {
      setApprovalLoading(false)
    }
  }

  // Action handlers
  const handleStart = async () => {
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/start`, {
      method: "POST",
    })
  }

  const handleCancel = async () => {
    await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/cancel`, {
      method: "POST",
    })
  }

  const handlePause = async () => {
    setPausing(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/pause`, {
        method: "POST",
      })
    } finally {
      setPausing(false)
    }
  }

  const handleResume = async (intervention?: string) => {
    setInterventionLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: intervention ? JSON.stringify({ intervention }) : undefined,
      })
      setInterventionDialog(false)
    } finally {
      setInterventionLoading(false)
    }
  }

  const handleRetryIntervention = async (intervention: string) => {
    setRetryInterventionLoading(true)
    try {
      await fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ failedNodeId: "", intervention }),
      })
      setRetryInterventionDialog(false)
    } finally {
      setRetryInterventionLoading(false)
    }
  }

  const activeStep = activeStepId
    ? liveSteps?.find(s => s.stepId === activeStepId)
    : null

  const currentStep = liveSteps?.find(s => s.stepId === execution.currentStep)

  const activeStepStartedAt = activeStep?.status === "running" ? activeStep.startedAt : undefined
  const activeStepElapsedSeconds = useLiveTimer(activeStepStartedAt)

  // Observability hooks for agent nodes
  const isAgentNode = activeStep?.model != null || currentStep?.model != null
  const agentNodeId = isAgentNode ? (activeStep?.stepId ?? currentStep?.stepId) : undefined
  const { turns: agentTurns, loading: tracesLoading, error: tracesError, isDegraded } = useAgentTraces(execution.id, agentNodeId)
  const { calls: llmCalls, aggregates: llmAggregates, loading: llmLoading } = useLLMCalls(execution.id, agentNodeId)

  const showObservabilityTabs = isAgentNode && !!agentNodeId

  // Determine executor type from step data + node type from YAML
  function getExecutorType(step: StepExecution | undefined, nodeType?: string): string | undefined {
    if (!step) return undefined
    if (nodeType === "swarm") return "swarm"
    if (step.model) return "agent"
    const name = step.stepName?.toLowerCase() ?? ""
    if (name.includes("bash")) return "bash"
    if (name.includes("python")) return "python"
    if (name.includes("condition")) return "condition"
    if (name.includes("approval")) return "approval"
    if (name.includes("loop")) return "loop"
    return undefined
  }

  // Right-click "查看信息" handler
  const handleNodeContextMenu = useCallback((stepId: string, nodeType: string) => {
    const step = liveSteps?.find(s => s.stepId === stepId)
    const execType = getExecutorType(step, nodeType)
    setNodeInfoDialog({ stepId, executorType: execType })
    setActiveStepId(stepId)
  }, [liveSteps])

  // Swarm-specific click (left-click on swarm node or right-click "Swarm 信息")
  const handleSwarmClick = useCallback((stepId: string) => {
    setSwarmDialogStepId(stepId)
    setActiveStepId(stepId)
  }, [])

  // Resolve the step for the node info dialog
  const nodeInfoStep = nodeInfoDialog
    ? liveSteps?.find(s => s.stepId === nodeInfoDialog.stepId) ?? null
    : null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border bg-background px-3">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {execution.workflowName}
          </span>
          <Badge variant="outline" className="text-xs">
            #{execution.id.slice(-4)}
          </Badge>
          <StatusBadge status={liveStatus} />
        </div>
        <div className="flex items-center gap-1">
          {liveStatus === "pending" && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleStart} title="执行">
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}

          {liveStatus === "running" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handlePause}
                disabled={pausing}
                title="暂停"
              >
                {pausing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={handleCancel}
                title="终止"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {liveStatus === "paused" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setInterventionDialog(true)}
                title="继续"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={handleCancel}
                title="终止"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {liveStatus === "failed" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setRetryInterventionDialog(true)}
              title="重试"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}

          {liveStatus === "pending_approval" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setApprovalOpen(true)}
              title="审批"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {(liveStatus === "completed" || liveStatus === "failed") && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setArchiveOpen(true)}
              title="归档"
            >
              <ArchiveIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <PanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        {/* Left: Flow Chart */}
        <Panel defaultSize={70} minSize={40}>
          <WorkflowFlowViewerWithStatus
            yamlContent={yamlContent}
            executionSteps={liveSteps ?? []}
            activeStepId={activeStepId}
            currentStepId={execution.currentStep}
            onNodeContextMenu={handleNodeContextMenu}
            onSwarmClick={handleSwarmClick}
            workspaceId={workspaceId}
            executionId={execution.id}
            loopIterationsMap={loopIterationsMap}
          />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border/40 hover:bg-border transition-colors" />

        {/* Right: Logs (always visible) */}
        <Panel defaultSize={30} minSize={15} className="flex flex-col">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ExecutionLogViewer workspaceId={workspaceId} executionId={execution.id} executionStatus={liveStatus} />
          </div>
        </Panel>
      </PanelGroup>

      {/* Node Info Dialog (right-click "查看信息") */}
      <NodeInfoDialog
        open={!!nodeInfoDialog}
        onOpenChange={(open) => { if (!open) setNodeInfoDialog(null) }}
        step={nodeInfoStep}
        executorType={nodeInfoDialog?.executorType}
        workspaceId={workspaceId}
        executionId={execution.id}
        isRunning={liveStatus === "running"}
        loopIterations={nodeInfoDialog ? loopIterationsMap.get(nodeInfoDialog.stepId) : undefined}
        onOpenSwarmDialog={() => {
          if (nodeInfoDialog) {
            setSwarmDialogStepId(nodeInfoDialog.stepId)
            setNodeInfoDialog(null)
          }
        }}
      />

      {/* Swarm Detail Dialog (left-click swarm or right-click "Swarm 信息") */}
      <SwarmDetailDialog
        open={!!swarmDialogStepId}
        onOpenChange={(open) => { if (!open) setSwarmDialogStepId(null) }}
        nodeId={swarmDialogStepId}
        executionId={execution.id}
        workspaceId={workspaceId}
        nodeName={liveSteps?.find(s => s.stepId === swarmDialogStepId)?.stepName ?? "Swarm"}
        isReplay={liveStatus !== "running"}
      />

      {/* Intervention Dialog */}
      {interventionDialog && (
        <InterventionDialog
          open={interventionDialog}
          onOpenChange={setInterventionDialog}
          onSubmit={handleResume}
          loading={interventionLoading}
          storageKey={`octopus:ws:${workspaceId}:intervention:${execution.id}`}
        />
      )}
      {/* Retry Intervention Dialog */}
      {retryInterventionDialog && (
        <InterventionDialog
          open={retryInterventionDialog}
          onOpenChange={setRetryInterventionDialog}
          onSubmit={handleRetryIntervention}
          loading={retryInterventionLoading}
          mode="retry"
          storageKey={`octopus:ws:${workspaceId}:intervention:${execution.id}`}
        />
      )}

      {/* Approval Dialog */}
      {liveApprovalMetadata && (
        <ApprovalDialog
          open={approvalOpen}
          onOpenChange={setApprovalOpen}
          approval={liveApprovalMetadata}
          onSubmit={handleApprove}
          loading={approvalLoading}
          storageKey={`octopus:ws:${workspaceId}:approval:${execution.id}`}
        />
      )}

      {/* Archive Dialog */}
      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        executionId={execution.id}
        org={workspaceId}
        onArchiveComplete={() => setArchiveOpen(false)}
      />
    </div>
  )
}

interface CostPanelProps {
  aggregates: LLMCallAggregates
  calls: LLMCallData[]
  loading: boolean
}

function CostPanel({ aggregates, calls, loading }: CostPanelProps) {
  if (loading) {
    return <div className="text-xs text-muted-foreground">加载成本数据...</div>
  }

  if (aggregates.totalCalls === 0) {
    return <div className="text-xs text-muted-foreground">暂无LLM调用数据</div>
  }

  const models = Object.entries(aggregates.modelBreakdown)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs font-medium text-muted-foreground mb-2">总览</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">总成本</div>
            <div className="text-lg font-bold tabular-nums text-amber-600">${aggregates.totalCost.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">调用次数</div>
            <div className="text-lg font-bold tabular-nums">{aggregates.totalCalls}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Cache Hit Rate</div>
            <div className="text-lg font-bold tabular-nums">{(aggregates.cacheHitRate * 100).toFixed(0)}%</div>
          </div>
          <div>
            <div className="text-muted-foreground">Input / Output</div>
            <div className="text-sm tabular-nums">
              ↑{formatTokenCount(aggregates.totalInputTokens)} ↓{formatTokenCount(aggregates.totalOutputTokens)}
            </div>
          </div>
        </div>
        <CostLine
          costUsd={aggregates.totalCost}
          turns={aggregates.totalCalls}
        />
      </div>

      {/* Model Breakdown */}
      {models.length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground mb-2">按模型分解</div>
          <div className="space-y-2">
            {models.map(([model, stats]) => (
              <div key={model} className="flex items-center justify-between text-xs">
                <div className="min-w-0">
                  <div className="font-medium truncate">{model}</div>
                  <div className="text-muted-foreground tabular-nums">
                    {stats.calls} calls · ↑{formatTokenCount(stats.inputTokens)} ↓{formatTokenCount(stats.outputTokens)}
                  </div>
                </div>
                <div className="text-right tabular-nums font-medium">
                  ${stats.costUsd.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}