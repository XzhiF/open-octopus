'use client'

// 原型「+ 挂载」面板（SKILLS / 专家）。
// 数据都走真实系统：SKILL = GET /api/agent/skills，专家 = GET /api/agent/clones。
// 选择只挂在 composer 上，随下一条消息消费（SKILL → /命令前缀；专家 → delegate_to）。

import { useEffect, useRef, useState } from 'react'
import { Check, Plus, Search, Sparkles, Users, X } from 'lucide-react'
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
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // 每次打开都是干净的一次检索（列表会越装越多，别让旧词残留）。
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

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

  const needle = query.trim().toLowerCase()
  const hit = (text?: string | null) => !needle || !!text && text.toLowerCase().includes(needle)
  const filteredSkills = (skills ?? []).filter((s) => hit(s.name) || hit(SOURCE_LABEL[s.source]))
  const filteredClones = (clones ?? []).filter(
    (c) => hit(c.display_name) || hit(c.name) || c.skills.some((name) => hit(name)),
  )
  const currentCount = cat === 'skill' ? filteredSkills.length : filteredClones.length
  const otherMatches = cat === 'skill' ? filteredClones.length : filteredSkills.length
  const otherLabel = cat === 'skill' ? '分身' : 'SKILLS'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="挂载技能 / 分身到本条消息"
          title="挂载技能 / 分身到本条消息"
          className={cn(
            'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border border-transparent px-1.5 text-[11px] transition-colors hover:bg-pop-paper hover:text-pop-ink',
            open
              ? 'border-pop-bd bg-pop-paper text-pop-ink'
              : activeCount > 0 ? 'text-pop-cyan' : 'text-pop-dim',
          )}
        >
          <Plus className={cn('size-3 transition-transform', open && 'rotate-45')} />
          <span>挂载</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[372px] max-w-[calc(100vw_-_24px)] overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
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
          <span className="text-[12px] font-bold text-pop-ink">挂载到本条消息</span>
          <span className="text-[10px] text-pop-dim">勾选后随下一条消息发送</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 px-2.5 pb-2 pt-2.5">
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

        <div className="shrink-0 px-2.5 pb-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-pop-dim/70"
              strokeWidth={1.8}
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称…"
              aria-label="搜索 SKILL / 分身"
              data-testid="attach-search"
              maxLength={80}
              className="h-[28px] w-full rounded-[8px] border border-white/[0.08] bg-white/[0.04] pl-8 pr-7 text-[11.5px] text-pop-ink outline-none transition-colors placeholder:text-pop-dim/60 focus:border-pop-cyan/40"
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim transition-colors hover:text-pop-ink"
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[264px] overflow-y-auto px-2 pb-2">
          {cat === 'skill' ? (
            loading && !skills ? (
              <div className="px-2 py-6 text-center text-[11px] text-pop-dim">加载 SKILL…</div>
            ) : filteredSkills.length > 0 ? (
              filteredSkills.map((s) => {
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
              <div className="px-2 py-6 text-center text-[11px] text-pop-dim">
                {needle ? '未找到匹配的 SKILL' : '暂无已安装 SKILL'}
              </div>
            )
          ) : loading && !clones ? (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">加载分身…</div>
          ) : filteredClones.length > 0 ? (
            filteredClones.map((c) => {
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
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">
              {needle ? '未找到匹配的分身' : '暂无分身'}
            </div>
          )}
          {needle && currentCount === 0 && otherMatches > 0 && (
            <button
              type="button"
              data-testid="attach-search-other-tab"
              onClick={() => setCat(cat === 'skill' ? 'expert' : 'skill')}
              className="mt-1 w-full rounded-[9px] border border-dashed border-pop-bd px-2 py-1.5 text-[11px] text-pop-dim transition-colors hover:border-pop-cyan/50 hover:text-pop-ink"
            >
              在「{otherLabel}」中有 {otherMatches} 项匹配 →
            </button>
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
