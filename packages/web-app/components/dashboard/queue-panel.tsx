"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import type { Execution } from "@/lib/types"
import {
  Play,
  Clock,
  ExternalLink,
} from "lucide-react"

interface QueuePanelProps {
  runningExecutions: Execution[]
  pendingExecutions: Execution[]
}

function ExecutionItem({ execution }: { execution: Execution }) {
  const isRunning = execution.status === "running"

  return (
    <div className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/50">
      {/* Status indicator */}
      <div className="flex-shrink-0">
        {isRunning ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
            <Play className="h-4 w-4 text-amber-500" />
          </div>
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate font-medium">{execution.workflowName}</h4>
          <Badge variant={isRunning ? "default" : "secondary"} className="flex-shrink-0">
            {isRunning ? "运行中" : "待开始"}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {execution.workspaceName}
          {execution.currentStep && (
            <span className="ml-2 text-foreground/70">
              · {execution.currentStep}
            </span>
          )}
        </p>
        {isRunning && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={execution.progress} className="h-1.5 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {execution.progress}%
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/workspaces/${execution.workspaceId}?tab=detail&execId=${execution.id}`}>
            <ExternalLink className="h-4 w-4" />
            <span className="sr-only">查看详情</span>
          </Link>
        </Button>
      </div>
    </div>
  )
}

export function QueuePanel({ runningExecutions, pendingExecutions }: QueuePanelProps) {
  const allExecutions = [...runningExecutions, ...pendingExecutions]

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">执行队列</CardTitle>
          <Badge variant="outline" className="font-mono">
            {runningExecutions.length} 运行中 · {pendingExecutions.length} 待开始
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {allExecutions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <h3 className="mt-3 text-sm font-medium">没有正在执行的任务</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              进入工作空间执行工作流后，运行中的任务将显示在这里
            </p>
          </div>
        ) : (
          allExecutions.map((execution) => (
            <ExecutionItem key={execution.id} execution={execution} />
          ))
        )}
      </CardContent>
    </Card>
  )
}
