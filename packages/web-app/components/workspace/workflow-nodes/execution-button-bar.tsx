"use client"

import { Button } from "@/components/ui/button"
import type { ExecutionStatus, GateStatus } from "@/lib/types"
import {
  Play,
  RotateCcw,
  Square,
  FileText,
  SkipForward,
  Trash2,
  CheckCircle,
  Pause,
  Loader2,
} from "lucide-react"

interface ExecutionButtonBarProps {
  isLeaf: boolean
  executionStatus: ExecutionStatus
  gateStatus: GateStatus
  parentGateStatus: GateStatus | null
  parentId?: string | null
  rollback: "git-revert" | "none"
  hasApproval?: boolean
  pausing?: boolean
  onDetail?: () => void
  onExecute?: () => void
  onRetry?: () => void
  onSkip?: () => void
  onTerminate?: () => void
  onDelete?: () => void
  onApprove?: () => void
  onPause?: () => void
  onResume?: () => void
}

export function ExecutionButtonBar({
  isLeaf,
  executionStatus,
  gateStatus,
  parentGateStatus,
  parentId,
  hasApproval,
  pausing,
  onDetail,
  onExecute,
  onRetry,
  onSkip,
  onTerminate,
  onDelete,
  onApprove,
  onPause,
  onResume,
}: ExecutionButtonBarProps) {
  const parentGateOpen = parentGateStatus === "open" || parentGateStatus === "bypassed"
  const isRoot = parentId === "0" || parentId === null
  const isPendingLike = executionStatus === "pending"
  const showExecute = isRoot
    ? (isPendingLike && gateStatus !== "bypassed")
    : (parentGateOpen && isPendingLike && gateStatus !== "bypassed")
  const showRetry = executionStatus === "failed" || executionStatus === "budget_exceeded"
  const showSkip = (executionStatus === "pending" || executionStatus === "pending_resume" || executionStatus === "failed" || executionStatus === "cancelled" || executionStatus === "budget_exceeded") && gateStatus !== "bypassed"
  const showTerminate = executionStatus === "running" || executionStatus === "paused" || executionStatus === "pending_approval" || executionStatus === "pending_resume"
  const showPause = executionStatus === "running"
  const showResume = executionStatus === "paused" || executionStatus === "pending_resume"
  const showDelete = isLeaf && (isPendingLike || executionStatus === "failed" || executionStatus === "cancelled" || executionStatus === "rejected" || executionStatus === "budget_exceeded")
  const showApprove = executionStatus === "pending_approval" && hasApproval

  return (
    <div className="flex flex-wrap items-center gap-1 mt-2 nodrag min-w-0">
      <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-green border-pop-green/40 hover:bg-pop-green-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onDetail?.() }}>
        <FileText className="h-3 w-3" />详细
      </Button>
      {showApprove && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-purple border-pop-purple/40 hover:bg-pop-purple-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onApprove?.() }}>
          <CheckCircle className="h-3 w-3" />审批
        </Button>
      )}
      {showExecute && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-cyan border-pop-cyan/40 hover:bg-pop-cyan-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onExecute?.() }}>
          <Play className="h-3 w-3" />执行
        </Button>
      )}
      {(showPause || pausing) && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-xs gap-1 text-pop-ink border-pop-amber/60 hover:bg-pop-amber-soft cursor-pointer whitespace-nowrap"
          onClick={(e) => { e.stopPropagation(); if (!pausing) onPause?.() }}
          disabled={pausing}
        >
          {pausing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          {pausing ? "暂停中..." : "暂停"}
        </Button>
      )}
      {showResume && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-green border-pop-green/40 hover:bg-pop-green-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onResume?.() }}>
          <Play className="h-3 w-3" />继续
        </Button>
      )}
      {showRetry && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-red border-pop-red/40 hover:bg-pop-pink-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onRetry?.() }}>
          <RotateCcw className="h-3 w-3" />重试
        </Button>
      )}
      {showSkip && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-dim border-pop-bd/30 hover:bg-pop-idle cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onSkip?.() }}>
          <SkipForward className="h-3 w-3" />跳过
        </Button>
      )}
      {showTerminate && (
        <Button
          variant="destructive"
          size="sm"
          className="h-6 px-1.5 text-xs gap-1 cursor-pointer whitespace-nowrap"
          onClick={(e) => { e.stopPropagation(); onTerminate?.() }}
          disabled={pausing}
        >
          <Square className="h-3 w-3" />终止
        </Button>
      )}
      {showDelete && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-pop-red border-pop-red/40 hover:bg-pop-pink-soft cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onDelete?.() }}>
          <Trash2 className="h-3 w-3" />删除
        </Button>
      )}
    </div>
  )
}