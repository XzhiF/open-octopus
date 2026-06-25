'use client'

import { useState, useEffect } from 'react'
import { ChevronRight, Check, X, Loader2, Clock } from 'lucide-react'
import type { ToolCallRecord } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

interface ToolCallCardProps {
  toolCall: ToolCallRecord
}

const statusIcons: Record<string, React.ReactNode> = {
  start: <Loader2 className="h-3.5 w-3.5 animate-spin text-agent-info" />,
  pending: <Loader2 className="h-3.5 w-3.5 animate-spin text-agent-info" />,
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-agent-info" />,
  success: <Check className="h-3.5 w-3.5 text-agent-success" />,
  result: <Check className="h-3.5 w-3.5 text-agent-success" />,
  fail: <X className="h-3.5 w-3.5 text-agent-error" />,
}

function isTerminal(status?: string) {
  return status === 'success' || status === 'result' || status === 'fail'
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function useElapsed(startedAt?: number, endedAt?: number): number {
  const [now, setNow] = useState(Date.now)
  const running = startedAt && !endedAt

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])

  if (!startedAt) return 0
  return (endedAt ?? now) - startedAt
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(toolCall.started_at, toolCall.ended_at)
  const done = isTerminal(toolCall.status)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-2 w-full rounded-lg border border-agent-divider bg-agent-surface-inset px-3 py-2 text-sm transition-colors hover:bg-accent',
            toolCall.status === 'fail' && 'border-agent-error/30'
          )}
          role="status"
          aria-label={`工具调用: ${toolCall.name}, 状态: ${toolCall.status}`}
        >
          {statusIcons[toolCall.status] ?? <Loader2 className="h-3.5 w-3.5 animate-spin text-agent-info" />}
          <code className="font-mono text-xs font-medium flex-1 text-left">{toolCall.name}</code>
          <span className={cn(
            'text-xs tabular-nums',
            done ? 'text-muted-foreground' : 'text-agent-info'
          )}>
            {elapsed > 0 && formatMs(elapsed)}
          </span>
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform text-muted-foreground', open && 'rotate-90')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-lg border border-agent-divider bg-agent-surface-inset p-3 text-xs">
          {toolCall.input != null && (
            <div className="mb-2">
              <span className="font-medium text-muted-foreground">输入:</span>
              <pre className="mt-1 overflow-x-auto font-mono text-xs p-2 rounded bg-background/50">
                {typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.result != null && (
            <div>
              <span className="font-medium text-muted-foreground">结果:</span>
              <pre className="mt-1 overflow-x-auto font-mono text-xs p-2 rounded bg-background/50">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.input == null && toolCall.result == null && (
            <span className="text-muted-foreground italic">执行中...</span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
