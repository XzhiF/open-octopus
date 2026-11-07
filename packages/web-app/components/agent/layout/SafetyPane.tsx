'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert } from 'lucide-react'
import type { AgentConfig, SafeModeStatus, SafetyEvent } from '@/lib/agent/types'
import { SafeModePanel } from '../config/SafeModePanel'
import { SafetyAudit } from '../config/SafetyAudit'
import { DebugLogViewer } from '../config/DebugLogViewer'
import { Card, Field, PaneHead, inputCls } from '../shared/agent-ui'

interface SafetyPaneProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  safeMode: SafeModeStatus | null
  safetyEvents: SafetyEvent[]
  saving: boolean
  saveConfig: (data: Partial<AgentConfig>) => Promise<boolean>
  toggleSafeMode: (enable: boolean) => Promise<boolean>
}

export function SafetyPane({
  config,
  safeMode,
  safetyEvents,
  saving,
  saveConfig,
  toggleSafeMode,
}: SafetyPaneProps) {
  const [inactiveDays, setInactiveDays] = useState(config?.safe_mode?.inactive_days_threshold ?? 14)

  useEffect(() => {
    if (config?.safe_mode?.inactive_days_threshold !== undefined) {
      setInactiveDays(config.safe_mode.inactive_days_threshold)
    }
  }, [config?.safe_mode?.inactive_days_threshold])

  const savedDays = config?.safe_mode?.inactive_days_threshold ?? 14
  const dirty = inactiveDays !== savedDays

  const handleSaveThreshold = useCallback(async () => {
    if (inactiveDays < 1 || inactiveDays > 90) {
      toast.error('不活跃天数必须在 1–90 之间')
      return
    }
    const ok = await saveConfig({ safe_mode: { ...config?.safe_mode, enabled: safeMode?.enabled ?? false, inactive_days_threshold: inactiveDays } })
    if (ok) toast.success('自动降级阈值已保存')
    else toast.error('保存失败')
  }, [inactiveDays, config?.safe_mode, safeMode?.enabled, saveConfig])

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <PaneHead title="安全与调试" description="安全降级、命令拦截与决策日志" />

      <div className="flex flex-col gap-[11px]">
        <SafeModePanel safeMode={safeMode} onToggle={toggleSafeMode} />

        <Card
          title="自动降级阈值"
          tag="INACTIVITY"
          actions={
            <button
              type="button"
              onClick={handleSaveThreshold}
              disabled={!dirty || saving}
              className="ml-auto inline-flex h-6 items-center rounded-[6px] border-[1.5px] border-pop-bd bg-pop-idle px-2 text-[9.5px] font-bold text-pop-ink transition-colors hover:border-pop-purple/50 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="不活跃天数" help="超过阈值后自动启用安全降级">
              <input
                type="number"
                min={1}
                max={90}
                value={inactiveDays}
                onChange={(e) => setInactiveDays(Math.max(1, Math.min(90, Number(e.target.value) || 14)))}
                className={inputCls}
              />
            </Field>
            <div className="flex items-start gap-2 rounded-[8px] border border-pop-yellow/25 bg-pop-yellow-soft px-2.5 py-2 text-[10px] leading-relaxed text-pop-yellow">
              <ShieldAlert className="mt-0.5 size-3 flex-none" />
              降级后：SKILL 进化暂停、定时任务熔断、写操作降为只读。
            </div>
          </div>
        </Card>

        <DebugLogViewer config={config} onSave={saveConfig} />

        <SafetyAudit events={safetyEvents} />
      </div>
    </div>
  )
}
