'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { XCircle, Clock } from 'lucide-react'
import type { TaskInfo } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

interface ActiveTaskListProps {
  tasks: TaskInfo[]
  loading: boolean
  onCancel: (id: string) => Promise<boolean>
}

const statusStyles: Record<string, string> = {
  running: 'bg-agent-info-light text-agent-info-foreground border-agent-info/20',
  completed: 'bg-agent-success-light text-agent-success-foreground border-agent-success/20',
  failed: 'bg-agent-error-light text-agent-error border-agent-error/20',
  cancelled: 'bg-muted text-muted-foreground',
}

export function ActiveTaskList({ tasks, loading, onCancel }: ActiveTaskListProps) {
  if (loading) {
    return (
      <div className="p-4 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        暂无进行中任务
      </div>
    )
  }

  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="rounded-xl border border-agent-divider bg-agent-surface-raised p-4"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h4 className="text-sm font-semibold">{task.workflow_name ?? task.name}</h4>
                <Badge variant="outline" className={cn('text-xs mt-1', statusStyles[task.status])}>
                  {task.status}
                </Badge>
              </div>
              {task.status === 'running' && (
                <Button variant="ghost" size="sm" className="text-agent-error gap-1" onClick={() => onCancel(task.id)}>
                  <XCircle className="h-3.5 w-3.5" />
                  取消
                </Button>
              )}
            </div>

            {task.current_node && (
              <p className="text-xs text-muted-foreground mb-2">
                当前节点: <span className="font-mono">{task.current_node}</span>
              </p>
            )}

            {task.progress !== undefined && (
              <div className="mb-2">
                <Progress value={task.progress * 100} className="h-1.5" />
                <span className="text-xs text-muted-foreground mt-1">{(task.progress * 100).toFixed(0)}%</span>
              </div>
            )}

            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              已耗时: {formatElapsed(task.elapsed_ms)}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
