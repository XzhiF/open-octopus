"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { cn } from "@/lib/utils"
import { formatDuration, formatTokenCount, formatCost, formatPercent } from "@/lib/format"
import { getExecutorType } from "@/lib/executor-type"
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
  ShieldCheck,
  MessageCircle,
} from "lucide-react"
import { WorkflowFlowViewerWithStatus } from "./workflow-flow-viewer-with-status"
import { TokenUsageDisplay } from "./workflow-nodes/token-usage-display"
import { ExecutionLogViewer } from "./execution-log-viewer"
import { InterventionDialog } from "./intervention-dialog"
import { ApprovalDialog } from "./approval-dialog"
import { InteractionModal } from "./interaction-modal"
import { NodeInfoDialog } from "./node-info-dialog"
import { SwarmDetailDialog } from "@/components/swarm/organisms/swarm-detail-dialog"
import { ArchiveDialog } from "@/components/agent/knowledge/archive/ArchiveDialog"
import { HarnessFloatingPanel } from "./harness-floating-panel"
import { useLiveTimer } from "@/hooks/use-live-timer"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"
import { useAgentTraces } from "@/hooks/use-agent-traces"
import { useLLMCalls } from "@/hooks/use-llm-calls"
import { AgentTimeline } from "@/components/agent-timeline/agent-timeline"
import { CostLine } from "@/components/cost-line"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import type { LLMCallData, LLMCallAggregates } from "@/lib/types"

