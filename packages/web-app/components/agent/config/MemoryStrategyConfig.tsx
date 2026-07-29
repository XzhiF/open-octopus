'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import type { AgentConfig } from '@/lib/agent/types'
import { getSchedulerJob, updateSchedulerJob, parseCronExpression, type CronParseResult } from '@/lib/agent/api'
import { ConfigSection } from './ConfigSection'

interface MemoryStrategyConfigProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
  saving: boolean
}

export function MemoryStrategyConfig({ config, onSave, saving }: MemoryStrategyConfigProps) {
  const [retentionDays, setRetentionDays] = useState(config?.memory?.session_retention_days ?? 90)
  const [refineDays, setRefineDays] = useState(config?.memory?.long_term_refine_trigger_days ?? 7)
  const [compressThreshold, setCompressThreshold] = useState(config?.memory?.session_compress_threshold_messages ?? 50)

  // Cron expression state
  const [cronExpression, setCronExpression] = useState('0 3 * * *')
  const [cronVersion, setCronVersion] = useState<number | null>(null)
  const [cronParseResult, setCronParseResult] = useState<CronParseResult | null>(null)
  const [cronLoading, setCronLoading] = useState(false)
  const [cronSaving, setCronSaving] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch current scheduler job on mount
  useEffect(() => {
    let cancelled = false
    getSchedulerJob('system:daily-archive')
      .then((job) => {
        if (cancelled) return
        setCronExpression(job.cron_expression)
        setCronVersion(job.version)
      })
      .catch(() => {
        // Job may not exist yet — keep default
      })
    return () => { cancelled = true }
  }, [])

  // Debounced cron parse on input change
  const parseCron = useCallback((expression: string, timezone: string) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(async () => {
      if (!expression.trim()) {
        setCronParseResult(null)
        return
      }
      setCronLoading(true)
      try {
        const result = await parseCronExpression(expression, timezone)
        setCronParseResult(result)
      } catch {
        setCronParseResult(null)
      } finally {
        setCronLoading(false)
      }
    }, 500)
  }, [])

  useEffect(() => {
    const timezone = config?.notification?.timezone ?? 'Asia/Shanghai'
    parseCron(cronExpression, timezone)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [cronExpression, config?.notification?.timezone, parseCron])

  const handleSave = async () => {
    // Save memory strategy fields via config API
    const configOk = await onSave({
      memory: {
        session_retention_days: retentionDays,
        long_term_refine_trigger_days: refineDays,
        session_compress_threshold_messages: compressThreshold,
      },
    })

    // Save cron expression via scheduler API
    let cronOk = true
    if (cronVersion !== null) {
      setCronSaving(true)
      try {
        const updated = await updateSchedulerJob(
          'system:daily-archive',
          { cron_expression: cronExpression },
          cronVersion,
        )
        setCronVersion(updated.version)
      } catch (err) {
        cronOk = false
        const msg = err instanceof Error ? err.message : '归档调度保存失败'
        toast.error(msg)
      } finally {
        setCronSaving(false)
      }
    }

    if (configOk && cronOk) {
      toast.success('记忆策略已保存')
    } else if (!configOk) {
      toast.error('配置保存失败')
    }
  }

  const isSaving = saving || cronSaving

  return (
    <ConfigSection
      title="记忆策略"
      description="配置 Agent 记忆的存储、归档和压缩策略。"
      saving={isSaving}
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

      {/* Archive Cron Expression */}
      <div className="pt-2 border-t border-agent-divider">
        <Label>归档调度 (Cron)</Label>
        <Input
          type="text"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="0 3 * * *"
          className="mt-1 bg-agent-surface-inset border-agent-divider font-mono"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {cronLoading ? '解析中...' : cronParseResult?.valid ? cronParseResult.description : '请输入有效的 cron 表达式'}
        </p>
        {cronParseResult?.valid && cronParseResult.next_executions.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium">下次执行：</span>
            <ul className="mt-1 space-y-0.5">
              {cronParseResult.next_executions.slice(0, 3).map((t, i) => (
                <li key={i}>{new Date(t).toLocaleString()}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ConfigSection>
  )
}
