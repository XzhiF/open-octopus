'use client'

import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Shield } from 'lucide-react'
import type { SafetyEvent } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

interface SafetyAuditProps {
  events: SafetyEvent[]
}

const typeStyles: Record<string, string> = {
  dangerous_command: 'bg-agent-error-light text-agent-error border-agent-error/20',
  boundary_violation: 'bg-agent-warn-light text-agent-warn-foreground border-agent-warn/20',
  safe_mode_toggle: 'bg-agent-info-light text-agent-info-foreground border-agent-info/20',
}

const decisionLabels: Record<string, string> = {
  intercept: '拦截',
  confirm_accept: '用户确认',
  confirm_reject: '用户拒绝',
}

export function SafetyAudit({ events }: SafetyAuditProps) {
  return (
    <section className="rounded-xl border border-agent-divider bg-agent-surface-raised overflow-hidden">
      <div className="px-5 py-4 border-b border-agent-divider">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4" />
          安全审计
        </h3>
      </div>
      {events.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted-foreground text-center">
          暂无安全事件
        </div>
      ) : (
        <ScrollArea className="max-h-[300px]">
          <div className="divide-y divide-agent-divider">
            {events.map((event) => (
              <div key={event.id} className="px-5 py-3 flex items-center gap-3">
                <Badge variant="outline" className={cn('text-xs shrink-0', typeStyles[event.type] ?? '')}>
                  {event.type}
                </Badge>
                <span className="text-sm flex-1 truncate">{event.operation}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {decisionLabels[event.decision] ?? event.decision}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(event.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  )
}