const POLL_INTERVAL_MS = 3000
const RUNNING_STATUSES = new Set(["running", "paused", "pending_approval", "pending_interaction"])

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    running: { color: "bg-amber-500", label: "运行中" },
    paused: { color: "bg-violet-500", label: "已暂停" },
    completed: { color: "bg-emerald-500", label: "已完成" },
    failed: { color: "bg-red-500", label: "失败" },
    pending: { color: "bg-blue-500", label: "待开始" },
    pending_approval: { color: "bg-amber-500", label: "待审批" },
    pending_interaction: { color: "bg-purple-500", label: "交互中" },
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
  outputs?: Record<string, unknown>
  error?: string
  model?: string
  tokensInput?: number
  tokensOutput?: number
  /** 规范纯值用量（C1：server steps 现发 usage，不再发 tokensInput=in+cache 折叠值） */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  modelUsages?: TokenUsage[]
  tokenUsages?: TokenUsage[]
  token_usages?: { model: string; inputTokens: number; outputTokens: number }[]
  nodeType?: string
  parentNodeId?: string
  iterationIndex?: number
  agentName?: string
  agentVersion?: string
  taskBrief?: string
  harnessStatus?: string
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
    outputs: raw.outputs,
    error: raw.error,
    model: raw.model,
    // C1：tokensInput/Output 取纯值 usage（与运行中 turn_usage 同口径 → 节点卡不再跳变）
    tokensInput: raw.usage?.inputTokens ?? raw.tokensInput,
    tokensOutput: raw.usage?.outputTokens ?? raw.tokensOutput,
    tokenUsages: raw.modelUsages ?? raw.tokenUsages ?? raw.token_usages,
    nodeType: raw.nodeType,
    parentNodeId: raw.parentNodeId,
    iterationIndex: raw.iterationIndex,
    agentName: raw.agentName,
    agentVersion: raw.agentVersion,
    taskBrief: raw.taskBrief,
    harnessStatus: raw.harnessStatus as StepExecution["harnessStatus"],
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
  const [interactionOpen, setInteractionOpen] = useState(false)
  const [liveInteractionMeta, setLiveInteractionMeta] = useState<{ nodeId: string; sessionId?: string; initialPrompt?: string } | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  // ── SSE 增量补丁保护 ─────────────────────────────────────────────
  // node_start/node_end 事件毫秒级写入 liveSteps，3s 轮询仅作 SSE 断流兜底。
  // 补丁后短时间窗口内，晚到的旧 REST 快照不得覆盖更新的 SSE 值。
  const stepPatchRef = useRef<Map<string, { ts: number; patch: Partial<StepExecution> }>>(new Map())

  // Always poll when panel is open — ensures recovery from stale prop data
  const fetchStatus = useCallback(() => {
    const t0 = Date.now()
    fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${execution.id}`)
      .then(r => r.json())
      .then(d => {
        if (d.status) setLiveStatus(d.status)
        if (d.steps) {
          for (const [k, v] of stepPatchRef.current) if (t0 - v.ts > 15000) stepPatchRef.current.delete(k)
          setLiveSteps(d.steps.map((raw: RawStepRow) => {
            const s = mapRawStep(raw)
            const entry = stepPatchRef.current.get(s.stepId)
            return entry && entry.ts >= t0 ? { ...s, ...entry.patch } : s
          }))
        }
        if (d.workflow_content && !yamlContent) setYamlContent(d.workflow_content)
        setLiveApprovalMetadata(d.approvalMetadata ?? null)
        setLiveInteractionMeta(d.interactionMetadata ?? null)
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

  // SSE listeners for real-time harness status updates on workflow nodes.
  // Polling (3s) is too slow to catch the brief harness_intervening state —
  // these listeners update liveSteps immediately when harness events arrive.
  // Uses shared SSE connection to avoid exhausting browser connection pool.
  useEffect(() => {
    if (!workspaceId || !execution.id) return
    const sseUrl = `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`

    const updateStepHarness = (nodeIds: string[], status: string) => {
      setLiveSteps(prev => (prev ?? []).map(s =>
        nodeIds.includes(s.stepId) ? { ...s, harnessStatus: status as StepExecution["harnessStatus"] } : s
      ))
    }

    const unsubs = [
      subscribeSSE(sseUrl, "harness_diagnosis", (e: MessageEvent) => {
        try {
          const { executionId, report } = JSON.parse(e.data)
          if (executionId !== execution.id) return
          const ids = [report.nodeId, report.displayNodeId].filter(Boolean) as string[]
          if (ids.length > 0) updateStepHarness(ids, "harness_intervening")
        } catch { /* skip */ }
      }),

      subscribeSSE(sseUrl, "harness_delegation", (e: MessageEvent) => {
        try {
          const { executionId, nodeId, containerNodeId, status, result } = JSON.parse(e.data)
          if (executionId !== execution.id || status !== "complete") return
          const decision = result?.decision as string | undefined
          const harnessStatus = decision === "block_node" ? "harness_blocked"
            : decision === "agent_takeover" ? "harness_executed"
            : "harness_modified"
          const ids = [nodeId, containerNodeId].filter(Boolean) as string[]
          if (ids.length > 0) updateStepHarness(ids, harnessStatus)
        } catch { /* skip */ }
      }),

      subscribeSSE(sseUrl, "harness_intervention", (e: MessageEvent) => {
        try {
          const { executionId, nodeId, containerNodeId, success } = JSON.parse(e.data)
          if (executionId !== execution.id) return
          const ids = [nodeId, containerNodeId].filter(Boolean) as string[]
          if (ids.length > 0) updateStepHarness(ids, success ? "harness_modified" : "harness_blocked")
        } catch { /* skip */ }
      }),

      subscribeSSE(sseUrl, "harness_blocked", (e: MessageEvent) => {
        try {
          const { executionId, nodeId, containerNodeId } = JSON.parse(e.data)
          if (executionId !== execution.id) return
          const ids = [nodeId, containerNodeId].filter(Boolean) as string[]
          if (ids.length > 0) updateStepHarness(ids, "harness_blocked")
        } catch { /* skip */ }
      }),

      // ── 节点生命周期增量更新：替代「等 3s 轮询整包替换」的延迟 ──
      subscribeSSE(sseUrl, "node_start", (e: MessageEvent) => {
        try {
          const { executionId, nodeId } = JSON.parse(e.data)
          if (executionId !== execution.id || !nodeId) return
          const patch: Partial<StepExecution> = { status: "running", startedAt: new Date().toISOString() }
          stepPatchRef.current.set(nodeId, { ts: Date.now(), patch })
          setLiveSteps(prev => (prev ?? []).map(s => s.stepId === nodeId ? { ...s, ...patch } : s))
        } catch { /* skip */ }
      }),

      subscribeSSE(sseUrl, "node_end", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data)
          if (d.executionId !== execution.id || !d.nodeId) return
          const raw: Partial<StepExecution> = {
            status: d.status,
            completedAt: new Date().toISOString(),
            duration: typeof d.durationMs === "number" ? Math.round(d.durationMs / 1000) : undefined,
            tokensInput: d.usage?.inputTokens,
            tokensOutput: d.usage?.outputTokens,
            tokenUsages: d.modelUsages,
          }
          const patch = Object.fromEntries(
            Object.entries(raw).filter(([, v]) => v !== undefined),
          ) as Partial<StepExecution>
          stepPatchRef.current.set(d.nodeId, { ts: Date.now(), patch })
          setLiveSteps(prev => (prev ?? []).map(s => s.stepId === d.nodeId ? { ...s, ...patch } : s))
        } catch { /* skip */ }
      }),

      subscribeSSE(sseUrl, "execution_status", (e: MessageEvent) => {
        try {
          const { executionId, status } = JSON.parse(e.data)
          if (executionId === execution.id && typeof status === "string") setLiveStatus(status as Execution["status"])
        } catch { /* skip */ }
      }),

      // 运行中 agent 节点的 per-turn 实时 token/轮次（engine turn_usage 事件，
      // 权威终值仍由 node_end 覆盖校准）
      subscribeSSE(sseUrl, "agent_event", (e: MessageEvent) => {
        try {
          const { executionId, nodeId, event } = JSON.parse(e.data)
          if (executionId !== execution.id || !nodeId || event?.type !== "turn_usage") return
          const total = event.cumulative ?? {}
          const raw: Partial<StepExecution> = {
            status: "running",
            // 直连 Anthropic 时 inputTokens 可能未测得 → undefined 保留旧值，不清零
            tokensInput: (total.inputTokens ?? 0) > 0 ? total.inputTokens : undefined,
            tokensOutput: (total.outputTokens ?? 0) > 0 ? total.outputTokens : undefined,
            turns: typeof event.turn === "number" ? event.turn : undefined,
          }
          const patch = Object.fromEntries(
            Object.entries(raw).filter(([, v]) => v !== undefined),
          ) as Partial<StepExecution>
          stepPatchRef.current.set(nodeId, { ts: Date.now(), patch })
          setLiveSteps(prev => (prev ?? []).map(s => s.stepId === nodeId ? { ...s, ...patch } : s))
        } catch { /* skip */ }
      }),
    ]

    return () => { unsubs.forEach(fn => fn()) }
  }, [workspaceId, execution.id])

  // Auto-open approval dialog when status transitions to pending_approval (not on every poll)
  const approvalShownRef = useRef<string | null>(null)
  useEffect(() => {
    if (liveStatus === "pending_approval" && liveApprovalMetadata) {
      if (approvalShownRef.current !== liveApprovalMetadata.nodeId) {
        approvalShownRef.current = liveApprovalMetadata.nodeId
        setApprovalOpen(true)
      }
    } else if (liveStatus !== "pending_approval") {
      approvalShownRef.current = null
    }
  }, [liveStatus, liveApprovalMetadata?.nodeId])

  // Auto-open interaction modal when status transitions to pending_interaction
  const interactionShownRef = useRef<string | null>(null)
  useEffect(() => {
    if (liveStatus === "pending_interaction" && liveInteractionMeta) {
      if (interactionShownRef.current !== liveInteractionMeta.nodeId) {
        interactionShownRef.current = liveInteractionMeta.nodeId
        setInteractionOpen(true)
      }
    } else if (liveStatus !== "pending_interaction") {
      interactionShownRef.current = null
    }
  }, [liveStatus, liveInteractionMeta?.nodeId])

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

  // Determine executor type from step data + node type from YAML (extracted to lib/executor-type.ts)

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

  // Compute the currently active node ID for harness chatbot interventions.
  // Prefer a running step; fall back to the most recently failed step.
  const activeNodeId = useMemo(() => {
    if (!liveSteps) return undefined
    const running = liveSteps.find(s => s.status === "running")
    if (running) return running.stepId
    const failed = [...liveSteps]
      .filter(s => s.status === "failed")
      .sort((a, b) => {
        const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0
        const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0
        return bTime - aTime
      })[0]
    return failed?.stepId ?? undefined
  }, [liveSteps])

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
          {execution.harnessStatus && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white",
                execution.harnessStatus === "blocked"
                  ? "bg-red-500"
                  : execution.harnessStatus === "delegated"
                    ? "bg-violet-500"
                    : "bg-amber-500",
              )}
            >
              🛡️{" "}
              {execution.harnessStatus === "blocked"
                ? "已阻断"
                : execution.harnessStatus === "delegated"
                  ? "已接管"
                  : "已干预"}
            </span>
          )}
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

          {liveStatus === "pending_interaction" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-purple-500"
              onClick={() => setInteractionOpen(true)}
              title="交互"
            >
              <MessageCircle className="h-3.5 w-3.5" />
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

      {/* Inline Approval Prompt */}
      {liveStatus === "pending_approval" && liveApprovalMetadata && (
        <div className="flex items-center gap-2 border-b border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5">
          <ShieldCheck className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-sm text-amber-800 dark:text-amber-200">工作流已暂停，等待审批确认</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setApprovalOpen(true)}
            className="ml-auto h-6 text-xs border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            打开审批
          </Button>
        </div>
      )}

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

      {/* Interaction Modal */}
      {liveInteractionMeta && (
        <InteractionModal
          open={interactionOpen}
          onOpenChange={setInteractionOpen}
          executionId={execution.id}
          nodeId={liveInteractionMeta.nodeId}
          workspaceId={workspaceId}
          initialPromptFromMeta={liveInteractionMeta.initialPrompt}
          onComplete={() => {
            setInteractionOpen(false)
            fetchStatus()
          }}
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

      {/* Harness Floating Panel */}
      <HarnessFloatingPanel
        workspaceId={workspaceId}
        executionId={execution.id}
        executionStatus={liveStatus}
        currentNodeId={activeNodeId}
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
    .sort((a, b) => (b[1].costUsd ?? 0) - (a[1].costUsd ?? 0))

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs font-medium text-muted-foreground mb-2">总览</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">总成本</div>
            <div className="text-lg font-bold tabular-nums text-amber-600">
              {formatCost(aggregates.totals.cost.usd, aggregates.totals.cost.complete)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">调用次数</div>
            <div className="text-lg font-bold tabular-nums">{aggregates.totalCalls}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Cache Hit Rate</div>
            <div className="text-lg font-bold tabular-nums">{formatPercent(aggregates.totals.cacheHitRate)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Input / Output</div>
            <div className="text-sm tabular-nums">
              ↑{formatTokenCount(aggregates.usage.inputTokens)} ↓{formatTokenCount(aggregates.usage.outputTokens)}
            </div>
          </div>
        </div>
        <CostLine
          costUsd={aggregates.totals.cost.usd}
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
                  {formatCost(stats.costUsd)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}