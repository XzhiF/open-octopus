'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import type { AgentConfig } from '@/lib/agent/types'
import { ConfigSection } from './ConfigSection'

interface MemoryStrategyConfigProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
  saving: boolean
}

export function MemoryStrategyConfig({ config, onSave, saving }: MemoryStrategyConfigProps) {
  const [retentionDays, setRetentionDays] = useState(config?.memory?.session_retention_days ?? 90)
  const [archiveHour, setArchiveHour] = useState(config?.memory?.archive_cron_hour ?? 3)
  const [refineDays, setRefineDays] = useState(config?.memory?.long_term_refine_trigger_days ?? 7)
  const [compressThreshold, setCompressThreshold] = useState(config?.memory?.session_compress_threshold_messages ?? 50)

  const handleSave = async () => {
    const ok = await onSave({
      memory: {
        session_retention_days: retentionDays,
        archive_cron_hour: archiveHour,
        long_term_refine_trigger_days: refineDays,
        session_compress_threshold_messages: compressThreshold,
      },
    })
    if (ok) toast.success('记忆策略已保存')
  }

  return (
    <ConfigSection
      title="记忆策略"
      description="配置 Agent 记忆的存储、归档和压缩策略。"
      saving={saving}
      onSave={handleSave}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>会话保留天数</Label>
          <Input
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            min={30}
            max={365}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">30-365 天</p>
        </div>
        <div>
          <Label>归档时间（小时）</Label>
          <Input
            type="number"
            value={archiveHour}
            onChange={(e) => setArchiveHour(Number(e.target.value))}
            min={0}
            max={23}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">0-23 时</p>
        </div>
        <div>
          <Label>精炼触发天数</Label>
          <Input
            type="number"
            value={refineDays}
            onChange={(e) => setRefineDays(Number(e.target.value))}
            min={1}
            max={30}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">1-30 天</p>
        </div>
        <div>
          <Label>压缩阈值（消息数）</Label>
          <Input
            type="number"
            value={compressThreshold}
            onChange={(e) => setCompressThreshold(Number(e.target.value))}
            min={10}
            max={500}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">10-500 条</p>
        </div>
      </div>
    </ConfigSection>
  )
}
