'use client'

import { useState } from 'react'
import { AlertTriangle, ShieldCheck, ShieldX, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DangerConfirmCardProps {
  eventId: string
  operation: string
  detail: string
  onConfirm: (decision: 'accept' | 'reject') => void
}

export function DangerConfirmCard({ operation, detail, onConfirm }: DangerConfirmCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [decided, setDecided] = useState<'accept' | 'reject' | null>(null)

  const handleDecision = (decision: 'accept' | 'reject') => {
    setDecided(decision)
    onConfirm(decision)
  }

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4',
        decided === 'accept' ? 'border-agent-warn bg-agent-warn-light' :
        decided === 'reject' ? 'border-agent-error bg-agent-error-light' :
        'border-agent-error bg-agent-error-light'
      )}
      role="alertdialog"
      aria-describedby="danger-command-desc"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-agent-error shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-semibold text-sm">危险操作确认</h4>
          <p id="danger-command-desc" className="text-sm text-muted-foreground mt-1">{detail}</p>
          <div className="mt-2 rounded-md bg-background/50 p-2 font-mono text-xs">
            <code>{expanded ? operation : operation.slice(0, 80) + (operation.length > 80 ? '...' : '')}</code>
          </div>
          {operation.length > 80 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-agent-primary mt-1 hover:underline"
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
              {expanded ? '收起' : '查看完整命令'}
            </button>
          )}
        </div>
      </div>

      {decided ? (
        <div className="mt-3 text-sm font-medium text-center">
          {decided === 'accept' ? '✅ 已确认执行' : '🚫 已拒绝'}
        </div>
      ) : (
        <div className="flex gap-2 mt-3">
          <Button
            onClick={() => handleDecision('reject')}
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5 border-agent-error/30 text-agent-error hover:bg-agent-error-light"
          >
            <ShieldX className="h-4 w-4" />
            拒绝
          </Button>
          <Button
            onClick={() => handleDecision('accept')}
            size="sm"
            className="flex-1 gap-1.5 bg-agent-warn text-agent-warn-foreground hover:bg-agent-warn/90"
          >
            <ShieldCheck className="h-4 w-4" />
            确认执行
          </Button>
        </div>
      )}
    </div>
  )
}
