"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { formatDuration, formatTokenCount } from "@/lib/format"
import { Timer as TimerIcon } from "lucide-react"
import type { StepExecution } from "@/lib/types"
import { AgentDetailTabs } from "@/components/node-detail/agent-detail-tabs"
import { BashDetailTabs } from "@/components/node-detail/bash-detail-tabs"
import { PythonDetailTabs } from "@/components/node-detail/python-detail-tabs"
import { ConditionDetailTabs } from "@/components/node-detail/condition-detail-tabs"
import { ApprovalDetailTabs } from "@/components/node-detail/approval-detail-tabs"
import { LoopDetailTabs } from "@/components/node-detail/loop-detail-tabs"
import { SwarmDetailTabs } from "@/components/node-detail/swarm-detail-tabs"
import { TokenUsageDisplay } from "./workflow-nodes/token-usage-display"
import { useLiveTimer } from "@/hooks/use-live-timer"

export interface NodeInfoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  step: StepExecution | null
  executorType: string | undefined
  workspaceId: string
  executionId: string
  isRunning: boolean
  onOpenSwarmDialog?: () => void
}

export function NodeInfoDialog({
  open,
  onOpenChange,
  step,
  executorType,
  workspaceId,
  executionId,
  isRunning,
  onOpenSwarmDialog,
}: NodeInfoDialogProps) {
  const startedAt = step?.status === "running" ? step?.startedAt : undefined
  const elapsedSeconds = useLiveTimer(startedAt)

  if (!step) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[1024px] max-w-[90vw] sm:max-w-[1024px] h-[85vh] flex flex-col overflow-hidden p-0"
        showCloseButton={true}
      >
        <DialogTitle className="sr-only">节点详情</DialogTitle>
        <DialogDescription className="sr-only">
          {step.stepName} 的执行详情
        </DialogDescription>

        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-3 border-b border-border/30">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold truncate">{step.stepName}</h3>
            <Badge variant="outline" className="text-xs">
              {executorType ?? "unknown"}
            </Badge>
            <Badge
              variant="outline"
              className={`text-xs ${
                step.status === "completed" ? "text-emerald-600" :
                step.status === "failed" ? "text-red-600" :
                step.status === "running" ? "text-amber-600" :
                "text-muted-foreground"
              }`}
            >
              {step.status}
            </Badge>
            {step.status === "running" && elapsedSeconds !== undefined && (
              <span className="text-xs text-amber-600 tabular-nums">
                <TimerIcon className="h-3 w-3 inline mr-1" />{formatDuration(elapsedSeconds)}
              </span>
            )}
            {step.status !== "running" && step.duration !== undefined && (
              <span className="text-xs text-muted-foreground">
                耗时: {formatDuration(step.duration)}
              </span>
            )}
            {step.tokensInput != null && step.tokensInput > 0 && (
              <span className="text-xs tabular-nums border-l border-border/50 pl-3">
                <span className="font-semibold">↑</span>{formatTokenCount(step.tokensInput)}{" "}
                <span className="font-semibold">↓</span>{formatTokenCount(step.tokensOutput ?? 0)}
              </span>
            )}
          </div>
        </div>

        {/* Content — executor-specific tabs or fallback */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {executorType === "agent" && (
            <AgentDetailTabs
              executionId={executionId}
              nodeId={step.stepId}
              step={step}
              workspaceId={workspaceId}
              isRunning={isRunning}
            />
          )}
          {executorType === "bash" && <BashDetailTabs step={step} isRunning={isRunning} />}
          {executorType === "python" && <PythonDetailTabs step={step} isRunning={isRunning} />}
          {executorType === "condition" && <ConditionDetailTabs step={step} isRunning={isRunning} />}
          {executorType === "approval" && <ApprovalDetailTabs step={step} isRunning={isRunning} />}
          {executorType === "loop" && <LoopDetailTabs step={step} isRunning={isRunning} />}
          {executorType === "swarm" && (
            <SwarmDetailTabs
              executionId={executionId}
              nodeId={step.stepId}
              step={step}
              workspaceId={workspaceId}
              isRunning={isRunning}
              onOpenSwarmDialog={onOpenSwarmDialog}
            />
          )}
          {!executorType && (
            <div className="overflow-auto h-full p-4 text-xs">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">名称:</span>
                  <span className="font-medium">{step.stepName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">状态:</span>
                  <Badge variant="outline" className="text-xs">{step.status}</Badge>
                </div>
              </div>
              {step.tokenUsages && step.tokenUsages.length > 0 && (
                <div className="mt-3">
                  <TokenUsageDisplay usages={step.tokenUsages} isRunning={step.status === "running"} />
                </div>
              )}
              {step.output && (
                <div className="mt-3">
                  <span className="text-muted-foreground">输出:</span>
                  <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-[300px]">{step.output}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
