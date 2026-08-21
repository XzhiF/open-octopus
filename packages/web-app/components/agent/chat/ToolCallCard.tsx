'use client'

import { useState, useEffect } from 'react'
import { ChevronRight, Check, X, Loader2 } from 'lucide-react'
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

// ── Tool preview helpers ─────────────────────────────────────────────
// Collapsed-state one-liner that shows the most informative parameter
// so the user can identify what each tool call did without expanding.

/** Truncate a file path: short → full, long → `start\…\filename`.
 *  The filename (last segment) is always visible — that's the part
 *  humans use to recognise a file. */
function formatPath(p: string): string {
  if (p.length <= 32) return p
  // Normalise separators for display
  const sep = p.includes('\\') ? '\\' : '/'
  const segments = p.split(/[\\/]/)
  if (segments.length <= 2) return p
  const head = segments[0]
  const tail = segments[segments.length - 1]
  const preview = `${head}${sep}…${sep}${tail}`
  // If still too long, just show …\filename
  if (preview.length > 32) return `…${sep}${tail}`
  return preview
}

/** Extract the most informative preview string for a tool call.
 *  Per-tool field selection — each tool has a "key parameter" that
 *  best describes what it's operating on. */
function getToolPreview(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const fp = inp.file_path
      if (typeof fp === 'string' && fp) return formatPath(fp)
      break
    }
    case 'Bash':
    case 'PowerShell': {
      const cmd = inp.command ?? inp.description
      if (typeof cmd === 'string' && cmd) {
        const trimmed = cmd.trim().replace(/\n/g, ' ')
        return trimmed.length > 40 ? trimmed.slice(0, 38) + '…' : trimmed
      }
      break
    }
    case 'Glob': {
      const pattern = inp.pattern
      if (typeof pattern === 'string' && pattern) {
        const p = inp.path
        const suffix = typeof p === 'string' && p ? ` (${formatPath(p)})` : ''
        return pattern + suffix
      }
      break
    }
    case 'Grep': {
      const pat = inp.pattern
      if (typeof pat === 'string' && pat) {
        const p = inp.path
        const suffix = typeof p === 'string' && p ? ` (${formatPath(p)})` : ''
        const display = pat.length > 30 ? pat.slice(0, 28) + '…' : pat
        return `"${display}"${suffix}`
      }
      break
    }
    case 'NotebookEdit': {
      const np = inp.notebook_path
      if (typeof np === 'string' && np) return formatPath(np)
      break
    }
    default: {
      // Fallback: first string-valued field, truncated
      for (const val of Object.values(inp)) {
        if (typeof val === 'string' && val.length > 0 && val.length < 200) {
          const trimmed = val.replace(/\n/g, ' ')
          return trimmed.length > 40 ? trimmed.slice(0, 38) + '…' : trimmed
        }
      }
    }
  }
  return null
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(toolCall.started_at, toolCall.ended_at)

  // Defensive: legacy persisted tool calls may lack a `status` field (backend
  // fix adds it going forward). If status is missing/undefined but we have a
  // `result`, the tool call clearly completed — derive an effective status so
  // the icon doesn't spin forever on old data.
  const effectiveStatus = toolCall.status
    ?? (toolCall.result != null ? 'result' : undefined)
  const done = isTerminal(effectiveStatus)

  const preview = getToolPreview(toolCall.name, toolCall.input)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-2 w-full rounded-lg border border-agent-divider bg-agent-surface-inset px-3 py-2 text-sm transition-colors hover:bg-accent',
            effectiveStatus === 'fail' && 'border-agent-error/30'
          )}
          role="status"
          aria-label={`工具调用: ${toolCall.name}, 状态: ${effectiveStatus ?? 'unknown'}`}
        >
          {statusIcons[effectiveStatus ?? ''] ?? <Loader2 className="h-3.5 w-3.5 animate-spin text-agent-info" />}
          <code className="font-mono text-xs font-medium shrink-0">{toolCall.name}</code>
          {preview && (
            <span className="font-mono text-[11px] text-muted-foreground/70 truncate max-w-[220px] shrink min-w-0" title={preview}>
              {preview}
            </span>
          )}
          <span className="flex-1" />
          <span className={cn(
            'text-xs tabular-nums shrink-0',
            done ? 'text-muted-foreground' : 'text-agent-info'
          )}>
            {elapsed > 0 && formatMs(elapsed)}
          </span>
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform text-muted-foreground shrink-0', open && 'rotate-90')} />
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
