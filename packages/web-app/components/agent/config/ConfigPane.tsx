'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  RotateCcw,
  Save,
  Send,
  History,
} from 'lucide-react'
import type { AgentConfig } from '@/lib/agent/types'
import { load as loadYaml } from 'js-yaml'
import { testNotification } from '@/lib/agent/api'
import { fetchModelConfig } from '@/lib/model-config-api'
import { CloneVersionsTab } from '../clone/CloneVersionsTab'
import { Card, Field, PaneHead, inputCls, selectCls } from '../shared/agent-ui'

const PLATFORMS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'signal', label: 'Signal' },
  { value: 'none', label: '禁用' },
]

const TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'America/New_York',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC',
]

interface ConfigPaneProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  saveConfig: (data: Partial<AgentConfig>) => Promise<boolean>
  saving: boolean
  error: string | null
}

export function ConfigPane({ config, saveConfig, saving, error }: ConfigPaneProps) {
  const [model, setModel] = useState(config?.model ?? 'claude/pro')
  const [timeoutSec, setTimeoutSec] = useState(config?.timeout ?? 300)
  const [maxClones, setMaxClones] = useState(config?.max_clones ?? 5)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [retentionDays, setRetentionDays] = useState(config?.memory?.session_retention_days ?? 90)
  const [refineDays, setRefineDays] = useState(config?.memory?.long_term_refine_trigger_days ?? 7)
  const [compressThreshold, setCompressThreshold] = useState(
    config?.memory?.session_compress_threshold_messages ?? 50,
  )
  const [platform, setPlatform] = useState(config?.notification?.platform ?? 'telegram')
  const [target, setTarget] = useState(config?.notification?.target ?? '')
  const [timezone, setTimezone] = useState(config?.notification?.timezone ?? 'Asia/Shanghai')
  const [testing, setTesting] = useState(false)

  // ── Load config once it arrives ──────────────────────────────────
  useEffect(() => {
    if (!config) return
    setModel(config.model ?? 'claude/pro')
    setTimeoutSec(config.timeout ?? 300)
    setMaxClones(config.max_clones ?? 5)
    setRetentionDays(config.memory?.session_retention_days ?? 90)
    setRefineDays(config.memory?.long_term_refine_trigger_days ?? 7)
    setCompressThreshold(config.memory?.session_compress_threshold_messages ?? 50)
    setPlatform(config.notification?.platform ?? 'telegram')
    setTarget(config.notification?.target ?? '')
    setTimezone(config.notification?.timezone ?? 'Asia/Shanghai')
  }, [config])

  // ── Model options (models.yaml) ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetchModelConfig()
      .then((res) => {
        const parsed = loadYaml(res.content) as { providers?: Record<string, Record<string, unknown>> } | null
        const providers = parsed?.providers ?? {}
        const options = Object.entries(providers).flatMap(([engine, aliases]) =>
          Object.keys(aliases ?? {}).map((alias) => `${engine}/${alias}`),
        )
        if (!cancelled) setModelOptions(options)
      })
      .catch(() => {
        if (!cancelled) setModelOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Dirty state ──────────────────────────────────────────────────
  const dirty = useMemo(() => {
    if (!config) return false
    return (
      model !== (config.model ?? '')
      || timeoutSec !== (config.timeout ?? 300)
      || maxClones !== (config.max_clones ?? 5)
      || retentionDays !== (config.memory?.session_retention_days ?? 90)
      || refineDays !== (config.memory?.long_term_refine_trigger_days ?? 7)
      || compressThreshold !== (config.memory?.session_compress_threshold_messages ?? 50)
      || platform !== (config.notification?.platform ?? '')
      || target !== (config.notification?.target ?? '')
      || timezone !== (config.notification?.timezone ?? '')
    )
  }, [
    config, model, timeoutSec, maxClones, retentionDays, refineDays, compressThreshold,
    platform, target, timezone,
  ])

  const handleReset = useCallback(() => {
    if (!config) return
    setModel(config.model ?? 'claude/pro')
    setTimeoutSec(config.timeout ?? 300)
    setMaxClones(config.max_clones ?? 5)
    setRetentionDays(config.memory?.session_retention_days ?? 90)
    setRefineDays(config.memory?.long_term_refine_trigger_days ?? 7)
    setCompressThreshold(config.memory?.session_compress_threshold_messages ?? 50)
    setPlatform(config.notification?.platform ?? 'telegram')
    setTarget(config.notification?.target ?? '')
    setTimezone(config.notification?.timezone ?? 'Asia/Shanghai')
    toast('已还原到上次保存的值')
  }, [config])

  const handleSave = useCallback(async () => {
    if (timeoutSec < 30 || timeoutSec > 1800) {
      toast.error('单轮超时必须在 30–1800 秒之间')
      return
    }
    if (maxClones < 1 || maxClones > 20) {
      toast.error('分身上限必须在 1–20 之间')
      return
    }
    const ok = await saveConfig({
      model,
      timeout: timeoutSec,
      max_clones: maxClones,
      memory: {
        session_retention_days: retentionDays,
        long_term_refine_trigger_days: refineDays,
        session_compress_threshold_messages: compressThreshold,
      },
      notification: { platform, target, timezone },
    })
    if (!ok) {
      toast.error('配置保存失败')
      return
    }
    toast.success('主 Agent 配置已保存')
  }, [
    model, timeoutSec, maxClones, retentionDays, refineDays, compressThreshold,
    platform, target, timezone, saveConfig,
  ])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      const result = await testNotification(undefined)
      if (result.ok) toast.success(result.detail)
      else toast.error(result.detail)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试失败')
    } finally {
      setTesting(false)
    }
  }, [])

  const busy = saving

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <PaneHead title="配置" description="模型、超时、记忆、通知与版本" />

        {config?.config_degraded && (
          <div className="mb-3 rounded-[8px] border border-pop-yellow/30 bg-pop-yellow-soft px-3 py-2 text-[10.5px] text-pop-yellow">
            配置损坏，已使用默认值。请检查 config.yaml 或查看调试日志。
          </div>
        )}
        {error && (
          <div className="mb-3 rounded-[8px] border border-pop-red/30 bg-pop-pink-soft px-3 py-2 text-[10.5px] text-pop-red">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-[11px]">
          <Card title="运行" tag="RUNTIME">
            <Field label="模型" help="来自 models.yaml 的 provider / alias">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={selectCls}
              >
                {(modelOptions.includes(model) || !model ? modelOptions : [model, ...modelOptions]).map((option) => (
                  <option key={option} value={option} className="bg-pop-paper">
                    {option}
                  </option>
                ))}
                {modelOptions.length === 0 && !model && <option value="">未配置模型</option>}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="单轮超时（秒）" help="30 – 1800 · 默认 300">
                <input
                  type="number"
                  min={30}
                  max={1800}
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(Math.max(30, Math.min(1800, Number(e.target.value) || 300)))}
                  className={inputCls}
                />
              </Field>
              <Field label="分身上限" help="1 – 20 · 全局预算">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxClones}
                  onChange={(e) => setMaxClones(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                  className={inputCls}
                />
              </Field>
            </div>
          </Card>

          <Card title="记忆" tag="MEMORY">
            <div className="grid grid-cols-2 gap-3">
              <Field label="会话保留" help="30 – 365 天">
                <input
                  type="number"
                  min={30}
                  max={365}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Math.max(30, Math.min(365, Number(e.target.value) || 90)))}
                  className={inputCls}
                />
              </Field>
              <Field label="精炼触发" help="1 – 30 天不活跃">
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={refineDays}
                  onChange={(e) => setRefineDays(Math.max(1, Math.min(30, Number(e.target.value) || 7)))}
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="压缩阈值（消息数）" help="10 – 500 条">
                <input
                  type="number"
                  min={10}
                  max={500}
                  value={compressThreshold}
                  onChange={(e) =>
                    setCompressThreshold(Math.max(10, Math.min(500, Number(e.target.value) || 50)))
                  }
                  className={inputCls}
                />
              </Field>
            </div>
          </Card>

          <Card title="通知" tag="HERMES">
            <div className="grid grid-cols-2 gap-3">
              <Field label="平台">
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={selectCls}>
                  {PLATFORMS.map((item) => (
                    <option key={item.value} value={item.value} className="bg-pop-paper">
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="时区">
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={selectCls}>
                  {TIMEZONES.map((item) => (
                    <option key={item} value={item} className="bg-pop-paper">
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="通知目标" help="例：telegram:your_chat_id">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="telegram:your_chat_id"
                className={inputCls}
              />
            </Field>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 text-[10.5px] font-bold text-pop-ink transition-colors hover:border-pop-dim disabled:opacity-50"
              >
                <Send className="size-3" />
                {testing ? '测试中…' : '测试通知'}
              </button>
              <span className="text-[10px] text-pop-dim">留空测试消息时发送默认消息</span>
            </div>
          </Card>

          <Card
            title="版本快照"
            tag="MAIN ONLY"
            actions={
              <span className="ml-auto flex items-center gap-1 text-[9px] text-pop-dim">
                <History className="size-3" />
                persona + config + skills
              </span>
            }
            bodyClassName="p-0"
          >
            <div className="h-[360px]">
              <CloneVersionsTab agentName="__main__" />
            </div>
          </Card>
        </div>
      </div>

      {/* Sticky save bar */}
      <div className="flex flex-none items-center gap-3 border-t-[1.5px] border-pop-bd bg-pop-paper px-4 py-2">
        <span
          className={`flex items-center gap-1.5 text-[10px] ${dirty ? 'text-pop-yellow' : 'text-pop-dim'}`}
        >
          <i
            className={`inline-block size-[5px] rounded-full ${dirty ? 'bg-pop-yellow' : 'bg-pop-green'}`}
          />
          {dirty ? '配置变更尚未保存' : '配置已保存'}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || busy}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2.5 text-[10.5px] font-bold text-pop-dim transition-colors hover:text-pop-ink disabled:opacity-40"
          >
            <RotateCcw className="size-3" />
            重置
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || busy}
            className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border-[1.5px] border-pop-purple/45 bg-pop-purple-soft px-3 text-[10.5px] font-bold text-pop-purple transition-colors hover:bg-pop-purple/15 disabled:opacity-50"
          >
            {busy ? <Check className="size-3" /> : <Save className="size-3" />}
            {busy ? '保存中…' : '保存主 Agent 配置'}
          </button>
        </span>
      </div>
    </div>
  )
}
