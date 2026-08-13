"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  ArrowLeft,
  Coins,
  Repeat,
  DollarSign,
  Gauge,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Info,
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

// ============ Types ============

interface ObservabilityData {
  executionId: string
  status: string
  tokens: {
    totalInput: number
    totalOutput: number
    totalCacheRead: number
    totalCacheCreation: number
    totalCostUsd: number
  }
  byNode: Array<{
    nodeId: string
    nodeName: string
    nodeType: string
    inputTokens: number
    outputTokens: number
    cacheTokens: number
    costUsd: number
    llmTurns: number
    loopIterations: number
    swarmRounds: number
    retryCount: number
    durationMs: number
    error: string | null
  }>
  byModel: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cacheTokens: number
    costUsd: number
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

// ============ Helpers ============

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

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
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
]

// ============ Page Component ============

export default function ObservabilityPage() {
  const params = useParams()
  const workspaceId = params.id as string
  const executionId = params.eid as string

  const [data, setData] = useState<ObservabilityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(
          `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/observability`,
        )
        if (!res.ok) throw new Error(`API 返回 ${res.status}`)
        const json: ObservabilityData = await res.json()
        setData(json)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载观测数据失败")
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [workspaceId, executionId])

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-muted rounded w-1/3" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-muted rounded-lg" />
            ))}
          </div>
          <div className="h-64 bg-muted rounded-lg" />
          <div className="h-48 bg-muted rounded-lg" />
        </div>
      </div>
    )
  }

  // Error state
  if (error || !data) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center space-y-4">
          <AlertTriangle className="h-12 w-12 mx-auto text-amber-500" />
          <h2 className="text-xl font-semibold">加载观测数据失败</h2>
          <p className="text-muted-foreground">{error ?? "未找到数据"}</p>
          <Button asChild variant="outline">
            <Link href={`/workspaces/${workspaceId}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回工作空间
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const totalTokens = data.tokens.totalInput + data.tokens.totalOutput + data.tokens.totalCacheRead + data.tokens.totalCacheCreation

  return (
    <div className="container mx-auto py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/workspaces/${workspaceId}`}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回
              </Link>
            </Button>
            <Badge variant="secondary">{data.status}</Badge>
          </div>
          <h1 className="text-2xl font-bold">执行观测详情</h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            {data.executionId}
          </p>
        </div>
      </div>

      {/* Section 1: Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard
          title="总 Token"
          value={formatNumber(totalTokens)}
          subtitle={`↑${formatNumber(data.tokens.totalInput)} ↓${formatNumber(data.tokens.totalOutput)} ⚡${formatNumber(data.tokens.totalCacheRead)} 🗡️${formatNumber(data.tokens.totalCacheCreation)}`}
          icon={Coins}
          color="text-blue-500"
          bgColor="bg-blue-500/10"
        />
        <SummaryCard
          title="总轮次"
          value={String(data.rounds.totalLlmTurns)}
          subtitle={`Loop ${data.rounds.totalLoopIterations} / Swarm ${data.rounds.totalSwarmRounds}`}
          icon={Repeat}
          color="text-emerald-500"
          bgColor="bg-emerald-500/10"
        />
        <SummaryCard
          title="总成本"
          value={`$${data.tokens.totalCostUsd.toFixed(4)}`}
          subtitle="USD"
          icon={DollarSign}
          color="text-amber-500"
          bgColor="bg-amber-500/10"
        />
        <BudgetCard budget={data.budget} />
      </div>

      {/* Section 2: Token Trend Line Chart */}
      <Card className="gap-0">
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium mb-4">Token 消耗趋势</h3>
          <ChartErrorBoundary componentName="Token 趋势图">
            <TokenTrendChart timeSeries={data.timeSeries} />
          </ChartErrorBoundary>
        </CardContent>
      </Card>

      {/* Section 3: Node Consumption Bar Chart */}
      <Card className="gap-0">
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium mb-4">节点消耗分解</h3>
          <ChartErrorBoundary componentName="节点消耗图">
            <NodeConsumptionChart byNode={data.byNode} />
          </ChartErrorBoundary>
        </CardContent>
      </Card>

      {/* Section 4: Model Usage Pie Chart */}
      {data.byModel.length > 0 && (
        <Card className="gap-0">
          <CardContent className="pt-6">
            <h3 className="text-sm font-medium mb-4">模型用量占比</h3>
            <ChartErrorBoundary componentName="模型用量图">
              <ModelUsageChart byModel={data.byModel} />
            </ChartErrorBoundary>
          </CardContent>
        </Card>
      )}

      {/* Section 5: Error Timeline */}
      <Card className="gap-0">
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium mb-4">
            错误时间线
            {data.errors.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {data.errors.length}
              </Badge>
            )}
          </h3>
          <ErrorTimeline errors={data.errors} />
        </CardContent>
      </Card>

      {/* Section 6: Rounds Detail Expandable Table */}
      <Card className="gap-0">
        <CardContent className="pt-6">
          <h3 className="text-sm font-medium mb-4">轮次明细</h3>
          <RoundsTable
            byNode={data.byNode}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
          />
        </CardContent>
      </Card>

      {/* Section 7: Footer note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="h-3 w-3" />
        <span>Token 指标仅反映 LLM 消耗节点</span>
      </div>
    </div>
  )
}

// ============ Sub-Components ============

function SummaryCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
  bgColor,
}: {
  title: string
  value: string
  subtitle?: string
  icon: React.ComponentType<{ className?: string }>
  color: string
  bgColor: string
}) {
  return (
    <Card className="gap-0">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold tabular-nums">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${bgColor}`}>
            <Icon className={`h-4 w-4 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function BudgetCard({ budget }: { budget: ObservabilityData["budget"] }) {
  const hasSnapshot = budget.snapshot !== null
  const { tokensPercent, durationPercent, costPercent } = budget.progress

  return (
    <Card className="gap-0">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1 flex-1">
            <p className="text-xs font-medium text-muted-foreground">预算状态</p>
            {!hasSnapshot ? (
              <p className="text-lg font-semibold text-muted-foreground">未设预算</p>
            ) : (
              <div className="space-y-2 mt-2">
                {tokensPercent !== null && (
                  <BudgetProgressRow
                    label="Token"
                    percent={tokensPercent}
                    limit={budget.snapshot?.max_tokens}
                  />
                )}
                {durationPercent !== null && (
                  <BudgetProgressRow
                    label="时长"
                    percent={durationPercent}
                    limit={budget.snapshot?.max_duration}
                  />
                )}
                {costPercent !== null && (
                  <BudgetProgressRow
                    label="成本"
                    percent={costPercent}
                    limit={budget.snapshot?.max_cost_usd}
                  />
                )}
                {tokensPercent === null && durationPercent === null && costPercent === null && (
                  <p className="text-sm text-muted-foreground">未设预算上限</p>
                )}
              </div>
            )}
          </div>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10">
            <Gauge className="h-4 w-4 text-purple-500" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function BudgetProgressRow({
  label,
  percent,
  limit,
}: {
  label: string
  percent: number
  limit?: number
}) {
  const isExceeded = percent > 100
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={isExceeded ? "text-red-500 font-medium" : ""}>
          {percent.toFixed(1)}%
        </span>
      </div>
      <Progress value={Math.min(percent, 100)} className={isExceeded ? "[&_[data-slot=progress-indicator]]:bg-red-500" : ""} />
    </div>
  )
}

function TokenTrendChart({
  timeSeries,
}: {
  timeSeries: ObservabilityData["timeSeries"]
}) {
  if (timeSeries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        暂无时间序列数据
      </div>
    )
  }

  const chartData = timeSeries.map((ts) => ({
    time: formatTimestamp(ts.timestamp),
    inputTokens: ts.cumulativeInputTokens,
    outputTokens: ts.cumulativeOutputTokens,
    cost: ts.cumulativeCostUsd,
  }))

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey="time" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="tokens" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 10 }} />
          <Tooltip />
          <Legend />
          <Line
            yAxisId="tokens"
            type="monotone"
            dataKey="inputTokens"
            name="输入 Token"
            stroke="#3b82f6"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="tokens"
            type="monotone"
            dataKey="outputTokens"
            name="输出 Token"
            stroke="#10b981"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="cost"
            type="monotone"
            dataKey="cost"
            name="成本 ($)"
            stroke="#f59e0b"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function NodeConsumptionChart({
  byNode,
}: {
  byNode: ObservabilityData["byNode"]
}) {
  if (byNode.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        暂无节点数据
      </div>
    )
  }

  const chartData = byNode.map((node) => ({
    name: node.nodeName.length > 15 ? node.nodeName.slice(0, 15) + "..." : node.nodeName,
    inputTokens: node.inputTokens,
    outputTokens: node.outputTokens,
    cost: node.costUsd,
  }))

  return (
    <div className="h-64" style={{ minHeight: Math.max(byNode.length * 40, 160) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis type="number" tick={{ fontSize: 10 }} />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 10 }}
            width={120}
          />
          <Tooltip />
          <Legend />
          <Bar
            dataKey="inputTokens"
            name="输入 Token"
            fill="#3b82f6"
            radius={[0, 4, 4, 0]}
          />
          <Bar
            dataKey="outputTokens"
            name="输出 Token"
            fill="#10b981"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ModelUsageChart({
  byModel,
}: {
  byModel: ObservabilityData["byModel"]
}) {
  if (byModel.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        暂无模型数据
      </div>
    )
  }

  const chartData = byModel.map((m) => ({
    name: m.model,
    value: m.inputTokens + m.outputTokens + m.cacheTokens,
    cost: m.costUsd,
  }))

  return (
    <div className="flex flex-col md:flex-row items-center gap-6">
      <div className="h-56 w-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              outerRadius={80}
              dataKey="value"
              nameKey="name"
              label={({ name, percent }) =>
                `${name.replace("claude-", "").slice(0, 12)} (${(percent * 100).toFixed(0)}%)`
              }
              labelLine={false}
            >
              {chartData.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={PIE_COLORS[index % PIE_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 space-y-2">
        {chartData.map((item, index) => (
          <div key={item.name} className="flex items-center gap-2 text-sm">
            <div
              className="h-3 w-3 rounded-full shrink-0"
              style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}
            />
            <span className="font-mono text-xs truncate max-w-48" title={item.name}>
              {item.name}
            </span>
            <span className="text-muted-foreground ml-auto">
              {formatNumber(item.value)} tokens
            </span>
            <span className="text-muted-foreground text-xs">
              ${item.cost.toFixed(4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ErrorTimeline({
  errors,
}: {
  errors: ObservabilityData["errors"]
}) {
  if (errors.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        无错误记录
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {errors.map((err, i) => (
        <div
          key={`${err.nodeId}-${err.timestamp}-${i}`}
          className="flex items-start gap-3 rounded-lg border p-3"
        >
          <div className="shrink-0 mt-0.5">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">
                {formatTimestamp(err.timestamp)}
              </span>
              <span className="text-sm font-medium">{err.nodeName}</span>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 ${ERROR_TYPE_COLORS[err.errorType] ?? ERROR_TYPE_COLORS.other}`}
              >
                {err.errorType}
              </Badge>
              <Badge
                variant="secondary"
                className={`text-[10px] px-1.5 ${
                  err.finalStatus === "recovered"
                    ? "bg-emerald-500/10 text-emerald-600"
                    : err.finalStatus === "failed"
                      ? "bg-red-500/10 text-red-600"
                      : "bg-gray-500/10 text-gray-600"
                }`}
              >
                {err.finalStatus}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground truncate" title={err.errorMessage}>
              {err.errorMessage}
            </p>
            {err.retryCount > 0 && (
              <p className="text-xs text-muted-foreground">
                重试 {err.retryCount} 次
              </p>
            )}
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
  if (byNode.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        暂无节点数据
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>节点名称</TableHead>
          <TableHead>类型</TableHead>
          <TableHead className="text-right">Token</TableHead>
          <TableHead className="text-right">成本</TableHead>
          <TableHead className="text-right">耗时</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {byNode.map((node) => {
          const isExpanded = expandedNodes.has(node.nodeId)
          return (
            <NodeRow
              key={node.nodeId}
              node={node}
              isExpanded={isExpanded}
              onToggle={() => onToggle(node.nodeId)}
            />
          )
        })}
      </TableBody>
    </Table>
  )
}

function NodeRow({
  node,
  isExpanded,
  onToggle,
}: {
  node: ObservabilityData["byNode"][number]
  isExpanded: boolean
  onToggle: () => void
}) {
  const totalTokens = node.inputTokens + node.outputTokens + node.cacheTokens

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        <TableCell>
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="font-medium">{node.nodeName}</TableCell>
        <TableCell>
          <Badge variant="outline" className="text-[10px]">
            {node.nodeType}
          </Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatNumber(totalTokens)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          ${node.costUsd.toFixed(4)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {(node.durationMs / 1000).toFixed(1)}s
        </TableCell>
      </TableRow>
      {isExpanded && (
        <TableRow className="bg-muted/30">
          <TableCell />
          <TableCell colSpan={5}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-2">
              <DetailItem label="LLM 轮次" value={node.llmTurns} />
              <DetailItem label="Loop 迭代" value={node.loopIterations} />
              <DetailItem label="Swarm 轮数" value={node.swarmRounds} />
              <DetailItem label="重试次数" value={node.retryCount} />
            </div>
            {node.error && (
              <div className="mt-2 text-xs text-red-500">
                错误: {node.error}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function DetailItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}
