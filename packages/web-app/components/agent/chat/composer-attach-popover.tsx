'use client'

// Composer 的「＋」：按类别分层的添加面板。
//
// 设计（2026-10-27 分层原型 A 拍板）：
//   - 类别导航放顶部：技能 / 分身 / MCP（以后 Prompt / 文件 直接加一类）。
//     不再把所有条目堆进一个滚动列表。
//   - 技能类：当前身份自带的 SKILL 固定置顶（只读，随身份生效），
//     下面才是「全部 SKILL」的挂载列表。
//   - 分身类：委派（一次性子代理，随下一条消息消费）/ 切换（会话长期身份）
//     都在这里；hero 新会话不传 identity，只保留委派。
//   - MCP 类：会话实际挂载的 in-process 服务（octopus-workflow / octopus-task）
//     的只读卡：先见 server，点开看它的全部 tools（GET /api/agent/mcp/servers）。

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Plug, Plus, Search, Sparkles, Users, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '@/lib/format'
import * as api from '@/lib/agent/api'
import { listWorkspaceSkills, type WorkspaceSkillInfo } from '@/lib/api-client'
import type { McpServerMeta } from '@/lib/agent/api'
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

/** 只读身份上下文：展示「当前身份 + 它自带的 SKILL」，不提供切换。 */
export interface ComposerIdentityContext {
  name: string
  label: string | null
}

/** 当前工作区（只读）：展示 <workspace>/.claude/skills 里的技能。 */
export interface ComposerWorkspaceContext {
  id: string
  label: string
}

