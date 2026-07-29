'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import type { AgentConfig } from '@/lib/agent/types'
import { ConfigSection } from './ConfigSection'
import { ModelSelector } from './ModelSelector'

interface GeneralConfigProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
  saving: boolean
}

export function GeneralConfig({ config, onSave, saving }: GeneralConfigProps) {
  const [model, setModel] = useState(config?.model ?? 'claude/pro')
  const [timeout, setTimeout] = useState(config?.timeout ?? 300)
  const [maxClones, setMaxClones] = useState(config?.max_clones ?? 5)
  const [debugEnabled, setDebugEnabled] = useState(config?.debug?.enabled ?? false)

  const handleSave = async () => {
    // Validate ranges
    if (timeout < 30 || timeout > 1800) {
      toast.error('Timeout 必须在 30–1800 秒之间')
      return
    }
    if (maxClones < 1) {
      toast.error('Max Clones 必须至少为 1')
      return
    }

    const ok = await onSave({
      model,
      timeout,
      max_clones: maxClones,
      debug: { enabled: debugEnabled },
    })
    if (ok) {
      toast.success('通用配置已保存')
    } else {
      toast.error('保存失败')
    }
  }

  return (
    <ConfigSection
      title="通用配置"
      description="配置 Agent 的模型、超时、分身数量上限和调试模式。"
      saving={saving}
      onSave={handleSave}
    >
      <div className="space-y-4">
        <ModelSelector value={model} onChange={setModel} />

        <div>
          <Label>Timeout (秒)</Label>
          <Input
            type="number"
            min={30}
            max={1800}
            step={1}
            value={timeout}
            onChange={(e) => setTimeout(Math.max(30, Math.min(1800, parseInt(e.target.value) || 300)))}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">范围: 30–1800 秒，默认 300</p>
        </div>

        <div>
          <Label>Max Clones</Label>
          <Input
            type="number"
            min={1}
            max={20}
            step={1}
            value={maxClones}
            onChange={(e) => setMaxClones(Math.max(1, Math.min(20, parseInt(e.target.value) || 5)))}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
          <p className="text-xs text-muted-foreground mt-1">范围: 1–20，默认 5</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Debug Mode</Label>
            <p className="text-xs text-muted-foreground mt-1">开启后将记录 Agent 决策日志</p>
          </div>
          <Switch
            checked={debugEnabled}
            onCheckedChange={setDebugEnabled}
          />
        </div>
      </div>
    </ConfigSection>
  )
}
