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
  const showExecute = isRoot
    ? (executionStatus === "pending" && gateStatus !== "bypassed")
    : (parentGateOpen && executionStatus === "pending" && gateStatus !== "bypassed")
  const showRetry = executionStatus === "failed"
  const showSkip = (executionStatus === "pending" || executionStatus === "failed" || executionStatus === "cancelled") && gateStatus !== "bypassed"
  const showTerminate = executionStatus === "running" || executionStatus === "paused" || executionStatus === "pending_approval"
  const showPause = executionStatus === "running"
  const showResume = executionStatus === "paused"
  const showDelete = isLeaf && (executionStatus === "pending" || executionStatus === "failed" || executionStatus === "cancelled" || executionStatus === "rejected")
  const showApprove = executionStatus === "pending_approval" && hasApproval

  return (
    <div className="flex flex-wrap items-center gap-1 mt-2 nodrag min-w-0">
      <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-emerald-600 border-emerald-300 hover:bg-emerald-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onDetail?.() }}>
        <FileText className="h-3 w-3" />详细
      </Button>
      {showApprove && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-violet-600 border-violet-300 hover:bg-violet-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onApprove?.() }}>
          <CheckCircle className="h-3 w-3" />审批
        </Button>
      )}
      {showExecute && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-blue-600 border-blue-300 hover:bg-blue-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onExecute?.() }}>
          <Play className="h-3 w-3" />执行
        </Button>
      )}
      {(showPause || pausing) && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-xs gap-1 text-amber-600 border-amber-300 hover:bg-amber-50 cursor-pointer whitespace-nowrap"
          onClick={(e) => { e.stopPropagation(); if (!pausing) onPause?.() }}
          disabled={pausing}
        >
          {pausing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          {pausing ? "暂停中..." : "暂停"}
        </Button>
      )}
      {showResume && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-emerald-600 border-emerald-300 hover:bg-emerald-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onResume?.() }}>
          <Play className="h-3 w-3" />继续
        </Button>
      )}
      {showRetry && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onRetry?.() }}>
          <RotateCcw className="h-3 w-3" />重试
        </Button>
      )}
      {showSkip && (
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-gray-600 border-gray-200 hover:bg-gray-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onSkip?.() }}>
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
        <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs gap-1 text-red-500 border-red-300 hover:bg-red-50 cursor-pointer whitespace-nowrap" onClick={(e) => { e.stopPropagation(); onDelete?.() }}>
          <Trash2 className="h-3 w-3" />删除
        </Button>
      )}
    </div>
  )
}