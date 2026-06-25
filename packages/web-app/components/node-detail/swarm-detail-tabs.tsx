"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSwarmEvents } from "@/hooks/use-swarm-events"
import { formatTokenCount } from "@/lib/format"
import { Users, MessageSquare, TrendingUp, ExternalLink, Zap } from "lucide-react"
import type { StepExecution } from "@/lib/types"

interface SwarmDetailTabsProps {
  executionId: string
  nodeId: string
  step?: StepExecution
  workspaceId: string
  isRunning: boolean
  onOpenSwarmDialog?: () => void
}

const modeLabels: Record<string, string> = {
  review: "并行审查",
  debate: "多轮辩论",
  dispatch: "DAG 调度",
  swarm: "动态编排",
}

export function SwarmDetailTabs({
  executionId,
  nodeId,
  workspaceId,
  isRunning,
  onOpenSwarmDialog,
}: SwarmDetailTabsProps) {
  const {
    status,
    mode,
    experts,
    currentRound,
    totalExperts,
    consensusHistory,
    finalResult,
    budgetExhausted,
    timeoutExceeded,
  } = useSwarmEvents(workspaceId, nodeId, executionId)

  const consensusScore = finalResult?.consensus_score ?? (
    consensusHistory.length > 0 ? consensusHistory[consensusHistory.length - 1].score : null
  )

  const roundsUsed = finalResult?.rounds_used ?? currentRound
  const expertCount = totalExperts || experts.length

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      {/* Summary Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">模式</div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{mode ? (modeLabels[mode] || mode) : "—"}</span>
            {mode && <Badge variant="outline" className="text-xs">{mode}</Badge>}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">状态</div>
          <Badge
            variant="outline"
            className={`text-xs ${
              status === "completed" ? "text-emerald-600" :
              status === "failed" ? "text-red-600" :
              status === "running" ? "text-amber-600" :
              "text-muted-foreground"
            }`}
          >
            {status || "unknown"}
          </Badge>
        </div>

        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Users className="h-3 w-3" />
            专家数
          </div>
          <div className="text-lg font-semibold tabular-nums">{expertCount}</div>
        </div>

        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            轮次
          </div>
          <div className="text-lg font-semibold tabular-nums">{roundsUsed || 0}</div>
        </div>

        {consensusScore !== null && (
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              共识分数
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {(consensusScore * 100).toFixed(0)}%
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Zap className="h-3 w-3" />
            预算
          </div>
          <Badge
            variant="outline"
            className={`text-xs ${
              budgetExhausted ? "text-red-600" :
              timeoutExceeded ? "text-amber-600" :
              "text-emerald-600"
            }`}
          >
            {budgetExhausted ? "已耗尽" : timeoutExceeded ? "已超时" : "正常"}
          </Badge>
        </div>
      </div>

      {/* Expert List with per-expert tokens */}
      {experts.length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground mb-2">专家列表</div>
          <div className="space-y-1.5">
            {experts.map((expert, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="secondary" className="text-xs shrink-0">{expert.role}</Badge>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${
                      expert.status === "completed" ? "text-emerald-600" :
                      expert.status === "failed" ? "text-red-600" :
                      expert.status === "running" ? "text-amber-600" :
                      "text-muted-foreground"
                    }`}
                  >
                    {expert.status}
                  </Badge>
                </div>
                {(expert.inputTokens > 0 || expert.outputTokens > 0) && (
                  <span className="tabular-nums text-muted-foreground shrink-0 ml-2">
                    <span className="font-medium">↑</span>{formatTokenCount(expert.inputTokens)}{" "}
                    <span className="font-medium">↓</span>{formatTokenCount(expert.outputTokens)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open Full Dialog Button */}
      {onOpenSwarmDialog && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={onOpenSwarmDialog} className="gap-2">
            <ExternalLink className="h-4 w-4" />
            打开完整 Swarm 详情
          </Button>
        </div>
      )}
    </div>
  )
}
