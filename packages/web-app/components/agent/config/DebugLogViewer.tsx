'use client'

import { useState, useEffect, useCallback } from 'react'
import { Bug } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import * as api from '@/lib/agent/api'
import type { AgentConfig, DebugLogEntry } from '@/lib/agent/types'

interface DebugLogViewerProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
}

export function DebugLogViewer({ config, onSave }: DebugLogViewerProps) {
  const [debugEnabled, setDebugEnabled] = useState(config?.debug?.enabled ?? false)
  const [logs, setLogs] = useState<{ id: string; session_id: string; timestamp: string; summary: string; chat_id: string }[]>([])
  const [selectedLog, setSelectedLog] = useState<DebugLogEntry | null>(null)
  const [loading, setLoading] = useState(false)

  // Sync debugEnabled when config changes externally
  useEffect(() => {
    if (config?.debug?.enabled !== undefined) {
      setDebugEnabled(config.debug.enabled)
    }
  }, [config?.debug?.enabled])

  useEffect(() => {
    api.getDebugLog({ limit: 20 }).then((res) => {
      setLogs(res.items.map(item => ({
        id: item.id,
        session_id: item.session_id,
        timestamp: item.timestamp,
        chat_id: item.chat_id,
        summary: (item as unknown as { summary: string }).summary ?? '',
      })))
    }).catch(() => {})
  }, [])

  const handleToggleDebug = useCallback(async (enabled: boolean) => {
    setDebugEnabled(enabled)
    const ok = await onSave({ debug: { enabled } })
    if (ok) {
      toast.success(enabled ? '调试模式已开启' : '调试模式已关闭')
    } else {
      setDebugEnabled(!enabled)
      toast.error('保存失败')
    }
  }, [onSave])

  const handleSelect = async (chatId: string) => {
    setLoading(true)
    try {
      const detail = await api.getAssembleDetail(chatId)
      setSelectedLog(detail)
    } catch {
      setSelectedLog(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="rounded-xl border border-agent-divider bg-agent-surface-raised overflow-hidden">
      <div className="px-5 py-4 border-b border-agent-divider">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Bug className="h-4 w-4" />
              调试日志
            </h3>
            <p className="text-xs text-muted-foreground mt-1">开启后将记录 Agent 决策日志</p>
          </div>
          <Switch
            checked={debugEnabled}
            onCheckedChange={handleToggleDebug}
          />
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted-foreground text-center">
          {debugEnabled ? '暂无调试日志，进行一次 Agent 对话后将自动记录' : '开启调试模式后将记录 Agent 决策日志'}
        </div>
      ) : (
        <div className="flex">
          {/* Log list */}
          <ScrollArea className="max-h-[400px] w-72 border-r border-agent-divider">
            <div className="divide-y divide-agent-divider">
              {logs.map((log, i) => (
                <button
                  key={log.id ? `${log.id}-${i}` : i}
                  onClick={() => handleSelect(log.chat_id ?? log.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 hover:bg-accent transition-colors',
                    selectedLog?.chat_id === log.chat_id && 'bg-agent-primary-light'
                  )}
                >
                  <p className="text-sm truncate">{log.summary}</p>
                  <span className="text-xs text-muted-foreground">
                    {new Date(log.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* Log detail */}
          <div className="flex-1 max-h-[400px] overflow-auto">
            {loading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : selectedLog ? (
              <div className="p-4">
                <h4 className="text-sm font-semibold mb-3">System Prompt 组装详情</h4>
                <div className="space-y-3">
                  {selectedLog.segments.map((seg) => (
                    <div key={seg.index} className="rounded-lg border border-agent-divider p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{seg.name}</span>
                        <span className={cn(
                          'text-xs',
                          seg.degraded ? 'text-agent-warn' : 'text-muted-foreground'
                        )}>
                          {seg.token_count} / {seg.budget} tokens
                          {seg.degraded && ' (已降级)'}
                        </span>
                      </div>
                      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                        {seg.content_preview}
                      </pre>
                    </div>
                  ))}
                </div>
                {Object.keys(selectedLog.skill_sources ?? {}).length > 0 && (
                  <div className="mt-4">
                    <h5 className="text-xs font-semibold mb-2">SKILL 来源</h5>
                    <div className="space-y-1">
                      {Object.entries(selectedLog.skill_sources ?? {}).map(([name, source]) => (
                        <div key={name} className="flex items-center gap-2 text-xs">
                          <span className="font-mono">{name}</span>
                          <span className="text-muted-foreground">→</span>
                          <span>{source}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4">
                选择一条日志查看组装详情
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
