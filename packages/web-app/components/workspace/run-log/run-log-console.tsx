'use client'

// 运行日志控制台 —— 终端式 + 并发可读（取代旧的按节点折叠块日志）
//
// 三层结构：
//   ① 通道栏（左）：谁在说话、说了多少行、什么状态 —— 点一下只看它
//   ② 并发轨道（顶）：每通道的起止时间条，重叠就是并发
//   ③ 合流终端（主）：全局时间序单流；「分屏」视图则一通道一个 pane 各自 tail
// DAG 点节点 = 聚焦该通道（focus 由父级受控，两面因此天然联动）。
//
// 事件与状态分别来自 GET agent-events（服务端已全局时间序合并）与执行详情的 steps。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format'
import { useExecutionEvents } from '@/hooks/use-execution-events'
import type { StepExecution } from '@/lib/types'
import {
  buildChannels,
  buildRows,
  channelMatchesFocus,
  concurrentStreams,
  displayNameOf,
  elapsedMs,
  filterRows,
  tail,
  type LogChannel,
  type LogRow,
  type RunEvent,
  type StreamLevel,
} from './log-channels'
import { LogLine } from './log-line'

const TAIL_ROWS = 400
const TAIL_STEP = 400
const PANE_ROWS = 150
const LIVE_STATUS = new Set(['running', 'paused', 'pending', 'pending_interaction'])

export interface RunLogConsoleProps {
  workspaceId: string
  executionId: string
  executionStatus?: string
  steps: StepExecution[]
  /** 受控聚焦通道（DAG 点击与日志共用） */
  focus?: string | null
  onFocusChange?: (id: string | null) => void
  className?: string
}

type View = 'stream' | 'split'

const STATUS_TEXT: Record<LogChannel['status'], string> = {
  pending: '排队', running: '运行中', done: '已完成', failed: '失败', skipped: '跳过',
}

function indentVar(showTs: boolean): CSSProperties {
  return { '--log-indent': showTs ? '212px' : '122px' } as CSSProperties
}

const RAIL_KEY = 'octopus.runlog.rail.v1'
const RAIL_DEFAULT = 190
const RAIL_MIN = 140
const RAIL_MAX = 420

function readRailWidth(): number {
  if (typeof window === 'undefined') return RAIL_DEFAULT
  try {
    const raw = Number(window.localStorage.getItem(RAIL_KEY))
    return Number.isFinite(raw) && raw > 0
      ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, raw))
      : RAIL_DEFAULT
  } catch {
    return RAIL_DEFAULT
  }
}

/* ───────────────────────── 小控件 ───────────────────────── */

function ToolButton({
  active, onClick, children, title, testid,
}: { active?: boolean; onClick: () => void; children: React.ReactNode; title?: string; testid?: string }) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-[22px] items-center gap-1 rounded-lg border px-2 text-[10px] font-black transition-colors',
        active
          ? 'border-pop-green/40 bg-pop-green-soft text-pop-green'
          : 'border-transparent text-pop-dim hover:bg-white/[0.06] hover:text-pop-ink',
      )}
    >
      {children}
    </button>
  )
}

