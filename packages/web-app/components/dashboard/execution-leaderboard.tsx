"use client"

import { Trophy } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDuration } from "@/lib/format"
import type { LeaderboardResponse, LeaderboardEntry } from "@octopus/shared"

interface ExecutionLeaderboardProps {
  data: LeaderboardResponse | null
  loading?: boolean
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default"
  if (status === "completed_with_failures") return "secondary"
  if (status === "failed") return "destructive"
  return "outline"
}

function statusLabel(status: string): string {
  if (status === "completed") return "完成"
  if (status === "completed_with_failures") return "部分失败"
  if (status === "failed") return "失败"
  if (status === "cancelled") return "已取消"
  return status
}

function CheapestTab({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p>
  }
  return (
    <div role="list" aria-label="最省钱排行">
      {entries.map((entry, i) => (
        <div key={entry.id} className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0" role="listitem">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.workflow_name}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">${entry.total_cost_usd.toFixed(4)}</span>
              <span className="tabular-nums">{formatDuration(entry.duration_ms ? entry.duration_ms / 1000 : undefined)}</span>
            </div>
          </div>
          <Badge variant={statusVariant(entry.status)} className="text-[10px]">
            {statusLabel(entry.status)}
          </Badge>
        </div>
      ))}
    </div>
  )
}

function FastestTab({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p>
  }
  return (
    <div role="list" aria-label="最快排行">
      {entries.map((entry, i) => (
        <div key={entry.id} className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0" role="listitem">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.workflow_name}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{formatDuration(entry.duration_ms ? entry.duration_ms / 1000 : undefined)}</span>
              <span className="tabular-nums">${entry.total_cost_usd.toFixed(4)}</span>
            </div>
          </div>
          <Badge variant={statusVariant(entry.status)} className="text-[10px]">
            {statusLabel(entry.status)}
          </Badge>
        </div>
      ))}
    </div>
  )
}

function ReliableTab({ entries }: { entries: LeaderboardResponse["most_reliable"] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p>
  }
  return (
    <div role="list" aria-label="最可靠排行">
      {entries.map((entry, i) => (
        <div key={entry.workflow_name} className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0" role="listitem">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.workflow_name}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{entry.runs} runs</span>
              <span className="tabular-nums">{(entry.success_rate * 100).toFixed(1)}%</span>
              <span className="tabular-nums">${entry.total_cost_usd.toFixed(4)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ExecutionLeaderboard({ data, loading }: ExecutionLeaderboardProps) {
  if (loading) {
    return (
      <Card className="py-3 gap-2" role="region" aria-label="执行排行榜">
        <CardHeader className="pb-1 pt-1 px-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4" />
            执行排行榜
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pt-0">
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="py-3 gap-2" role="region" aria-label="执行排行榜">
      <CardHeader className="pb-1 pt-1 px-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-4 w-4" />
          执行排行榜
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pt-0">
        <Tabs defaultValue="cheapest">
          <TabsList className="w-full">
            <TabsTrigger value="cheapest" className="flex-1 text-xs">最省钱</TabsTrigger>
            <TabsTrigger value="fastest" className="flex-1 text-xs">最快</TabsTrigger>
            <TabsTrigger value="reliable" className="flex-1 text-xs">最可靠</TabsTrigger>
          </TabsList>
          <TabsContent value="cheapest" className="mt-2 overflow-y-auto max-h-[350px]">
            <CheapestTab entries={data?.cheapest ?? []} />
          </TabsContent>
          <TabsContent value="fastest" className="mt-2 overflow-y-auto max-h-[350px]">
            <FastestTab entries={data?.fastest ?? []} />
          </TabsContent>
          <TabsContent value="reliable" className="mt-2 overflow-y-auto max-h-[350px]">
            <ReliableTab entries={data?.most_reliable ?? []} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