interface ComposerAttachPopoverProps {
  skill: ComposerSkillRef | null
  expert: ComposerExpertRef | null
  onSkillChange: (skill: ComposerSkillRef | null) => void
  onExpertChange: (expert: ComposerExpertRef | null) => void
  /** 会话身份控制。缺省 = 该宿主不支持切换身份（不渲染切换钮）。 */
  identity?: ComposerIdentityControls
  /** 当前身份（只读）——用于置顶它自带的 SKILL；hero 新会话也会传。 */
  identityContext?: ComposerIdentityContext | null
  /** 当前工作区（只读）——用于置顶工作区自带的 SKILL。 */
  workspaceContext?: ComposerWorkspaceContext | null
  /** 受控开合（hero 态的身份 chip 也要能打开同一个面板）。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

type AttachCategory = 'skill' | 'clone' | 'mcp'

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
  identityContext,
  workspaceContext,
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
  const [workspaceSkills, setWorkspaceSkills] = useState<WorkspaceSkillInfo[] | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerMeta[] | null>(null)
  // 手风琴展开态：＋面板本身就是弹层，二级再开 Dialog 会双焦点打架 —— 用行内展开。
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<AttachCategory>('skill')
  const searchRef = useRef<HTMLInputElement>(null)

  // 每次打开都是干净的一次检索（列表会越装越多，别让旧词残留）。
  useEffect(() => {
    if (open) {
      setQuery('')
      setCategory('skill')
    }
  }, [open])

  useEffect(() => {
    if (!open || skills || clones) return
    let alive = true
    setLoading(true)
    Promise.allSettled([api.listSkills(), api.listClones(), api.listMcpServers()])
      .then(([skillRes, cloneRes, mcpRes]) => {
        if (!alive) return
        // 服务端返回 { items }；老接口曾用 { skills } —— 两者都认（
        // 只读 .skills 会让技能页永远为空，用户只看到分身）。
        setSkills(
          skillRes.status === 'fulfilled'
            ? (skillRes.value.skills ?? skillRes.value.items ?? [])
            : [],
        )
        setClones(cloneRes.status === 'fulfilled'
          ? cloneRes.value.clones.filter((c) => c.name !== 'main-agent')
          : [])
        setMcpServers(mcpRes.status === 'fulfilled' ? mcpRes.value.servers ?? [] : [])
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, skills, clones])

  // 工作区自带技能：<workspace>/.claude/skills（只读）。选了工作区才拉。
  useEffect(() => {
    const id = workspaceContext?.id
    if (!id || !open) {
      setWorkspaceSkills(null)
      return
    }
    let alive = true
    setWorkspaceSkills(null)
    listWorkspaceSkills(id)
      .then((res) => { if (alive) setWorkspaceSkills(res.items ?? []) })
      .catch(() => { if (alive) setWorkspaceSkills([]) })
    return () => { alive = false }
  }, [open, workspaceContext?.id])

  const needle = query.trim().toLowerCase()
  const hit = (text?: string | null) => !needle || !!text && text.toLowerCase().includes(needle)

  // 列表规模是几十条，直接过滤即可（无需 memo，也避免 hit 进依赖的噪音）。
  const filteredSkills = (skills ?? []).filter((s) => hit(s.name) || hit(SOURCE_LABEL[s.source]))
  const filteredClones = (clones ?? []).filter(
    (c) => hit(c.display_name) || hit(c.name) || c.skills.some((name) => hit(name)),
  )
  const filteredMcp = (mcpServers ?? []).filter(
    (s) =>
      hit(s.server) || hit(s.label) || hit(s.description) ||
      s.tools.some((t) => hit(t.name) || hit(t.description)),
  )
  // 搜索命中工具时自动展开所属 server（找工具的人不该再点一次）。
  const isMcpExpanded = (s: McpServerMeta) =>
    expandedServer === s.server ||
    (!!needle && s.tools.some((t) => hit(t.name) || hit(t.description)))

  // 当前身份自带的 SKILL：只读展示（随身份生效），不参与挂载勾选。
  const activeClone = identityContext
    ? (clones ?? []).find((c) => c.name === identityContext.name) ?? null
    : null
  const boundSkills = activeClone?.skills ?? []
  const boundSkillSet = new Set(boundSkills)
  const filteredBoundSkills = boundSkills.filter((name) => hit(name))

  const workspaceSkillList = workspaceSkills ?? []
  const workspaceSkillSet = new Set(workspaceSkillList.map((s) => s.name))
  const filteredWorkspaceSkills = workspaceSkillList.filter((s) => hit(s.name))

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
        className="flex h-[452px] w-[490px] max-w-[calc(100vw_-_24px)] max-h-[var(--radix-popover-content-available-height,80vh)] flex-col overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-pop-bd/60 px-3 py-2.5">
          <span className="text-[12px] font-bold text-pop-ink">添加</span>
          {identityContext?.label && (
            <span
              data-testid="attach-identity-chip"
              className="inline-flex h-5 items-center gap-1 rounded-[6px] border border-pop-purple/45 bg-pop-purple-soft px-1.5 text-[10px] text-pop-purple"
            >
              ◈ {identityContext.label}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-pop-dim">Esc</span>
        </div>

        <div className="shrink-0 px-2.5 pb-1 pt-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-pop-dim/70"
              strokeWidth={1.8}
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索技能 / 分身 / MCP…"
              aria-label="搜索技能 / 分身 / MCP"
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

        {/* 类别导航：以后 MCP / Prompt / 文件 直接在这里加一项。 */}
        <div className="flex shrink-0 gap-1 px-2 pt-2" role="tablist" aria-label="添加类别">
          <button
            type="button"
            role="tab"
            aria-selected={category === 'skill'}
            data-testid="attach-tab-skill"
            onClick={() => setCategory('skill')}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition-colors',
              category === 'skill'
                ? 'border-pop-bd bg-white/[0.06] font-bold text-pop-ink'
                : 'border-transparent text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
            )}
          >
            <Sparkles className="size-3" strokeWidth={1.9} />
            技能
            <span className={cn('font-mono text-[9.5px]', category === 'skill' ? 'text-pop-ink' : 'text-pop-dim')}>
              {filteredSkills.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={category === 'clone'}
            data-testid="attach-tab-clone"
            onClick={() => setCategory('clone')}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition-colors',
              category === 'clone'
                ? 'border-pop-bd bg-white/[0.06] font-bold text-pop-ink'
                : 'border-transparent text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
            )}
          >
            <Users className="size-3" strokeWidth={1.9} />
            分身
            <span className={cn('font-mono text-[9.5px]', category === 'clone' ? 'text-pop-ink' : 'text-pop-dim')}>
              {filteredClones.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={category === 'mcp'}
            data-testid="attach-tab-mcp"
            onClick={() => setCategory('mcp')}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition-colors',
              category === 'mcp'
                ? 'border-pop-bd bg-white/[0.06] font-bold text-pop-ink'
                : 'border-transparent text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
            )}
          >
            <Plug className="size-3" strokeWidth={1.9} />
            MCP
            <span className={cn('font-mono text-[9.5px]', category === 'mcp' ? 'text-pop-ink' : 'text-pop-dim')}>
              {filteredMcp.length}
            </span>
          </button>
        </div>

        <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" data-plus-list>
          {category === 'skill' ? (
            <div data-plus-group="skill" role="tabpanel" aria-label="技能">
              {/* 身份自带：只读，随身份生效 */}
              {boundSkills.length > 0 && (
                <div data-testid="attach-bound-skills">
                  <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                    <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                      身份自带 <span className="font-normal">{boundSkills.length}</span>
                    </span>
                    <span className="ml-auto text-[9.5px] text-pop-dim">随身份生效 · 无需挂载</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 px-2 pb-2">
                    {filteredBoundSkills.map((name) => (
                      <span
                        key={name}
                        data-bound-skill={name}
                        className="inline-flex h-[22px] items-center gap-1 rounded-[6px] border border-pop-green/30 bg-pop-green-soft px-2 font-mono text-[10.5px] text-pop-green"
                      >
                        ⬢ {name}
                        <span aria-hidden className="text-[9px] opacity-80">✓</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 工作区自带：只读，随工作区目录生效 */}
              {filteredWorkspaceSkills.length > 0 && (
                <div data-testid="attach-bound-workspace-skills">
                  <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                    <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                      工作区自带 <span className="font-normal">{workspaceSkillList.length}</span>
                    </span>
                    <span className="ml-auto max-w-[190px] truncate text-[9.5px] text-pop-dim">
                      {workspaceContext?.label ?? '当前工作区'} · 随工作区生效
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 px-2 pb-2">
                    {filteredWorkspaceSkills.map((wsSkill) => (
                      <span
                        key={wsSkill.name}
                        data-bound-workspace-skill={wsSkill.name}
                        className="inline-flex h-[22px] items-center gap-1 rounded-[6px] border border-pop-yellow/30 bg-pop-yellow-soft px-2 font-mono text-[10.5px] text-pop-yellow"
                      >
                        ⬢ {wsSkill.name}
                        <span aria-hidden className="text-[9px] opacity-80">✓</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                  全部 SKILL <span className="font-normal">{filteredSkills.length}</span>
                </span>
                {skill && (
                  <span className="ml-auto text-[9.5px] text-pop-cyan">已挂载 {skill.name}</span>
                )}
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
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] text-pop-ink">{s.name}</span>
                          {boundSkillSet.has(s.name) ? (
                            <span className="shrink-0 rounded-[5px] border border-pop-green/30 bg-pop-green-soft px-1 py-0.5 text-[8.5px] text-pop-green">
                              身份自带
                            </span>
                          ) : workspaceSkillSet.has(s.name) ? (
                            <span className="shrink-0 rounded-[5px] border border-pop-yellow/30 bg-pop-yellow-soft px-1 py-0.5 text-[8.5px] text-pop-yellow">
                              工作区自带
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-[10px] text-pop-dim">
                          {SOURCE_LABEL[s.source]} · {formatTokenCount(s.token_count)} tokens
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          ) : category === 'clone' ? (
            <div data-plus-group="clone" role="tabpanel" aria-label="分身">
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                  分身 <span className="font-normal">{filteredClones.length}</span>
                </span>
                {identity && (
                  <span className="ml-auto text-[9.5px] text-pop-dim">
                    <b className="font-extrabold text-pop-cyan">委派</b>=本轮 · <i className="font-extrabold not-italic text-pop-purple">切换</i>=长期
                  </span>
                )}
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
                  const isCurrent = identityContext?.name === c.name
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
                        isActive || isCurrent ? 'bg-pop-purple/20 text-pop-purple' : 'bg-white/[0.05] text-pop-dim',
                      )}>
                        {isActive || isCurrent ? '◈' : '◉'}
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
          ) : (
            <div data-plus-group="mcp" role="tabpanel" aria-label="MCP">
              <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-pop-paper px-2 pb-1 pt-2.5">
                <span className="text-[9.5px] font-black tracking-[0.08em] text-pop-dim/70">
                  MCP 服务 <span className="font-normal">{filteredMcp.length}</span>
                </span>
                <span className="ml-auto text-[9.5px] text-pop-dim">内置能力随会话自动挂载 · 点开看工具</span>
              </div>
              {loading && !mcpServers ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">加载 MCP…</div>
              ) : filteredMcp.length === 0 ? (
                <div className="px-2 py-4 text-center text-[11px] text-pop-dim">未找到匹配的服务</div>
              ) : (
                filteredMcp.map((s) => {
                  const openS = isMcpExpanded(s)
                  return (
                    <div
                      key={s.server}
                      data-mcp-row={s.server}
                      className="mb-1 overflow-hidden rounded-[9px] border border-pop-bd/50"
                    >
                      <button
                        type="button"
                        data-testid={`mcp-server-${s.server}`}
                        aria-expanded={openS}
                        onClick={() => setExpandedServer(openS && expandedServer === s.server ? null : s.server)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                      >
                        <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-pop-cyan/15 text-pop-cyan">
                          <Plug className="size-3" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] font-bold text-pop-ink">{s.label}</span>
                            <span className="shrink-0 font-mono text-[9.5px] text-pop-dim">{s.server}</span>
                            <span className="ml-auto shrink-0 rounded-[5px] border border-pop-bd/60 px-1 py-0.5 font-mono text-[8.5px] text-pop-dim">
                              {s.tools.length} 工具
                            </span>
                          </span>
                          <span className="block truncate text-[10px] text-pop-dim">{s.when}</span>
                        </span>
                        <ChevronDown
                          className={cn('size-3.5 shrink-0 text-pop-dim transition-transform', openS && 'rotate-180')}
                        />
                      </button>
                      {openS && (
                        <div data-mcp-tools={s.server} className="space-y-1.5 border-t border-pop-bd/40 bg-white/[0.02] px-2.5 py-2">
                          <p className="text-[10px] leading-relaxed text-pop-dim/80">{s.description}</p>
                          {s.tools.map((t) => (
                            <div key={t.name} className="flex flex-col gap-0.5">
                              <span className="font-mono text-[10.5px] font-bold text-pop-ink">{t.name}</span>
                              <span className="text-[10px] leading-snug text-pop-dim">{t.description}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-pop-bd/60 px-3 py-2 text-[10px] text-pop-dim">
          {activeClone && identityContext?.label ? (
            <>
              <span className="size-1.5 rounded-full bg-pop-purple" />
              <span>
                当前身份 <b className="font-extrabold text-pop-ink">{identityContext.label}</b>
                {' '}· 技能 {boundSkills.length} 随身份生效
              </span>
            </>
          ) : identity ? (
            <>
              <span className={cn('size-1.5 rounded-full', identityActive ? 'bg-pop-purple' : 'bg-pop-dim')} />
              <span>当前身份：<b className="font-extrabold text-pop-ink">{identity.label ?? '基础（主 Agent）'}</b></span>
            </>
          ) : (
            <span>SKILL 随本条消息生效</span>
          )}
          <span className="ml-auto">/ 挂技能 · @ 委派</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
