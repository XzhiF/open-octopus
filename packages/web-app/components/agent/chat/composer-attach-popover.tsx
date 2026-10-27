'use client'

// Composer 的「＋」：单层面板 = 分身（委派 / 切换）+ SKILL。
//
// 设计（2026-10-27 原型 v2 拍板）：
//   - 不再分「挂载 / 切换身份」两个文字入口：＋ 是唯一入口；有长期身份时
//     ＋ 原地变成紫色 `◈ 名称 ▾`，仍是同一个控件。
//   - 不再两级下钻：搜索框一次过过滤所有分组，分身行内并列「委派」「切换」。
//   - 委派 = 一次性子代理会诊（随下一条消息消费）；切换 = 会话长期身份
//     （每轮生效，走 useSessionIdentity）。
//
// 文件上传目前平台没有通道，故面板只列分身 / SKILL —— 不摆假入口。

import { useEffect, useRef, useState } from 'react'
import { Check, Plus, Search, Sparkles, Users, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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

export interface ComposerIdentityControls {
  /** 当前长期身份 clone name（null = 基础身份）。 */
  activeName: string | null
  /** 当前身份展示名（null = 基础身份）。 */
  label: string | null
  /** 切换长期身份（null = 恢复基础）。label 供宿主做乐观展示。 */
  onSwitch: (cloneName: string | null, cloneLabel?: string | null) => void | Promise<void>
}

interface ComposerAttachPopoverProps {
  skill: ComposerSkillRef | null
  expert: ComposerExpertRef | null
  onSkillChange: (skill: ComposerSkillRef | null) => void
  onExpertChange: (expert: ComposerExpertRef | null) => void
  /** 会话身份控制。缺省 = 该宿主不支持切换身份（不渲染切换钮）。 */
  identity?: ComposerIdentityControls
  /** 受控开合（hero 态的身份 chip 也要能打开同一个面板）。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
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

export function ComposerAttachPopover({
  skill,
  expert,
  onSkillChange,
  onExpertChange,
  identity,
  open: controlledOpen,
  onOpenChange,
}: ComposerAttachPopoverProps) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = controlledOpen ?? innerOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(next)
    onOpenChange?.(next)
  }

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
        setSkills(skillRes.status === 'fulfilled' ? (skillRes.value.skills ?? []) : [])
        setClones(cloneRes.status === 'fulfilled'
          ? cloneRes.value.clones.filter((c) => c.name !== 'main-agent')
          : [])
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, skills, clones])

  const needle = query.trim().toLowerCase()
  const hit = (text?: string | null) => !needle || !!text && text.toLowerCase().includes(needle)

  // 列表规模是几十条，直接过滤即可（无需 memo，也避免 hit 进依赖的噪音）。
  const filteredSkills = (skills ?? []).filter((s) => hit(s.name) || hit(SOURCE_LABEL[s.source]))
  const filteredClones = (clones ?? []).filter(
    (c) => hit(c.display_name) || hit(c.name) || c.skills.some((name) => hit(name)),
  )

  const activeCount = (skill ? 1 : 0) + (expert ? 1 : 0)
  const identityActive = !!identity?.activeName

  const toggleExpert = (clone: CloneInfo) => {
    const on = expert?.name === clone.name
    onExpertChange(on ? null : { name: clone.name, displayName: clone.display_name })
  }

  const switchIdentity = (cloneName: string | null, cloneLabel?: string | null) => {
    if (!identity) return
    void identity.onSwitch(cloneName, cloneLabel)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={identityActive ? `当前身份 ${identity?.label ?? ''}` : '添加'}
          title={identityActive
            ? `当前分身身份：${identity?.label}（点击管理）`
            : '添加：SKILL / 分身（委派或切换身份）'}
          data-testid="composer-plus"
          className={cn(
            'relative flex shrink-0 items-center justify-center gap-1 transition-colors',
            identityActive
              ? 'h-[22px] rounded-[7px] border border-pop-purple/50 bg-pop-purple-soft px-1.5 text-[11px] text-pop-purple'
              : 'size-[22px] rounded-[7px] border border-pop-bd bg-pop-pink text-pop-bg hover:opacity-90',
            open && !identityActive && 'opacity-80',
          )}
        >
          {identityActive ? (
            <>
              <Users className="size-3 shrink-0" />
              <span className="max-w-[130px] truncate">◈ {identity?.label}</span>
              <span aria-hidden className="text-[8px] opacity-70">▾</span>
            </>
          ) : (
            <>
              <Plus
                className={cn('size-3.5 transition-transform', open && 'rotate-45')}
                strokeWidth={2.4}
              />
              {activeCount > 0 && (
                <span className="absolute -right-1 -top-1 grid size-[13px] place-items-center rounded-full bg-pop-cyan text-[8px] font-black text-pop-bg">
                  {activeCount}
                </span>
              )}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        data-testid="composer-plus-panel"
        className="w-[392px] max-w-[calc(100vw_-_24px)] overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-2 border-b border-pop-bd/60 px-3 py-2.5">
          <span className="text-[12px] font-bold text-pop-ink">添加</span>
          <span className="ml-auto font-mono text-[10px] text-pop-dim">Esc</span>
        </div>

        <div className="px-2.5 pb-1 pt-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-pop-dim/70"
              strokeWidth={1.8}
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 SKILL / 分身…"
              aria-label="搜索 SKILL / 分身"
              data-testid="attach-search"
              maxLength={80}
              className="h-[29px] w-full rounded-[8px] border border-white/[0.08] bg-white/[0.04] pl-8 pr-7 text-[11.5px] text-pop-ink outline-none transition-colors placeholder:text-pop-dim/60 focus:border-pop-cyan/40"
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => { setQuery(''); searchRef.current?.focus() }}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim transition-colors hover:text-pop-ink"
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto px-1.5 pb-1.5" data-plus-list>
          {/* ── 分身 ─────────────────────────────────────────────── */}
          {(!needle || filteredClones.length > 0) && (
            <div data-plus-group="clone">
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                  分身 <span className="font-normal">{clones?.length ?? ''}</span>
                </span>
                <span className="ml-auto text-[9.5px] text-pop-dim">
                  <b className="font-extrabold text-pop-cyan">委派</b>=本轮 · <i className="font-extrabold not-italic text-pop-purple">切换</i>=长期
                </span>
              </div>
              {identity && (
                <div
                  data-base-identity
                  className={cn(
                    'flex items-center gap-2 rounded-[9px] px-2 py-1.5',
                    !identity.activeName && 'bg-pop-cyan-soft/40',
                  )}
                >
                  <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-white/[0.05] text-[11px] text-pop-dim">
                    ◉
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-pop-ink">基础身份（主 Agent）</span>
                    <span className="block text-[10px] text-pop-dim">默认角色，无分身岗位包</span>
                  </span>
                  <button
                    type="button"
                    data-testid="switch-identity-base"
                    onClick={() => switchIdentity(null, null)}
                    className={cn(
                      'h-[21px] shrink-0 rounded-[6px] border px-1.5 text-[10px] transition-colors',
                      !identity.activeName
                        ? 'border-pop-cyan/55 bg-pop-cyan-soft text-pop-cyan'
                        : 'border-pop-bd text-pop-dim hover:border-pop-cyan/55 hover:text-pop-cyan',
                    )}
                  >
                    {!identity.activeName ? '切换 ✓' : '切换'}
                  </button>
                </div>
              )}
              {loading && !clones ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">加载分身…</div>
              ) : filteredClones.length === 0 ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">未找到匹配的分身</div>
              ) : (
                filteredClones.map((c) => {
                  const delegated = expert?.name === c.name
                  const isActive = identity?.activeName === c.name
                  const status = CLONE_STATUS[c.status] ?? CLONE_STATUS.idle
                  const sub = c.skills.length > 0
                    ? `SKILL ${c.skills.join(' · ')}`
                    : (c.persona || (c.type === 'built-in' ? '系统分身' : '自定义分身'))
                  return (
                    <div
                      key={c.name}
                      data-clone-row={c.name}
                      className={cn(
                        'flex items-center gap-2 rounded-[9px] px-2 py-1.5',
                        isActive && 'bg-pop-purple-soft/60',
                      )}
                    >
                      <span className={cn(
                        'grid size-[22px] shrink-0 place-items-center rounded-full text-[11px]',
                        isActive ? 'bg-pop-purple/20 text-pop-purple' : 'bg-white/[0.05] text-pop-dim',
                      )}>
                        {isActive ? '◈' : '◉'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] text-pop-ink">{c.display_name}</span>
                          <span className="flex shrink-0 items-center gap-1 text-[9px] text-pop-dim">
                            <span className={cn('size-1.5 rounded-full', status.dot)} />
                            {status.label}
                          </span>
                        </span>
                        <span className="block truncate text-[10px] text-pop-dim" title={sub}>{sub}</span>
                      </span>
                      <button
                        type="button"
                        data-delegate-clone={c.name}
                        data-testid={`delegate-clone-${c.name}`}
                        onClick={() => toggleExpert(c)}
                        className={cn(
                          'h-[21px] shrink-0 rounded-[6px] border px-1.5 text-[10px] transition-colors',
                          delegated
                            ? 'border-pop-cyan/55 bg-pop-cyan-soft text-pop-cyan'
                            : 'border-pop-bd text-pop-dim hover:border-pop-cyan/55 hover:text-pop-cyan',
                        )}
                      >
                        {delegated ? '已委派' : '委派'}
                      </button>
                      {identity && (
                        <button
                          type="button"
                          data-switch-identity={c.name}
                          data-testid={`switch-identity-${c.name}`}
                          onClick={() => switchIdentity(
                            isActive ? null : c.name,
                            isActive ? null : c.display_name,
                          )}
                          className={cn(
                            'h-[21px] shrink-0 rounded-[6px] border px-1.5 text-[10px] transition-colors',
                            isActive
                              ? 'border-pop-purple/55 bg-pop-purple-soft text-pop-purple'
                              : 'border-pop-bd text-pop-dim hover:border-pop-purple/55 hover:text-pop-purple',
                          )}
                        >
                          {isActive ? '切换 ✓' : '切换'}
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* ── SKILL ────────────────────────────────────────────── */}
          {(!needle || filteredSkills.length > 0) && (
            <div data-plus-group="skill">
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                  SKILL <span className="font-normal">{skills?.length ?? ''}</span>
                </span>
              </div>
              {loading && !skills ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">加载 SKILL…</div>
              ) : filteredSkills.length === 0 ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">未找到匹配的 SKILL</div>
              ) : (
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
              )}
            </div>
          )}

          {needle && filteredClones.length === 0 && filteredSkills.length === 0 && (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">未找到匹配项</div>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-pop-bd/60 px-3 py-2 text-[10px] text-pop-dim">
          <span className={cn('size-1.5 rounded-full', identityActive ? 'bg-pop-purple' : 'bg-pop-dim')} />
          <span>当前身份：<b className="font-extrabold text-pop-ink">{identity?.label ?? '基础（主 Agent）'}</b></span>
          <span className="ml-auto">@ 委派 · / 挂技能</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
