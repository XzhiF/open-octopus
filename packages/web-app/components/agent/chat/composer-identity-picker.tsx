'use client'

// 新会话（hero）里的「主 Agent 身份」选择器。
//
// 这里只回答一个问题：这个 agent 用哪个主身份跑。所以是单选、点了就走，
// 不掺「委派」（那是随单条消息消费的一次性子代理，属于 ＋ 面板）。
// 复用 ＋ 面板会把「挂 SKILL / 委派」摆到一个尚未开始的会话面前，语义太重。

import { useEffect, useState } from 'react'
import { Check, Users, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { CloneInfo } from '@/lib/agent/types'

export interface ComposerIdentityPickerProps {
  /** 当前主身份 clone name（null = 基础身份）。 */
  activeName: string | null
  /** 当前主身份展示名（null = 基础身份）。 */
  label: string | null
  /** 选中即生效（hero 阶段 = 记在本地，首条消息发送前落角色卡）。 */
  onSelect: (cloneName: string | null, cloneLabel?: string | null) => void | Promise<void>
}

function cloneHint(clone: CloneInfo): string {
  if (clone.skills.length > 0) return `SKILL ${clone.skills.join(' · ')}`
  const persona = clone.persona
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (persona) return persona.length > 36 ? `${persona.slice(0, 36)}…` : persona
  return clone.type === 'built-in' ? '系统分身' : '自定义分身'
}

export function ComposerIdentityPicker({
  activeName,
  label,
  onSelect,
}: ComposerIdentityPickerProps) {
  const [open, setOpen] = useState(false)
  const [clones, setClones] = useState<CloneInfo[] | null>(null)

  useEffect(() => {
    if (!open || clones) return
    let alive = true
    api
      .listClones()
      .then((res) => {
        if (alive) setClones(res.clones.filter((c) => c.name !== 'main-agent'))
      })
      .catch(() => {
        if (alive) setClones([])
      })
    return () => {
      alive = false
    }
  }, [open, clones])

  const choose = (cloneName: string | null, cloneLabel?: string | null) => {
    setOpen(false)
    void onSelect(cloneName, cloneLabel)
  }

  const row = (
    key: string,
    name: string | null,
    display: string,
    hint: string,
    testId: string,
  ) => {
    const active = activeName === name
    return (
      <button
        key={key}
        type="button"
        data-testid={testId}
        aria-pressed={active}
        onClick={() => choose(name, name === null ? null : display)}
        className={cn(
          'flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
          active && 'bg-pop-purple-soft/50',
        )}
      >
        <span
          className={cn(
            'grid size-[22px] shrink-0 place-items-center rounded-full text-[11px]',
            active ? 'bg-pop-purple/20 text-pop-purple' : 'bg-white/[0.05] text-pop-dim',
          )}
        >
          {active ? '◈' : '◉'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-pop-ink">{display}</span>
          <span className="block truncate text-[10px] text-pop-dim">{hint}</span>
        </span>
        {active && <Check className="size-3.5 shrink-0 text-pop-purple" />}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="tui-hero-identity"
          title="选择主 Agent 身份"
          className={cn(
            'group flex h-[27px] items-center gap-1.5 rounded-[8px] border px-2.5 text-[11.5px] transition-colors',
            activeName
              ? 'border-pop-purple/45 bg-pop-purple-soft text-pop-purple'
              : 'border-dashed border-pop-bd text-pop-dim hover:border-pop-dim hover:text-pop-ink',
          )}
        >
          <Users className="size-3" />
          <span className="max-w-[240px] truncate">{label ?? '基础身份（主 Agent）'}</span>
          {/* 已选分身时，悬停露 ✕ —— 一键清除回主身份（2026-10-30 用户定稿）。 */}
          {activeName && (
            <span
              role="button"
              tabIndex={0}
              aria-label="清除身份，回到主身份"
              title="清除身份，回到主身份"
              data-testid="tui-hero-identity-clear"
              onClick={(e) => {
                e.stopPropagation()
                void onSelect(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  void onSelect(null)
                }
              }}
              className="ml-0.5 grid size-3 place-items-center rounded-full opacity-0 transition-opacity hover:bg-pop-purple/15 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <X className="size-2.5" />
            </span>
          )}
          <span aria-hidden className="text-[9px] opacity-70">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        data-testid="hero-identity-panel"
        className="w-[300px] max-w-[calc(100vw_-_24px)] rounded-[12px] border-[1.5px] border-pop-bd bg-pop-paper p-1.5 shadow-pop"
      >
        <div className="px-2 pb-1 pt-1 text-[10px] font-black tracking-[0.08em] text-pop-dim/70">
          主 Agent 身份
        </div>
        <p className="px-2 pb-2 text-[10px] leading-snug text-pop-dim">
          新会话的第一条消息就按这个身份运行。
        </p>

        <div className="max-h-[220px] overflow-y-auto">
          {row('base', null, '基础身份（主 Agent）', '默认角色，无分身岗位包', 'hero-identity-base')}

          {clones === null ? (
            <div className="px-2 py-4 text-center text-[11px] text-pop-dim">加载身份…</div>
          ) : clones.length === 0 ? (
            <div className="px-2 py-4 text-center text-[11px] text-pop-dim">暂无分身</div>
          ) : (
            clones.map((clone) =>
              row(
                clone.name,
                clone.name,
                clone.display_name,
                cloneHint(clone),
                `hero-identity-${clone.name}`,
              ),
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
