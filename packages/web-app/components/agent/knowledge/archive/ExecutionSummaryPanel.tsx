'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  SkipForward,
} from 'lucide-react'
import type { ArchiveSummaryResponse } from '@/lib/knowledge/types'

interface ExecutionSummaryPanelProps {
  summary: ArchiveSummaryResponse
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  return `${minutes}m ${remainSec}s`
}

const STATUS_CONFIG = {
  completed: {
    icon: CheckCircle,
    label: '已完成',
    className: 'bg-agent-success/10 text-agent-success border-agent-success/30',
  },
  failed: {
    icon: XCircle,
    label: '失败',
    className: 'bg-agent-error/10 text-agent-error border-agent-error/30',
  },
  skipped: {
    icon: SkipForward,
    label: '已跳过',
    className: 'bg-muted text-muted-foreground border-border',
  },
} as const

function StatCard({
  label,
  value,
  icon: Icon,
  iconClassName,
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
}) {
  return (
    <div className="rounded-lg border border-agent-divider bg-agent-surface p-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className={cn('size-3.5', iconClassName)} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}

export function ExecutionSummaryPanel({ summary }: ExecutionSummaryPanelProps) {
  const { nodes, reviewBlockers, e2eResults } = summary

  const completedCount = nodes.filter((n) => n.status === 'completed').length
  const failedCount = nodes.filter((n) => n.status === 'failed').length
  const skippedCount = nodes.filter((n) => n.status === 'skipped').length
  const totalDuration = nodes.reduce((sum, n) => sum + n.durationMs, 0)

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4">
        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard
            label="总节点数"
            value={nodes.length}
            icon={Clock}
            iconClassName="text-muted-foreground"
          />
          <StatCard
            label="已完成"
            value={completedCount}
            icon={CheckCircle}
            iconClassName="text-agent-success"
          />
          <StatCard
            label="失败"
            value={failedCount}
            icon={XCircle}
            iconClassName="text-agent-error"
          />
          <StatCard
            label="已跳过"
            value={skippedCount}
            icon={SkipForward}
            iconClassName="text-muted-foreground"
          />
          <StatCard
            label="总耗时"
            value={formatDuration(totalDuration)}
            icon={Clock}
            iconClassName="text-knowledge-primary"
          />
          <StatCard
            label="审查阻断"
            value={reviewBlockers.length}
            icon={AlertTriangle}
            iconClassName={
              reviewBlockers.length > 0 ? 'text-amber-500' : 'text-muted-foreground'
            }
          />
        </div>

        {/* Node list */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">节点详情</h3>
          <div className="space-y-1.5">
            {nodes.map((node) => {
              const config = STATUS_CONFIG[node.status]
              const StatusIcon = config.icon
              return (
                <div
                  key={node.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-agent-divider bg-agent-surface px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <StatusIcon className="size-3.5 shrink-0" />
                    <span className="text-sm truncate text-foreground">
                      {node.id}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge
                      variant="outline"
                      className={cn('text-[10px] px-1.5', config.className)}
                    >
                      {config.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums w-14 text-right">
                      {formatDuration(node.durationMs)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Review blockers */}
        {reviewBlockers.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 text-amber-500" />
              审查阻断
            </h3>
            <div className="space-y-1.5">
              {reviewBlockers.map((blocker, idx) => (
                <div
                  key={idx}
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                >
                  <p className="text-sm text-foreground leading-relaxed">{blocker}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* E2E results */}
        {e2eResults && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">E2E 测试结果</h3>
            <div className="rounded-md border border-agent-divider bg-agent-surface p-3">
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed font-mono">
                {e2eResults}
              </pre>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

/** Skeleton placeholder for ExecutionSummaryPanel */
export function ExecutionSummaryPanelSkeleton() {
  return (
    <div className="space-y-5 p-4">
      {/* Stats grid skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-agent-divider bg-agent-surface p-3 space-y-2"
          >
            <div className="flex items-center gap-1.5">
              <div className="size-3.5 rounded bg-accent animate-pulse" />
              <div className="h-3 w-12 rounded bg-accent animate-pulse" />
            </div>
            <div className="h-6 w-10 rounded bg-accent animate-pulse" />
          </div>
        ))}
      </div>

      {/* Node list skeleton */}
      <div className="space-y-2">
        <div className="h-4 w-16 rounded bg-accent animate-pulse" />
        <div className="space-y-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 rounded-md border border-agent-divider bg-agent-surface px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <div className="size-3.5 rounded-full bg-accent animate-pulse" />
                <div className="h-4 w-24 rounded bg-accent animate-pulse" />
              </div>
              <div className="flex items-center gap-2">
                <div className="h-5 w-10 rounded bg-accent animate-pulse" />
                <div className="h-3 w-10 rounded bg-accent animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
