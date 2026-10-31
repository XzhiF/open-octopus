'use client'

// 原型 cmp-bar 的 model 弹层：模型别名 + 每个模型自己的思考强度/上下文预设。
// 选择模型只切换当前项，不收起弹层；下方控件随之显示该模型的 preset。
// Claude Agent SDK：effort 直接传选项；1M 上下文通过模型名 `[1m]` 变体启用。

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  COMPOSER_CONTEXT_OPTIONS,
  COMPOSER_EFFORT_OPTIONS,
  contextLabel,
  effortLabel,
  modelPreset,
  type ComposerContext,
  type ComposerEffort,
  type ModelPreset,
} from '@/lib/agent/composer-settings'

const MODELS = [
  { id: 'pro-max', name: 'pro-max', desc: '最强 · 复杂重构与 Spec 共建', tag: '' },
  { id: 'pro', name: 'pro', desc: '均衡 · 日常执行', tag: '默认' },
  { id: 'se', name: 'se', desc: '轻量 · 快，走查与轻任务', tag: '' },
]

interface ComposerModelPopoverProps {
  currentModel: string
  onModelChange: (model: string) => void
  effort: ComposerEffort
  onEffortChange: (effort: ComposerEffort) => void
  context: ComposerContext
  onContextChange: (context: ComposerContext) => void
  /** 所有模型各自保存的 preset（列表里直接展示，方便对比）。 */
  modelPresets?: Record<string, ModelPreset>
  /** SSE context_usage 回报的实际运行模型（网关可能把别名映射成真实模型名）。 */
  effectiveModel?: string
}

export function ComposerModelPopover({
  currentModel,
  onModelChange,
  effort,
  onEffortChange,
  context,
  onContextChange,
  modelPresets,
  effectiveModel,
}: ComposerModelPopoverProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="模型"
          title="模型设置"
          className={cn(
            'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border border-transparent px-1.5 text-[11px] transition-colors hover:bg-pop-paper hover:text-pop-ink',
            open ? 'border-pop-bd bg-pop-paper text-pop-ink' : 'text-pop-dim',
          )}
        >
          <span>model</span>
          <span className="font-mono text-pop-green">{currentModel}</span>
          {context === '1m' && <span className="text-[9px] font-bold text-pop-cyan">1M</span>}
          <span aria-hidden className="text-[8px] text-pop-dim">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="max-h-[70vh] w-80 overflow-y-auto rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-pop-bd/60 px-3 py-2.5">
          <span className="text-[12px] font-bold text-pop-ink">模型设置</span>
          <span className="text-[10px] text-pop-dim">每个模型独立预设</span>
          {effectiveModel && effectiveModel !== currentModel && (
            <span className="ml-auto truncate font-mono text-[9.5px] text-pop-dim" title={`实际运行模型：${effectiveModel}`}>
              运行 {effectiveModel}
            </span>
          )}
        </div>

        <div className="p-1.5">
          {MODELS.map((m) => {
            const active = m.id === currentModel
            const preset = modelPreset(m.id, modelPresets)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onModelChange(m.id)}
                aria-pressed={active}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-pop-bd/20',
                  active && 'bg-pop-cyan-soft/60',
                )}
              >
                <span className={cn(
                  'grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors',
                  active ? 'border-pop-cyan' : 'border-pop-bd',
                )}>
                  {active && <span className="size-[7px] rounded-full bg-pop-cyan" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] text-pop-ink">{m.name}</span>
                    {m.tag && (
                      <span className="shrink-0 rounded-full border border-pop-green/40 bg-pop-green-soft px-1.5 py-0.5 text-[9px] font-bold text-pop-green">
                        {m.tag}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10.5px] text-pop-dim">{m.desc}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-[9.5px] text-pop-dim">
                    {effortLabel(preset.effort)} · {contextLabel(preset.context)}
                  </span>
                  <span className="block text-[9px] text-pop-dim/60">{active ? '当前' : '预设'}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="border-t border-pop-bd/60 px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-[0.12em] text-pop-dim">思考强度</span>
            <span className="font-mono text-[9px] text-pop-dim">{currentModel}</span>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {COMPOSER_EFFORT_OPTIONS.map((option) => {
              const active = option.id === effort
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onEffortChange(option.id)}
                  aria-pressed={active}
                  className={cn(
                    'h-[26px] rounded-[7px] border text-[11px] transition-colors',
                    active
                      ? 'border-pop-cyan bg-pop-cyan-soft font-bold text-pop-cyan'
                      : 'border-pop-bd bg-pop-bg/40 text-pop-dim hover:border-pop-cyan/50 hover:text-pop-ink',
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="border-t border-pop-bd/60 px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-[0.12em] text-pop-dim">最大上下文</span>
            <span className="font-mono text-[9px] text-pop-dim">{currentModel}</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {COMPOSER_CONTEXT_OPTIONS.map((option) => {
              const active = option.id === context
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onContextChange(option.id)}
                  aria-pressed={active}
                  title={option.hint}
                  className={cn(
                    'flex h-[28px] items-center justify-center gap-1.5 rounded-[7px] border font-mono text-[11px] transition-colors',
                    active
                      ? 'border-pop-cyan bg-pop-cyan-soft font-bold text-pop-cyan'
                      : 'border-pop-bd bg-pop-bg/40 text-pop-dim hover:border-pop-cyan/50 hover:text-pop-ink',
                  )}
                >
                  {option.label}
                  <span className="font-sans text-[9px] font-normal opacity-70">{option.hint}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-1.5 text-[9px] text-pop-dim/60">1M 通过模型变体 [1m] 启用，需模型/网关支持。</p>
        </div>

        <div className="flex items-center gap-2 border-t border-pop-bd/60 px-3 py-2">
          <span className="text-[10px] text-pop-dim">切换模型会显示它自己的预设</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded-md border border-pop-bd px-2 py-0.5 text-[10px] text-pop-ink transition-colors hover:border-pop-cyan hover:text-pop-cyan"
          >
            完成
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
