"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { AlertBanner } from "../atoms/alert-banner"
import { SwarmDialogSkeleton } from "./swarm-dialog-skeleton"
import { ExpertAvatar } from "../atoms/expert-avatar"
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  GitCompareArrows,
  ArrowLeft,
} from "lucide-react"
import type { ExpertInfo } from "@/lib/swarm-types"

// ── Types ──

export interface MoaExpertResult {
  role: string
  model: string
  status: "completed" | "failed"
  outputPreview: string
  durationMs: number
  degraded: boolean
  degradationChain?: string[]
}

export interface MoaResultTabProps {
  status: "initializing" | "running" | "completed" | "failed"
  experts: ExpertInfo[]
  moaExpertResults: MoaExpertResult[]
  aggregatorStatus: "idle" | "running" | "completed" | "failed"
  aggregatorRound: number
  aggregatorTotalRounds: number
  aggregatorModel: string
  aggregatorInputExpertCount: number
  hostReport: string | null
  onRetry?: () => void
}

export function MoaResultTab({
  status,
  experts,
  moaExpertResults,
  aggregatorStatus,
  aggregatorRound,
  aggregatorTotalRounds,
  aggregatorModel,
  aggregatorInputExpertCount,
  hostReport,
  onRetry,
}: MoaResultTabProps) {
  const [selectedExpert, setSelectedExpert] = useState<string | null>(null)
  const [outputExpanded, setOutputExpanded] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set())

  // Empty state
  if (status === "initializing" && experts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-3 py-12">
        <p className="text-sm">暂无执行数据</p>
        <p className="text-xs">MOA 执行启动后将在此处显示结果</p>
      </div>
    )
  }

  // Loading state
  if (status === "initializing" || (status === "running" && experts.length === 0)) {
    return <SwarmDialogSkeleton />
  }

  // Error — all experts failed
  const allFailed = experts.length > 0 && experts.every(
    (e) => e.status === "failed" || e.status === "budget_exceeded",
  )
  if (status === "failed" || allFailed) {
    return (
      <div className="space-y-3">
        <AlertBanner type="error" message="所有 Expert 执行失败" />
        <div className="space-y-2">
          {experts.map((e) => (
            <div key={e.role} className="rounded-md border border-destructive/30 p-2 text-sm">
              <span className="font-medium">{e.role}</span>: {e.error ?? "未知错误"}
            </div>
          ))}
        </div>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="gap-1">
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
        )}
      </div>
    )
  }

  // ── Compare subview ──
  if (compareMode) {
    const selectedExperts = experts.filter((e) => compareSelected.has(e.role))

    return (
      <div className="space-y-3 h-full flex flex-col">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" className="gap-1 h-7" onClick={() => setCompareMode(false)}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <div className="flex items-center gap-3 flex-wrap">
            {experts.map((e) => (
              <label key={e.role} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox
                  checked={compareSelected.has(e.role)}
                  onCheckedChange={(checked) => {
                    const next = new Set(compareSelected)
                    if (checked) next.add(e.role)
                    else next.delete(e.role)
                    setCompareSelected(next)
                  }}
                  aria-label={`选择 ${e.role} 进行对比`}
                />
                {e.role}
              </label>
            ))}
          </div>
        </div>

        {selectedExperts.length < 2 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            请选择至少 2 个 Expert 进行对比
          </p>
        ) : (
          <>
            <div className={cn(
              "flex gap-3 flex-1 min-h-0",
              selectedExperts.length > 2 && "overflow-x-auto",
            )}>
              {selectedExperts.map((e) => (
                <Card key={e.role} className="flex-1 min-w-[280px] max-w-[400px]">
                  <CardContent className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <ExpertAvatar role={e.role} size="sm" status={e.status} />
                      <span className="text-sm font-medium">{e.role}</span>
                      {e.status === "failed" && (
                        <Badge variant="destructive" className="text-[10px]">失败</Badge>
                      )}
                    </div>
                    <ScrollArea className="h-[200px]">
                      <p className="text-xs whitespace-pre-wrap">
                        {e.status === "failed" ? "输出不可用" : (e.output ?? "")}
                      </p>
                    </ScrollArea>
                  </CardContent>
                </Card>
              ))}
            </div>

            {hostReport && (
              <div className="rounded-md border border-moa-aggregator/30 bg-moa-aggregator-light p-3">
                <p className="text-xs font-medium text-moa-aggregator-foreground mb-1">
                  Aggregator 基线
                </p>
                <ScrollArea className="h-[100px]">
                  <p className="text-xs whitespace-pre-wrap">{hostReport}</p>
                </ScrollArea>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // ── Main result view ──
  const selectedExpertInfo = selectedExpert ? experts.find((e) => e.role === selectedExpert) : null

  return (
    <div className="space-y-3 h-full flex flex-col" role="tabpanel" aria-label="MOA 执行结果">
      {/* Expert card row */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {experts.map((e) => {
          const moaResult = moaExpertResults.find((r) => r.role === e.role)
          const isSelected = selectedExpert === e.role

          return (
            <button
              key={e.role}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors shrink-0 text-left",
                isSelected
                  ? "border-swarm-primary bg-swarm-primary/5 ring-1 ring-swarm-primary/30"
                  : "border-border hover:border-muted-foreground/30",
                (e.status === "failed" || e.status === "budget_exceeded") && "opacity-60",
              )}
              onClick={() => setSelectedExpert(e.role)}
              aria-pressed={isSelected}
              aria-label={`${e.role} - ${e.status}`}
            >
              <ExpertAvatar role={e.role} size="sm" status={e.status} />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{e.role}</p>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    {moaResult ? `${(moaResult.durationMs / 1000).toFixed(1)}s` : "..."}
                  </span>
                  {moaResult?.degraded && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 text-moa-resolve-degraded border-moa-resolve-degraded/40">
                      降级
                    </Badge>
                  )}
                  {(e.status === "failed" || e.status === "budget_exceeded") && (
                    <Badge variant="destructive" className="text-[9px] px-1 py-0">失败</Badge>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected expert output */}
      {selectedExpertInfo && (
        <div className="rounded-md border p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">{selectedExpertInfo.role} 输出</span>
            <Collapsible open={outputExpanded} onOpenChange={setOutputExpanded}>
              <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                {outputExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {outputExpanded ? "收起" : "展开全部"}
              </CollapsibleTrigger>
            </Collapsible>
          </div>
          <ScrollArea className={cn(outputExpanded ? "h-[40vh]" : "h-[120px]")}>
            <p className="text-sm whitespace-pre-wrap">
              {selectedExpertInfo.output ?? "暂无输出"}
            </p>
          </ScrollArea>
        </div>
      )}

      <Separator />

      {/* Aggregator output */}
      <div
        className="rounded-md border border-moa-aggregator/30 bg-moa-aggregator-light p-3"
        role="region"
        aria-label="聚合器输出"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium text-moa-aggregator-foreground">Aggregator</span>
          {aggregatorStatus === "running" && (
            <Badge variant="outline" className="text-[10px] animate-pulse">运行中...</Badge>
          )}
          {aggregatorStatus === "completed" && (
            <Badge variant="outline" className="text-[10px] text-moa-resolve-exact border-moa-resolve-exact/40">
              完成 · R{aggregatorRound}/{aggregatorTotalRounds}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {aggregatorModel} · {aggregatorInputExpertCount} experts
          </span>
        </div>
        <ScrollArea className="h-[150px]">
          <p className="text-sm whitespace-pre-wrap">
            {hostReport ?? (aggregatorStatus === "running" ? "聚合器正在处理..." : "暂无聚合输出")}
          </p>
        </ScrollArea>
      </div>

      {/* Compare toggle */}
      <Button
        size="sm"
        variant="outline"
        className="gap-1 self-end"
        onClick={() => {
          const successful = experts.filter((e) => e.status === "completed").slice(0, 2)
          setCompareSelected(new Set(successful.map((e) => e.role)))
          setCompareMode(true)
        }}
      >
        <GitCompareArrows className="h-3.5 w-3.5" />
        对比视图
      </Button>
    </div>
  )
}
