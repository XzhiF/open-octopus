"use client"

import { useEffect, useState, useCallback, Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Loader2,
} from "lucide-react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"
import { formatTokenCount, formatCurrency } from "@/lib/analytics-format"

// ============ Types ============

interface ObservabilityData {
  executionId: string
  status: string
  tokens: {
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    totals: { tokens: number; cost: { usd: number | null; complete: boolean }; cacheHitRate: number | null }
  }
  byNode: Array<{
    nodeId: string
    nodeName: string
    nodeType: string
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    llmTurns: number
    loopIterations: number
    swarmRounds: number
    retryCount: number
    durationMs: number
    error: string | null
  }>
  byModel: Array<{
    model: string
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number | null
    callCount: number
  }>
  timeSeries: Array<{
    timestamp: string
    nodeId: string
    cumulativeInputTokens: number
    cumulativeOutputTokens: number
    cumulativeCostUsd: number
    turnIndex: number
  }>
  budget: {
    snapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number } | null
    progress: {
      tokensPercent: number | null
      durationPercent: number | null
      costPercent: number | null
    }
    alerts: Array<{
      type: "warning" | "exceeded"
      metric: "tokens" | "duration" | "cost"
      threshold: number
      actual: number
      timestamp: string
    }>
  }
  errors: Array<{
    timestamp: string
    nodeId: string
    nodeName: string
    errorType: string
    errorMessage: string
    retryCount: number
    finalStatus: string
  }>
  rounds: {
    totalLlmTurns: number
    totalLoopIterations: number
    totalSwarmRounds: number
    totalRetries: number
  }
}

interface ObservabilityTabProps {
  workspaceId: string
  executionId: string
  isRunning?: boolean
}

// ============ Helpers ============

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return ts
  }
}

const ERROR_TYPE_COLORS: Record<string, string> = {
  timeout: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  model_error: "bg-red-500/10 text-red-600 border-red-500/30",
  script_error: "bg-orange-500/10 text-orange-600 border-orange-500/30",
  tool_error: "bg-rose-500/10 text-rose-600 border-rose-500/30",
  approval_rejected: "bg-purple-500/10 text-purple-600 border-purple-500/30",
  other: "bg-gray-500/10 text-gray-600 border-gray-500/30",
}

const PIE_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
]

// ============ Main Component ============

export function ObservabilityTab({ workspaceId, executionId, isRunning }: ObservabilityTabProps) {
  const [data, setData] = useState<ObservabilityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  // Fetch data from observability API (reused for both initial load and SSE-triggered refresh)
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/observability`,
      )
      if (!res.ok) throw new Error(`API 返回 ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载观测数据失败")
    } finally {
      setLoading(false)
    }
  }, [workspaceId, executionId])

  // Initial fetch + SSE subscription for live updates (shared connection)
  useEffect(() => {
    if (!workspaceId || !executionId) return

    // Initial load
    fetchData()

    const sseUrl = `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`

    const refreshOnEvent = (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data)
        if (payload.executionId === executionId) {
          fetchData()
        }
      } catch { /* skip */ }
    }

    const unsubs = [
      subscribeSSE(sseUrl, "execution_metrics", refreshOnEvent),
      subscribeSSE(sseUrl, "execution_status", refreshOnEvent),
      subscribeSSE(sseUrl, "node_end", refreshOnEvent),
      subscribeSSE(sseUrl, "budget_warning", refreshOnEvent),
    ]

    return () => { unsubs.forEach(fn => fn()) }
  }, [workspaceId, executionId, fetchData])

  // Polling fallback during execution: refetch every 10s while running
  // This catches updates when SSE events are sparse (e.g. long-running agent nodes)
  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(fetchData, 10_000)
    return () => clearInterval(interval)
  }, [isRunning, fetchData])

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p>{error ?? "未找到数据"}</p>
      </div>
    )
  }

  // C3: totals 由 server ledger 直供
  const { totals } = data.tokens
  const totalTokens = totals.tokens

  return (
    <div className="h-full overflow-y-auto px-2 py-2 space-y-3 text-xs">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-1.5">
        <MiniCard title="总 Token" value={formatTokenCount(totalTokens)}
          subtitle={`↑${formatTokenCount(data.tokens.usage.inputTokens)} ↓${formatTokenCount(data.tokens.usage.outputTokens)} ⚡${formatTokenCount(data.tokens.usage.cacheReadTokens)} 🗡️${formatTokenCount(data.tokens.usage.cacheCreationTokens)}`} />
        <MiniCard title="总轮次" value={String(data.rounds.totalLlmTurns)}
          subtitle={`Loop ${data.rounds.totalLoopIterations} / Swarm ${data.rounds.totalSwarmRounds}`} />
        <MiniCard title="总成本" value={totals.cost.usd === null ? "—" : formatCurrency(totals.cost.usd) + (totals.cost.complete ? "" : " ≈")} subtitle="USD" />
        <MiniBudgetCard budget={data.budget} />
      </div>

      {/* Token Trend */}
      {data.timeSeries.length > 0 && (
        <Section title="Token 消耗趋势">
          <ChartErrorBoundary componentName="Token 趋势图">
            <TokenTrendChart timeSeries={data.timeSeries} />
          </ChartErrorBoundary>
        </Section>
      )}

      {/* Node Consumption */}
      {data.byNode.length > 0 && (
        <Section title="节点消耗分解">
          <ChartErrorBoundary componentName="节点消耗图">
            <NodeConsumptionChart byNode={data.byNode} />
          </ChartErrorBoundary>
        </Section>
      )}

      {/* Model Usage */}
      {data.byModel.length > 0 && (
        <Section title="模型用量占比">
          <ChartErrorBoundary componentName="模型用量图">
            <ModelUsageChart byModel={data.byModel} />
          </ChartErrorBoundary>
        </Section>
      )}

      {/* Error Timeline */}
      {data.errors.length > 0 && (
        <Section title={`错误时间线 (${data.errors.length})`}>
          <ErrorTimeline errors={data.errors} />
        </Section>
      )}

      {/* Rounds Table */}
      {data.byNode.length > 0 && (
        <Section title="轮次明细">
          <RoundsTable byNode={data.byNode} expandedNodes={expandedNodes} onToggle={toggleNode} />
        </Section>
      )}
    </div>
  )
}

