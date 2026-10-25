'use client'

// 原型「+ 上下文」面板（SKILLS / 专家）。
// 数据都走真实系统：SKILL = GET /api/agent/skills，专家 = GET /api/agent/clones。
// 选择只挂在 composer 上，随下一条消息消费（SKILL → /命令前缀；专家 → delegate_to）。

import { useEffect, useState } from 'react'
import { Check, Plus, Sparkles, Users } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '@/lib/format'
import * as api from '@/lib/agent/api'
import type { CloneInfo, SkillInfo, SkillSource } from '@/lib/agent/types'

export interface ComposerSkillRef {
  name: string
  source?: SkillSource
  tokenCount?: number
}

export interface ComposerExpertRef {
  name: string
  displayName: string
}

interface ComposerAttachPopoverProps {
  skill: ComposerSkillRef | null
  expert: ComposerExpertRef | null
  onSkillChange: (skill: ComposerSkillRef | null) => void
  onExpertChange: (expert: ComposerExpertRef | null) => void
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  builtin: '内置',
  local_evolved: '本地进化',
  prod: '生产',
}

const CLONE_STATUS: Record<CloneInfo['status'], { dot: string; label: string }> = {
  active: { dot: 'bg-pop-green', label: '活跃' },
  idle: { dot: 'bg-pop-dim', label: '空闲' },
  executing: { dot: 'bg-pop-amber', label: '执行中' },
}

export function ComposerAttachPopover({ skill, expert, onSkillChange, onExpertChange }: ComposerAttachPopoverProps) {
  const [open, setOpen] = useState(false)
  const [cat, setCat] = useState<'skill' | 'expert'>('skill')
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [clones, setClones] = useState<CloneInfo[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || skills || clones) return
    let alive = true
    setLoading(true)
    Promise.allSettled([api.listSkills(), api.listClones()])
      .then(([skillRes, cloneRes]) => {
        if (!alive) return
        setSkills(skillRes.status === 'fulfilled' ? (skillRes.value.skills ?? skillRes.value.items ?? []) : [])
        setClones(cloneRes.status === 'fulfilled'
          ? cloneRes.value.clones.filter((c) => c.name !== 'main-agent')
          : [])
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, skills, clones])

  const activeCount = (skill ? 1 : 0) + (expert ? 1 : 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="添加上下文"
          title="附加上下文：SKILL / 分身"
          className={cn(
            'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border border-transparent px-1.5 text-[11px] transition-colors hover:bg-pop-paper hover:text-pop-ink',
            open
              ? 'border-pop-bd bg-pop-paper text-pop-ink'
              : activeCount > 0 ? 'text-pop-cyan' : 'text-pop-dim',
          )}
        >
          <Plus className={cn('size-3 transition-transform', open && 'rotate-45')} />
          <span>上下文</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[372px] max-w-[calc(100vw_-_24px)] overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-pop-bd/60 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            className="group/light grid size-6 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-pop-yellow"
          >
            <CloseLightGlyph />
          </button>
          <span className="text-[12px] font-bold text-pop-ink">添加到对话</span>
          <span className="text-[10px] text-pop-dim">勾选后随下一条消息发送</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 p-2.5">
          {([
            { id: 'skill' as const, label: 'SKILLS', icon: Sparkles, count: skills?.length },
            { id: 'expert' as const, label: '分身', icon: Users, count: clones?.length },
          ]).map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => setCat(id)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-[10px] border px-2 py-2 text-[11px] transition-colors',
                cat === id
                  ? 'border-pop-cyan bg-pop-cyan-soft text-pop-cyan'
                  : 'border-pop-bd bg-pop-bg/40 text-pop-dim hover:border-pop-cyan/50 hover:text-pop-ink',
              )}
            >
              <Icon className="size-3.5" />
              {label}
              <span className="font-mono text-[9px] text-pop-dim">{loading && count == null ? '…' : (count ?? 0)}</span>
            </button>
          ))}
        </div>

        <div className="max-h-[264px] overflow-y-auto px-2 pb-2">
          {cat === 'skill' ? (
            loading && !skills ? (
              <div className="px-2 py-6 text-center text-[11px] text-pop-dim">加载 SKILL…</div>
            ) : skills && skills.length > 0 ? (
              skills.map((s) => {
                const on = skill?.name === s.name
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => onSkillChange(on ? null : { name: s.name, source: s.source, tokenCount: s.token_count })}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
                      on && 'bg-pop-cyan-soft/60',
                    )}
                  >
                    <span className={cn(
                      'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors',
                      on ? 'border-pop-cyan bg-pop-cyan text-pop-bg' : 'border-pop-bd text-transparent',
                    )}>
                      {on && <Check className="size-2.5" />}
                    </span>
                    <Sparkles className={cn('size-3.5 shrink-0', on ? 'text-pop-cyan' : 'text-pop-dim')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-pop-ink">{s.name}</span>
                      <span className="block truncate text-[10px] text-pop-dim">
                        {SOURCE_LABEL[s.source]} · {formatTokenCount(s.token_count)} tokens
                      </span>
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="px-2 py-6 text-center text-[11px] text-pop-dim">暂无已安装 SKILL</div>
            )
          ) : loading && !clones ? (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">加载分身…</div>
          ) : clones && clones.length > 0 ? (
            clones.map((c) => {
              const on = expert?.name === c.name
              const status = CLONE_STATUS[c.status] ?? CLONE_STATUS.idle
              const sub = c.skills.length > 0 ? `SKILL ${c.skills.join(' · ')}` : (c.persona || (c.type === 'built-in' ? '内置分身' : '自定义分身'))
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => onExpertChange(on ? null : { name: c.name, displayName: c.display_name })}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
                    on && 'bg-pop-cyan-soft/60',
                  )}
                >
                  <span className={cn(
                    'grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors',
                    on ? 'border-pop-cyan' : 'border-pop-bd',
                  )}>
                    {on && <span className="size-2 rounded-full bg-pop-cyan" />}
                  </span>
                  <Users className={cn('size-3.5 shrink-0', on ? 'text-pop-cyan' : 'text-pop-dim')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-pop-ink">{c.display_name}</span>
                    <span className="block truncate text-[10px] text-pop-dim" title={sub}>{sub}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-pop-dim">
                    <span className={cn('size-1.5 rounded-full', status.dot)} />
                    {status.label}
                  </span>
                </button>
              )
            })
          ) : (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">暂无分身</div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-pop-bd/60 px-3 py-2">
          <span className="text-[10px] text-pop-dim">
            SKILL 以 /命令发送 · 专家走委托
          </span>
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
