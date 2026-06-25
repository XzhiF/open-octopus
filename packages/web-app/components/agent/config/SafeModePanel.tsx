'use client'

import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { SafeModeStatus } from '@/lib/agent/types'

interface SafeModePanelProps {
  safeMode: SafeModeStatus | null
  onToggle: (enable: boolean) => Promise<boolean>
}

export function SafeModePanel({ safeMode, onToggle }: SafeModePanelProps) {
  const isEnabled = safeMode?.enabled ?? false

  const handleToggle = async () => {
    const ok = await onToggle(!isEnabled)
    if (ok) {
      toast.success(isEnabled ? '安全降级已解除' : '安全降级已启用')
    }
  }

  return (
    <section className={cn(
      'rounded-xl border-2 overflow-hidden',
      isEnabled ? 'border-agent-error' : 'border-agent-success'
    )}>
      <div className={cn(
        'px-5 py-4 flex items-center gap-3',
        isEnabled ? 'bg-agent-error-light' : 'bg-agent-success-light'
      )}>
        {isEnabled ? (
          <ShieldAlert className="h-5 w-5 text-agent-error" />
        ) : (
          <ShieldCheck className="h-5 w-5 text-agent-success" />
        )}
        <div className="flex-1">
          <h3 className="text-sm font-semibold">
            {isEnabled ? '安全降级模式（激活）' : '安全降级（正常）'}
          </h3>
          {isEnabled && safeMode?.reason && (
            <p className="text-xs text-agent-error-foreground mt-0.5">
              原因: {safeMode.reason}
              {safeMode.triggered_at && ` · 触发于 ${new Date(safeMode.triggered_at).toLocaleString('zh-CN')}`}
            </p>
          )}
        </div>
        <Button
          onClick={handleToggle}
          variant={isEnabled ? 'default' : 'outline'}
          size="sm"
          className={isEnabled ? 'bg-agent-success text-agent-success-foreground hover:bg-agent-success/90' : ''}
        >
          {isEnabled ? '解除降级' : '手动启用'}
        </Button>
      </div>
      <div className="px-5 py-3 bg-agent-surface-raised text-xs text-muted-foreground">
        {isEnabled
          ? 'SKILL 进化已暂停，定时任务熔断，写操作被限制为只读模式。'
          : 'Agent 正常运行中。超过 14 天不活跃将自动启用安全降级。'
        }
      </div>
    </section>
  )
}