// ============ Sub-Components ============

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border/50 p-2 space-y-2">
      <h4 className="text-[11px] font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  )
}

function MiniCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{title}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {subtitle && <div className="text-[10px] text-muted-foreground">{subtitle}</div>}
    </div>
  )
}

function MiniBudgetCard({ budget }: { budget: ObservabilityData["budget"] }) {
  const { tokensPercent } = budget.progress
  const hasSnapshot = budget.snapshot !== null

  return (
    <div className="rounded bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">预算状态</div>
      {!hasSnapshot ? (
        <div className="text-sm text-muted-foreground">未设预算</div>
      ) : tokensPercent !== null ? (
        <>
          <div className={`text-sm font-semibold tabular-nums ${tokensPercent > 100 ? "text-red-500" : ""}`}>
            {tokensPercent.toFixed(1)}%
          </div>
          <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${tokensPercent > 100 ? "bg-red-500" : tokensPercent > 80 ? "bg-yellow-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(tokensPercent, 100)}%` }}
            />
          </div>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">不限</div>
      )}
    </div>
  )
}

function TokenTrendChart({ timeSeries }: { timeSeries: ObservabilityData["timeSeries"] }) {
  const chartData = timeSeries.map((ts) => ({
    time: formatTimestamp(ts.timestamp),
    inputTokens: ts.cumulativeInputTokens,
    outputTokens: ts.cumulativeOutputTokens,
    cost: ts.cumulativeCostUsd,
  }))

  return (
    <div className="h-[160px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey="time" tick={{ fontSize: 9 }} />
          <YAxis yAxisId="tokens" tick={{ fontSize: 9 }} width={40} />
          <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 9 }} width={40} />
          <Tooltip contentStyle={{ fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <Line yAxisId="tokens" type="monotone" dataKey="inputTokens" name="输入" stroke="#3b82f6" dot={false} strokeWidth={1.5} />
          <Line yAxisId="tokens" type="monotone" dataKey="outputTokens" name="输出" stroke="#10b981" dot={false} strokeWidth={1.5} />
          <Line yAxisId="cost" type="monotone" dataKey="cost" name="成本" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function NodeConsumptionChart({ byNode }: { byNode: ObservabilityData["byNode"] }) {
  const chartData = byNode.map((node) => ({
    name: node.nodeName.length > 12 ? node.nodeName.slice(0, 12) + "…" : node.nodeName,
    inputTokens: node.inputTokens,
    outputTokens: node.outputTokens,
  }))

  return (
    <div style={{ height: Math.max(byNode.length * 32, 120), minHeight: 120 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis type="number" tick={{ fontSize: 9 }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={90} />
          <Tooltip contentStyle={{ fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <Bar dataKey="inputTokens" name="输入" fill="#3b82f6" radius={[0, 3, 3, 0]} />
          <Bar dataKey="outputTokens" name="输出" fill="#10b981" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ModelUsageChart({ byModel }: { byModel: ObservabilityData["byModel"] }) {
  const chartData = byModel.map((m) => {
    const cacheRead = m.cacheReadTokens
    const cacheWrite = m.cacheCreationTokens
    let cacheFlag = ""
    if (cacheRead === 0 && cacheWrite === 0) cacheFlag = "无缓存"
    else if (cacheWrite === 0) cacheFlag = "无写"
    else if (cacheRead === 0) cacheFlag = "只写不读"
    return {
      name: m.model,
      value: m.inputTokens + m.outputTokens + cacheRead + cacheWrite,
      cost: m.costUsd ?? 0, // 图轴需要数；未定价行画 0（列表列显示 —）
      cacheRead,
      cacheWrite,
      cacheFlag,
    }
  })

  return (
    <div className="flex items-start gap-4">
      <div className="h-[120px] w-[120px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={chartData} cx="50%" cy="50%" outerRadius={50} dataKey="value" nameKey="name"
              label={({ percent }) => `${(percent * 100).toFixed(0)}%`} labelLine={false}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {chartData.map((item, i) => (
          <div key={item.name} className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
              <span className="font-mono truncate max-w-24" title={item.name}>{item.name}</span>
              <span className="text-muted-foreground ml-auto tabular-nums">{formatTokenCount(item.value)}</span>
              <span className="text-muted-foreground tabular-nums">{formatCurrency(item.cost)}</span>
            </div>
            <div className="flex items-center gap-1.5 pl-4 text-[10px] text-muted-foreground tabular-nums">
              <span>⚡{formatTokenCount(item.cacheRead)}</span>
              <span>🗡️{formatTokenCount(item.cacheWrite)}</span>
              {item.cacheFlag && (
                <span className="text-amber-500">⚠ {item.cacheFlag}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ErrorTimeline({ errors }: { errors: ObservabilityData["errors"] }) {
  return (
    <div className="space-y-2 max-h-60 overflow-y-auto">
      {errors.map((err, i) => (
        <div key={`${err.nodeId}-${err.timestamp}-${i}`} className="flex items-start gap-2 rounded border border-border/50 p-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-muted-foreground font-mono">{formatTimestamp(err.timestamp)}</span>
              <span className="text-[11px] font-medium">{err.nodeName}</span>
              <Badge variant="outline" className={`text-[9px] px-1 ${ERROR_TYPE_COLORS[err.errorType] ?? ERROR_TYPE_COLORS.other}`}>
                {err.errorType}
              </Badge>
              <Badge variant="secondary" className={`text-[9px] px-1 ${
                err.finalStatus === "recovered" ? "bg-emerald-500/10 text-emerald-600"
                  : err.finalStatus === "failed" ? "bg-red-500/10 text-red-600"
                    : "bg-gray-500/10 text-gray-600"
              }`}>
                {err.finalStatus}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground truncate" title={err.errorMessage}>{err.errorMessage}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function RoundsTable({
  byNode,
  expandedNodes,
  onToggle,
}: {
  byNode: ObservabilityData["byNode"]
  expandedNodes: Set<string>
  onToggle: (nodeId: string) => void
}) {
  return (
    <Table className="text-[10px]">
      <TableHeader>
        <TableRow className="h-7">
          <TableHead className="w-6 p-1" />
          <TableHead className="p-1 text-[10px]">节点</TableHead>
          <TableHead className="p-1 text-[10px]">类型</TableHead>
          <TableHead className="p-1 text-[10px] text-right">Token</TableHead>
          <TableHead className="p-1 text-[10px] text-right">成本</TableHead>
          <TableHead className="p-1 text-[10px] text-right">耗时</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {byNode.map((node) => {
          const isExpanded = expandedNodes.has(node.nodeId)
          const totalTokens = node.tokens
          return (
            <Fragment key={node.nodeId}>
              <TableRow className="cursor-pointer hover:bg-muted/50 h-7" onClick={() => onToggle(node.nodeId)}>
                <TableCell className="p-1">
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </TableCell>
                <TableCell className="p-1 font-medium truncate max-w-24">{node.nodeName}</TableCell>
                <TableCell className="p-1"><Badge variant="outline" className="text-[9px] px-1">{node.nodeType}</Badge></TableCell>
                <TableCell className="p-1 text-right tabular-nums">{formatTokenCount(totalTokens)}</TableCell>
                <TableCell className="p-1 text-right tabular-nums">{node.costUsd === null ? "—" : formatCurrency(node.costUsd)}</TableCell>
                <TableCell className="p-1 text-right tabular-nums">{(node.durationMs / 1000).toFixed(1)}s</TableCell>
              </TableRow>
              {isExpanded && (
                <TableRow key={`${node.nodeId}-detail`} className="bg-muted/20">
                  <TableCell colSpan={6} className="p-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">LLM 轮次</span>
                        <span className="font-mono tabular-nums">{node.llmTurns}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Loop 迭代</span>
                        <span className="font-mono tabular-nums">{node.loopIterations}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Swarm 轮数</span>
                        <span className="font-mono tabular-nums">{node.swarmRounds}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">重试次数</span>
                        <span className="font-mono tabular-nums">{node.retryCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">输入 Token</span>
                        <span className="font-mono tabular-nums">{formatTokenCount(node.inputTokens)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">输出 Token</span>
                        <span className="font-mono tabular-nums">{formatTokenCount(node.outputTokens)}</span>
                      </div>
                      {node.cacheReadTokens > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">⚡ 缓存读取</span>
                          <span className="font-mono tabular-nums">{formatTokenCount(node.cacheReadTokens)}</span>
                        </div>
                      )}
                      {node.cacheCreationTokens > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">🗡️ 缓存创建</span>
                          <span className="font-mono tabular-nums">{formatTokenCount(node.cacheCreationTokens)}</span>
                        </div>
                      )}
                      {node.error && (
                        <div className="col-span-2 mt-1 rounded bg-red-500/10 border border-red-500/20 p-1.5">
                          <span className="text-red-500 font-medium">错误: </span>
                          <span className="text-muted-foreground">{node.error}</span>
                        </div>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}
