import { Badge } from '@/components/ui/badge'
import type { CloneStatus } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

const statusConfig: Record<CloneStatus, { label: string; className: string }> = {
  active: { label: '活跃', className: 'bg-agent-success-light text-agent-success-foreground border-agent-success/20' },
  idle: { label: '空闲', className: 'bg-muted text-muted-foreground' },
  executing: { label: '执行中', className: 'bg-agent-info-light text-agent-info-foreground border-agent-info/20' },
}

interface CloneStatusBadgeProps {
  status: CloneStatus
}

export function CloneStatusBadge({ status }: CloneStatusBadgeProps) {
  const config = statusConfig[status]
  return (
    <Badge variant="outline" className={cn('text-xs mt-1', config.className)}>
      {config.label}
    </Badge>
  )
}