function Seg<T extends string>({
  value, options, onChange, testid,
}: { value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void; testid?: string }) {
  return (
    <div data-testid={testid} className="inline-flex overflow-hidden rounded-lg border border-pop-bd">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'h-[22px] px-2 text-[10px] font-black border-r border-pop-bd last:border-r-0',
            value === o.v ? 'bg-white/[0.09] text-pop-ink' : 'text-pop-dim hover:text-pop-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ───────────────────────── 通道栏 ───────────────────────── */

function ChannelRail({
  channels, totalRows, focus, onFocus, width,
}: {
  channels: LogChannel[]
  totalRows: number
  focus: string | null
  onFocus: (id: string | null) => void
  width: number
}) {
  return (
    <div
      className="flex shrink-0 flex-col border-r border-pop-bd bg-pop-bg"
      style={{ width }}
      data-testid="log-rail"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.05] px-2.5 py-1.5 text-[8.5px] font-black tracking-[0.14em] text-pop-dim/70">
        <span>通道</span>
        <span className="text-[9px] tracking-normal text-pop-ink">{channels.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <button
          type="button"
          onClick={() => onFocus(null)}
          className={cn(
            'flex w-full items-center gap-1.5 border-l-2 px-2.5 py-1.5 text-left text-[10px]',
            !focus ? 'border-pop-ink bg-white/[0.07] text-pop-ink' : 'border-transparent text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
          )}
        >
          <span className="min-w-0 flex-1 truncate font-black">全部通道</span>
          <span className="shrink-0 text-[9px] tabular-nums text-pop-dim/70">{totalRows}</span>
        </button>
        {channels.map((c) => {
          const on = channelMatchesFocus(c, focus)
          return (
            <button
              key={c.id}
              type="button"
              data-testid="rail-item"
              onClick={() => onFocus(on ? null : c.id)}
              title={`${c.node}${c.roles.length > 1 ? ` · ${c.roles.join('/')}` : ''}`}
              className={cn(
                'flex w-full items-center gap-1.5 border-l-2 px-2.5 py-1.5 text-left text-[10px]',
                on ? 'bg-white/[0.07] text-pop-ink' : 'text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
                c.status === 'pending' && 'opacity-45',
              )}
              style={{ borderLeftColor: on ? c.color : 'transparent' }}
            >
              <span
                className={cn('size-1.5 shrink-0 rounded-full', c.status === 'running' && 'animate-pulse')}
                style={{ background: c.color, opacity: c.status === 'pending' ? 0.3 : 1 }}
              />
              <span className="min-w-0 flex-1 truncate font-black" style={{ color: c.color }}>
                {displayNameOf(c)}
                {c.roles.length > 1 && c.status === 'running' && (
                  <span className="ml-1 rounded border border-pop-pink/30 bg-pop-pink-soft px-1 text-[8px] font-black text-pop-pink">{c.roles.length} 专家</span>
                )}
              </span>
              <span className="shrink-0 text-[9px] tabular-nums text-pop-dim/70">{c.count || ''}</span>
            </button>
          )
        })}
        {!channels.length && <div className="px-2.5 py-3 text-[10px] text-pop-dim/60">等待执行…</div>}
      </div>
    </div>
  )
}

/* ───────────────────────── 并发轨道 ───────────────────────── */

function ConcurrencyRibbon({
  channels, now, focus, onFocus, live,
}: {
  channels: LogChannel[]
  now: number
  focus: string | null
  onFocus: (id: string | null) => void
  live: boolean
}) {
  const rows = channels.filter((c) => c.startedAt != null)
  if (!rows.length) return null
  const from = Math.min(...rows.map((c) => c.startedAt as number))
  const to = Math.max(now, ...rows.map((c) => c.endedAt ?? now))
  const span = Math.max(1000, to - from)

  return (
    <div className="shrink-0 border-b border-white/[0.06] bg-pop-bg px-2.5 pt-1 pb-0.5" data-testid="log-ribbon">
      <div className="flex items-center gap-1.5 text-[8.5px] font-black tracking-[0.14em] text-pop-dim/70">
        <span>并发轨道</span>
        <span className="text-[9px] tracking-normal text-pop-ink">{concurrentStreams(channels)}</span>
        <span className="text-[8.5px] font-normal tracking-normal text-pop-dim/60">条在跑</span>
        <span className="ml-auto text-[9px] font-normal tabular-nums text-pop-dim/70">t+{formatDuration(span)}</span>
      </div>
      <div className="max-h-[104px] overflow-y-auto">
        {rows.map((c) => {
          const start = (c.startedAt as number) - from
          const end = (c.endedAt ?? (live ? now : c.startedAt as number)) - from
          const left = (start / span) * 100
          const width = Math.max(0.6, ((end - start) / span) * 100)
          const running = c.status === 'running'
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onFocus(channelMatchesFocus(c, focus) ? null : c.id)}
              className="group flex h-[14px] w-full items-center gap-1.5 text-left"
              title={`${c.node} · ${STATUS_TEXT[c.status]} · ${formatDuration(elapsedMs(c, now))}`}
            >
              <span className="w-[76px] shrink-0 truncate text-[9px] font-black" style={{ color: c.color }}>{displayNameOf(c)}</span>
              <span className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                <span
                  className={cn('absolute inset-y-0 rounded-full', running ? 'opacity-100' : 'opacity-70')}
                  style={{ left: `${left}%`, width: `${width}%`, background: c.color, boxShadow: running ? `0 0 8px color-mix(in oklab, ${c.color} 55%, transparent)` : undefined }}
                />
              </span>
              <span className="w-[46px] shrink-0 text-right text-[9px] tabular-nums text-pop-dim/70">{formatDuration(elapsedMs(c, now))}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ───────────────────────── 合流终端 ───────────────────────── */

function LogStream({
  rows, chById, showTs, follow, setFollow, expanded, onToggle, query, live, emptyText, capButton,
}: {
  rows: LogRow[]
  chById: Map<string, LogChannel>
  showTs: boolean
  follow: boolean
  setFollow: (v: boolean) => void
  expanded: Set<string>
  onToggle: (id: string) => void
  query?: string
  live: boolean
  emptyText: string
  capButton?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const count = rows.length

  useEffect(() => {
    const el = ref.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [count, follow])

  return (
    <div
      ref={ref}
      data-testid="log-stream"
      style={indentVar(showTs)}
      className="min-h-0 flex-1 overflow-y-auto bg-pop-inset pb-6"
      onScroll={(e) => {
        const el = e.currentTarget
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
      }}
    >
      {capButton}
      {!count
        ? <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-pop-dim/60">{emptyText}</div>
        : (
          <>
            {rows.map((r, i) => (
              <LogLine
                key={r.id}
                row={r}
                ch={chById.get(r.chId)}
                cont={i > 0 && rows[i - 1].chId === r.chId}
                showTs={showTs}
                expanded={expanded.has(r.id)}
                query={query}
                onToggle={onToggle}
              />
            ))}
            {live && (
              <div className="flex items-center gap-2 px-3 pt-1 font-mono text-[9.5px] text-pop-dim/50">
                <span className="inline-block h-[13px] w-[7px] animate-pulse bg-pop-green" />
                <span>输出中</span>
              </div>
            )}
          </>
        )}
    </div>
  )
}

/* ───────────────────────── 分屏 pane ───────────────────────── */

function LogPane({
  ch, rows, expanded, onToggle, maximized, onMaximize, live, now, follow, setFollow,
}: {
  ch: LogChannel
  rows: LogRow[]
  expanded: Set<string>
  onToggle: (id: string) => void
  maximized: boolean
  onMaximize: () => void
  live: boolean
  now: number
  follow: boolean
  setFollow: (v: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = tail(rows, PANE_ROWS).shown
  useEffect(() => {
    const el = ref.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [shown.length, follow])

  return (
    <section
      data-testid="log-pane"
      data-channel={ch.id}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-pop-bd bg-pop-inset"
      style={{ borderTop: `2px solid ${ch.color}`, opacity: ch.status === 'running' ? 1 : 0.62 }}
    >
      <header className="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-pop-bg px-2 text-[9.5px]">
        <span className={cn('size-1.5 rounded-full', ch.status === 'running' && 'animate-pulse')} style={{ background: ch.color }} />
        <span className="min-w-0 flex-1 truncate font-black" style={{ color: ch.color }} title={ch.node}>{displayNameOf(ch)}</span>
        <span className="shrink-0 tabular-nums text-pop-dim/70">
          {STATUS_TEXT[ch.status]} · {formatDuration(elapsedMs(ch, now))} · {ch.count} 行
          {ch.roles.length > 1 && ch.status === 'running' ? ` · ${ch.roles.length} 专家` : ''}
        </span>
        <button
          type="button"
          onClick={onMaximize}
          title={maximized ? '还原分屏' : '放大该通道'}
          className="grid size-[18px] shrink-0 place-items-center rounded text-pop-dim hover:bg-white/[0.08] hover:text-pop-ink"
        >
          {maximized ? '⤡' : '⤢'}
        </button>
      </header>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        // pane 内无时间戳无通道标，展开正文跟着行首缩进
        style={{ '--log-indent': '118px' } as CSSProperties}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {shown.length
          ? shown.map((r, i) => (
            <LogLine
              key={r.id}
              row={r}
              ch={ch}
              cont={i > 0 && shown[i - 1].role === r.role}
              showTs={false}
              showTag={false}
              expanded={expanded.has(r.id)}
              onToggle={onToggle}
            />
          ))
          : <div className="px-2.5 py-2 text-[10px] text-pop-dim/50">{live ? '已启动，暂无输出…' : '— 无输出 —'}</div>}
      </div>
    </section>
  )
}

/* ───────────────────────── 主体 ───────────────────────── */

export function RunLogConsole({
  workspaceId, executionId, executionStatus, steps, focus = null, onFocusChange, className,
}: RunLogConsoleProps) {
  const { events, loading, error } = useExecutionEvents(workspaceId, executionId, executionStatus)
  const [view, setView] = useState<View>('stream')
  const [level, setLevel] = useState<StreamLevel>('all')
  const [query, setQuery] = useState('')
  const [showTs, setShowTs] = useState(true)
  const [showRibbon, setShowRibbon] = useState(true)
  const [follow, setFollow] = useState(true)
  const [cap, setCap] = useState(TAIL_ROWS)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [maximized, setMaximized] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // 通道栏宽度：拖拽调整并持久化；默认 190，范围 140–420。双击复位。
  const [railW, setRailW] = useState(readRailWidth)
  const railWRef = useRef(railW)

  const commitRailW = useCallback(() => {
    try { window.localStorage.setItem(RAIL_KEY, String(railWRef.current)) } catch { /* private mode */ }
  }, [])

  const startRailDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = railWRef.current
    const move = (ev: PointerEvent) => {
      const next = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + ev.clientX - startX))
      railWRef.current = next
      setRailW(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      commitRailW()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [commitRailW])

  const resetRailW = useCallback(() => {
    setRailW(RAIL_DEFAULT)
    railWRef.current = RAIL_DEFAULT
    commitRailW()
  }, [commitRailW])

  const live = LIVE_STATUS.has(executionStatus ?? '')

  // 运行中每秒拨一次表，让「运行中 · 12.4s」和并发轨道跟着长
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])

  const rows = useMemo(() => buildRows(events as RunEvent[]), [events])
  const channels = useMemo(() => buildChannels(rows, steps), [rows, steps])
  const chById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels])
  const visible = useMemo(() => filterRows(rows, { channel: focus, level, query }), [rows, focus, level, query])
  const { hidden, shown } = useMemo(() => tail(visible, cap), [visible, cap])
  const streams = concurrentStreams(channels)
  const focusCh = channels.find((c) => channelMatchesFocus(c, focus))
  // 秒表只在运行时走：看历史执行时「现在」落在最后一次活动上，
  // 否则停在 running 的节点（取消/中断留下的）会算出几十年耗时
  const lastRowAt = rows.length ? rows[rows.length - 1].at : 0
  const clock = live
    ? now
    : Math.max(lastRowAt, ...channels.map((c) => c.endedAt ?? c.startedAt ?? 0), 0)

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const onFocus = useCallback((id: string | null) => {
    onFocusChange?.(id)
    setCap(TAIL_ROWS)
  }, [onFocusChange])

  const rowsOfChannel = useCallback((id: string) => rows.filter((r) => r.chId === id), [rows])

  const capButton = hidden > 0 ? (
    <button
      type="button"
      onClick={() => setCap((c) => c + TAIL_STEP)}
      className="mb-1 w-full py-1 text-center text-[9.5px] text-pop-dim/60 hover:text-pop-ink"
    >
      …更早 {hidden} 行已折叠，点击展开
    </button>
  ) : null

  const pillTone = error ? 'text-pop-red' : live ? 'text-pop-green' : 'text-pop-dim'
  const pillText = error ? '日志读取失败' : live ? 'LIVE' : executionStatus ? '已结束' : '连接中'

  if (loading && !rows.length) {
    return (
      <div className={cn('flex h-full items-center justify-center bg-pop-inset text-[11px] text-pop-dim', className)}>
        读取日志…
      </div>
    )
  }

  // 分屏下「聚焦」就等于放大：DAG 点节点和 ⤢ 都落到同一个效果上
  const pinned = maximized ?? focus
  const pinnedList = pinned ? channels.filter((c) => channelMatchesFocus(c, pinned)) : channels
  const splitChannels = pinnedList.length ? pinnedList : channels

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-pop-bg', className)} data-testid="run-log-console">
      {/* 工具条 */}
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-pop-bd bg-pop-paper/50 px-2.5" data-testid="log-head">
        <span className="font-mono text-[10.5px] font-black text-pop-ink">执行日志</span>
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[9px] font-black', pillTone === 'text-pop-green' ? 'border-pop-green/35 bg-pop-green-soft' : 'border-pop-bd')}>
          <span className={cn('size-[5px] rounded-full bg-current', live && 'animate-pulse')} />
          {pillText}
        </span>
        <span className="rounded-full border border-pop-bd px-2 py-[2px] text-[9px] font-black text-pop-dim">
          {streams > 1 ? `${streams} 并发` : streams === 1 ? '1 条流' : '空闲'}
        </span>
        {focusCh && (
          <button
            type="button"
            data-testid="focus-pill"
            onClick={() => onFocus(null)}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[9px] font-black"
            style={{ color: focusCh.color, borderColor: focusCh.color }}
          >
            仅 {displayNameOf(focusCh)} ×
          </button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Seg
            value={view}
            testid="view-seg"
            onChange={(v) => { setView(v); setMaximized(null) }}
            options={[{ v: 'stream', label: '合流' }, { v: 'split', label: '分屏' }]}
          />
          <div className="flex h-[22px] items-center gap-1 rounded-lg border border-pop-bd bg-pop-inset px-1.5">
            <span className="text-[10px] text-pop-dim/60">⌕</span>
            <input
              data-testid="log-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="过滤日志…"
              className="h-full w-[104px] bg-transparent text-[10px] text-pop-ink outline-none placeholder:text-pop-dim/50"
            />
            {query && <span className="text-[8.5px] text-pop-amber">{visible.length} 行</span>}
          </div>
          <Seg
            value={level}
            testid="level-seg"
            onChange={setLevel}
            options={[{ v: 'all', label: '全部' }, { v: 'summary', label: '摘要' }, { v: 'problem', label: '异常' }]}
          />
          {view === 'stream' && (
            <>
              <ToolButton active={showTs} onClick={() => setShowTs((v) => !v)} title="显示/隐藏时间戳">时间戳</ToolButton>
              <ToolButton active={showRibbon} onClick={() => setShowRibbon((v) => !v)} title="显示/隐藏并发轨道" testid="toggle-ribbon">轨道</ToolButton>
            </>
          )}
          <ToolButton active={follow} onClick={() => setFollow((v) => !v)} title="跟随输出（上滚自动取消）" testid="toggle-follow">跟随</ToolButton>
        </div>
      </div>

      {error && <div className="shrink-0 border-b border-pop-red/30 bg-pop-red/10 px-3 py-1.5 text-[10.5px] text-pop-red">{error}</div>}

      {view === 'stream' ? (
        <div className="flex min-h-0 flex-1">
          <ChannelRail channels={channels} totalRows={rows.length} focus={focus} onFocus={onFocus} width={railW} />
          {/* 通道栏 ↔ 日志的拖拽分隔条：只留一条 1px 竖线，不挂任何居中图标。 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整通道栏宽度"
            title="拖拽调整通道栏宽度（双击复位）"
            data-testid="log-rail-splitter"
            onPointerDown={startRailDrag}
            onDoubleClick={resetRailW}
            className="group relative w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-pop-bg"
          >
            <span className="pointer-events-none absolute inset-y-0 left-[2px] w-px bg-pop-bd transition-colors group-hover:bg-pop-pink/60" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {showRibbon && <ConcurrencyRibbon channels={channels} now={clock} focus={focus} onFocus={onFocus} live={live} />}
            <LogStream
              rows={shown}
              chById={chById}
              showTs={showTs}
              follow={follow}
              setFollow={setFollow}
              expanded={expanded}
              onToggle={toggle}
              query={query}
              live={live}
              emptyText={focus ? '该通道暂无输出' : query || level !== 'all' ? '没有匹配的日志行' : '等待执行…'}
              capButton={capButton}
            />
          </div>
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-2 overflow-auto p-2"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(320px, 1fr))` }}
          data-testid="log-panes"
        >
          {splitChannels.length ? splitChannels.map((c) => (
            <LogPane
              key={c.id}
              ch={c}
              rows={rowsOfChannel(c.id)}
              expanded={expanded}
              onToggle={toggle}
              maximized={pinned === c.id}
              onMaximize={() => {
                if (pinned === c.id) { setMaximized(null); onFocus(null) } else { setMaximized(c.id) }
              }}
              live={live}
              now={clock}
              follow={follow}
              setFollow={setFollow}
            />
          )) : <div className="col-span-full grid place-items-center text-[11px] text-pop-dim/60">等待执行…</div>}
        </div>
      )}

      {/* 状态栏 */}
      <div className="flex h-[24px] shrink-0 items-center gap-2.5 border-t border-white/[0.06] bg-pop-bg px-2.5 font-mono text-[9px] text-pop-dim">
        <span className={cn('inline-flex items-center gap-1 font-black', pillTone)}>
          <span className={cn('size-[5px] rounded-full bg-current', live && 'animate-pulse')} />
          {pillText}
        </span>
        <span>{streams} 条流 · {channels.length} 通道 · {rows.length} 行</span>
        {!follow && (
          <button type="button" onClick={() => setFollow(true)} className="font-black text-pop-green hover:underline" data-testid="pin-latest">
            ↓ 回到最新
          </button>
        )}
        <span className="ml-auto text-pop-dim/50">
          {view === 'stream' ? '点通道/ DAG 节点聚焦 · 点带 ▸ 的行展开正文' : '⤢ 放大单通道 · 点 DAG 节点直接定位'}
        </span>
      </div>
    </div>
  )
}
