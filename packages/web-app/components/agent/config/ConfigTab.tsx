'use client'

import { useAgentConfig } from '@/hooks/useAgentConfig'
import { PersonaEditor } from './PersonaEditor'
import { NotificationConfig } from './NotificationConfig'
import { MemoryStrategyConfig } from './MemoryStrategyConfig'
import { SafeModePanel } from './SafeModePanel'
import { SafetyAudit } from './SafetyAudit'
import { DebugLogViewer } from './DebugLogViewer'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertTriangle } from 'lucide-react'

export function ConfigTab() {
  const {
    config, safeMode, safetyEvents,
    loading, saving, error,
    saveConfig, savePersona, toggleSafeMode,
  } = useAgentConfig()

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-3xl mx-auto">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        {config?.config_degraded && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-agent-warn-light border border-agent-warn/20 text-sm">
            <AlertTriangle className="h-4 w-4 text-agent-warn" />
            配置损坏，已使用默认值。请检查 config.yaml 或查看调试日志。
          </div>
        )}

        {error && (
          <div className="rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
            {error}
          </div>
        )}

        <SafeModePanel safeMode={safeMode} onToggle={toggleSafeMode} />
        <PersonaEditor onSave={savePersona} saving={saving} />
        <NotificationConfig config={config} onSave={saveConfig} saving={saving} />
        <MemoryStrategyConfig config={config} onSave={saveConfig} saving={saving} />
        <SafetyAudit events={safetyEvents} />
        <DebugLogViewer />
      </div>
    </ScrollArea>
  )
}
