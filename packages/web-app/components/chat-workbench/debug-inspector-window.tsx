'use client'

// Dock 「调试」 —— per-turn SDK inspector.
//
// Design decision (user, 2026-11-01): the dock is the ONLY entry. The chat
// transcript stays a pure transcript; debug is a window-level tool, alongside
// 消耗 / 运行. The window opens on the NEWEST turn, lists turns newest-first,
// and collapses everything older than the latest 10.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getSessionDebugTurn, listSessionDebugTurns } from '@/lib/agent/debug-api'
import type {
  TurnDebugDetail,
  TurnDebugEvent,
  TurnDebugIdentity,
  TurnDebugSummary,
  TurnDebugUsage,
} from '@/lib/agent/debug-types'
import { useBillingCurrency } from '@/lib/billing-currency'
import { copyToClipboard, cn } from '@/lib/utils'
import { formatCost, formatDuration, formatTokenCount, type CostDisplay } from '@/lib/format'
import { Spinner } from '@/components/ui/spinner'

type Tab = 'overview' | 'prompt' | 'identity' | 'sdk' | 'timeline'
type Filter = 'all' | 'switch' | 'anomaly'
type UserView = 'raw' | 'sent'

interface DebugInspectorWindowProps {
  sessionId: string | null
  /** Bumped by the chat (message count / streaming state) to refresh an open
   *  inspector without waiting for the running-turn poll. */
  refreshKey?: string | number
}

const IDENTITY_COLORS = [
  'var(--pop-pink)',
  'var(--pop-purple)',
  'var(--pop-cyan)',
  'var(--pop-amber)',
  'var(--pop-green)',
  'var(--pop-navy)',
  'var(--pop-violet)',
]

const STATUS_META: Record<string, { label: string; glyph: string; color: string; tag: 'purple' | 'green' | 'amber' | 'red' }> = {
  ok: { label: '已完成', glyph: '✓', color: 'var(--pop-green)', tag: 'green' },
  interrupted: { label: '已中止', glyph: '!', color: 'var(--pop-amber)', tag: 'amber' },
  error: { label: '出错', glyph: '✕', color: 'var(--pop-red)', tag: 'red' },
  running: { label: '记录中', glyph: '…', color: 'var(--pop-cyan)', tag: 'purple' },
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? STATUS_META.running
}

function fmtExact(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

function fmtClock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
}

function fmtOffset(ms: number): string {
  return ms >= 1000 ? `+${(ms / 1000).toFixed(2)}s` : `+${Math.round(ms)}ms`
}

function turnLabel(n: number): string {
  return `T${n}`
}

function durationOf(turn: TurnDebugSummary, now: number): number | null {
  if (turn.status === 'running') {
    const started = Date.parse(turn.started_at)
    return Number.isFinite(started) ? Math.max(0, now - started) : null
  }
  return turn.duration_ms
}

function identityName(t: { identity: TurnDebugIdentity } | null | undefined): string {
  return t?.identity?.name ?? '主 Agent'
}

function usageTotal(u: TurnDebugUsage | null | undefined): number {
  return u?.totalTokens ?? 0
}

/** Cost is derived from the ledger; `≈` when any matched call is unpriced. */
function fmtUsageCost(usage: TurnDebugUsage | null | undefined, currency: CostDisplay): string {
  return formatCost(usage?.costUsd ?? null, usage?.costComplete ?? true, currency)
}

function listValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/** Plugin entries are either already `{ type, path }` objects (recorded by the
 *  chat route) or JSON strings (older rows). Always show the path. */
function pluginPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => {
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v) as { path?: string }
          return parsed.path ?? v
        } catch {
          return v
        }
      }
      if (v && typeof v === 'object' && 'path' in v) {
        return String((v as { path?: unknown }).path ?? '')
      }
      return String(v)
    })
    .filter(Boolean)
}

function SegButton({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-[17px] rounded-[3px] px-1.5 text-[9px] transition-colors',
        on ? 'bg-pop-purple-soft text-pop-purple' : 'text-pop-dim hover:text-pop-ink',
      )}
    >
      {children}
    </button>
  )
}

function Section({ title, link }: { title: string; link?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-1 flex items-center gap-1.5 text-[9.5px] font-bold tracking-[0.08em] text-[#7f818c]">
      <span>{title}</span>
      <span className="h-px flex-1 bg-[#2a2a32]" />
      {link}
    </div>
  )
}

function Tag({
  tone = 'default',
  children,
  className,
  title,
}: {
  tone?: 'default' | 'purple' | 'green' | 'amber' | 'red'
  children: React.ReactNode
  className?: string
  title?: string
}) {
  const toneCls =
    tone === 'purple'
      ? 'border-pop-purple/35 bg-pop-purple-soft text-pop-purple'
      : tone === 'green'
        ? 'border-pop-green/30 bg-pop-green-soft text-pop-green'
        : tone === 'amber'
          ? 'border-pop-amber/30 bg-pop-amber-soft text-pop-amber'
          : tone === 'red'
            ? 'border-pop-red/30 bg-pop-red/10 text-pop-red'
            : 'border-[#30303a] bg-[#19191f] text-[#8b8d98]'
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[18px] items-center gap-1 rounded-[4px] border px-1.5 text-[9px]',
        toneCls,
        className,
      )}
    >
      {children}
    </span>
  )
}

function Callout({
  tone = 'purple',
  children,
}: {
  tone?: 'purple' | 'amber'
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'mt-2 rounded-r-[6px] border-l-2 px-2.5 py-2 text-[9.5px] leading-relaxed text-[#a9abb5]',
        tone === 'purple'
          ? 'border-pop-purple bg-pop-purple/[0.05]'
          : 'border-pop-amber bg-pop-amber/[0.05]',
      )}
    >
      {children}
    </div>
  )
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-[10px] text-[#6f7280]">
      <span className="text-[20px] text-[#4a4b55]">⌘</span>
      <span>{title}</span>
      {detail && <span className="max-w-[360px] leading-relaxed">{detail}</span>}
    </div>
  )
}

export function DebugInspectorWindow({ sessionId, refreshKey }: DebugInspectorWindowProps) {
  const currency = useBillingCurrency()
  const [turns, setTurns] = useState<TurnDebugSummary[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState(false)
  const [userView, setUserView] = useState<UserView>('raw')
  const [detail, setDetail] = useState<TurnDebugDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const pickedRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  // ── List ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) {
      setTurns([])
      setSelectedTurn(null)
      setListError(null)
      return
    }
    let alive = true
    setListLoading(true)
    listSessionDebugTurns(sessionId)
      .then((res) => {
        if (!alive) return
        const next = res.turns ?? []
        setTurns(next)
        setListError(null)
        setSelectedTurn((current) => {
          if (pickedRef.current && current != null && next.some((t) => t.turn_index === current)) {
            return current
          }
          return next[0]?.turn_index ?? null
        })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setListError(err instanceof Error ? err.message : '读取调试记录失败')
      })
      .finally(() => {
        if (alive) setListLoading(false)
      })
    return () => { alive = false }
  }, [sessionId, refreshNonce, refreshKey])

  useEffect(() => {
    pickedRef.current = false
    setSelectedTurn(null)
    setTab('overview')
    setFilter('all')
    setExpanded(false)
    setUserView('raw')
    setDetail(null)
    setDetailError(null)
  }, [sessionId])

  const hasRunning = turns.some((t) => t.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setRefreshNonce((n) => n + 1), 2_500)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  useEffect(() => {
    if (!hasRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  // ── Detail ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || selectedTurn == null) {
      setDetail(null)
      return
    }
    let alive = true
    setDetailLoading(true)
    getSessionDebugTurn(sessionId, selectedTurn)
      .then((next) => {
        if (!alive) return
        setDetail(next)
        setDetailError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setDetail(null)
        setDetailError(err instanceof Error ? err.message : '读取本轮快照失败')
      })
      .finally(() => {
        if (alive) setDetailLoading(false)
      })
    return () => { alive = false }
  }, [sessionId, selectedTurn, refreshNonce, refreshKey])

  useEffect(() => {
    setUserView('raw')
  }, [selectedTurn])

  // ── Derived ─────────────────────────────────────────────────────
  const newest = useMemo(() => turns, [turns])
  const ascending = useMemo(
    () => [...turns].sort((a, b) => a.turn_index - b.turn_index),
    [turns],
  )
  const latestIndex = ascending.length > 0 ? ascending[ascending.length - 1].turn_index : null
  const switches = useMemo(() => turns.filter((t) => t.has_switch).length, [turns])
  const anomalies = useMemo(() => turns.filter((t) => t.status !== 'ok' && t.status !== 'running').length, [turns])
  const totalCost = useMemo(() => {
    let total: number | null = null
    for (const turn of turns) {
      if (turn.usage?.costUsd == null) continue
      total = (total ?? 0) + turn.usage.costUsd
    }
    return total
  }, [turns])
  const totalCostComplete = useMemo(
    () => turns.every((turn) => turn.usage?.costComplete !== false),
    [turns],
  )

  const identityColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const turn of ascending) {
      const name = identityName(turn)
      if (map.has(name)) continue
      if (turn.identity.kind === 'base') {
        map.set(name, IDENTITY_COLORS[0])
        continue
      }
      const used = new Set(map.values())
      map.set(name, IDENTITY_COLORS.find((c) => c !== IDENTITY_COLORS[0] && !used.has(c)) ?? IDENTITY_COLORS[1])
    }
    return map
  }, [ascending])

  const counts = useMemo(
    () => ({
      all: turns.length,
      switch: switches,
      anomaly: anomalies,
    }),
    [turns.length, switches, anomalies],
  )

  const filtered = useMemo(() => {
    if (filter === 'switch') return newest.filter((t) => t.has_switch)
    if (filter === 'anomaly') return newest.filter((t) => t.status !== 'ok' && t.status !== 'running')
    return newest
  }, [newest, filter])

  const collapsed = filter === 'all' && !expanded && filtered.length > 10
  const visible = collapsed ? filtered.slice(0, 10) : filtered
  const current = useMemo(
    () => turns.find((t) => t.turn_index === selectedTurn) ?? null,
    [turns, selectedTurn],
  )

  const scrollToSelected = useCallback(() => {
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>('[data-debug-turn-on="true"]')
      row?.scrollIntoView?.({ block: 'nearest' })
    })
  }, [])

  useEffect(() => {
    scrollToSelected()
  }, [selectedTurn, expanded, filter, scrollToSelected])

  const selectTurn = useCallback((turnIndex: number, nextTab?: Tab) => {
    pickedRef.current = true
    setSelectedTurn(turnIndex)
    if (nextTab) setTab(nextTab)
    const index = newest.findIndex((t) => t.turn_index === turnIndex)
    if (index >= 10 && filter === 'all') setExpanded(true)
  }, [newest, filter])

  const jumpLatest = useCallback(() => {
    if (latestIndex == null) return
    // Back to "follow the newest" mode: the next turn auto-selects.
    pickedRef.current = false
    setSelectedTurn(latestIndex)
    setFilter('all')
    setExpanded(false)
  }, [latestIndex])

  const changeFilter = useCallback((next: Filter) => {
    setFilter(next)
    const pool = next === 'switch'
      ? newest.filter((t) => t.has_switch)
      : next === 'anomaly'
        ? newest.filter((t) => t.status !== 'ok' && t.status !== 'running')
        : newest
    if (selectedTurn != null && !pool.some((t) => t.turn_index === selectedTurn) && pool[0]) {
      pickedRef.current = true
      setSelectedTurn(pool[0].turn_index)
    }
  }, [newest, selectedTurn])

  const copySnapshot = useCallback(() => {
    if (!detail) return
    const ok = copyToClipboard(JSON.stringify(detail, null, 2))
    if (ok) toast.success(`已复制 T${detail.turn_index} 快照 JSON`)
    else toast.error('当前环境不支持剪贴板')
  }, [detail])

  const detailMeta = detail ? statusMeta(detail.status) : null
  const isLatest = current != null && current.turn_index === latestIndex

  if (!sessionId) {
    return <Empty title="还没有会话" detail="发送一条消息后，这里会记录本轮真正交给 SDK 的 prompt、身份卡与参数。" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-pop-paper text-pop-ink">
      {/* ── 轨迹头：统计 + 轮次尺 ─────────────────────────────── */}
      <div className="flex min-h-[58px] shrink-0 items-stretch border-b border-[#26262e] bg-[#1a1a20]">
        <div className="flex w-[214px] shrink-0 flex-col justify-center gap-0.5 border-r border-[#26262e] px-2.5 py-1.5">
          <span className="text-[8px] font-bold tracking-[0.1em] text-[#5f616c]">SESSION TRAJECTORY</span>
          <span className="flex items-baseline gap-1.5 text-[10px] text-[#8b8d98]">
            <b className="text-[12px] text-pop-ink">{turns.length}</b>
            <span>轮</span>
            <span className="ml-auto font-bold text-pop-amber">{formatCost(totalCost, totalCostComplete, currency)}</span>
          </span>
          <span className="truncate text-[8.5px] text-[#63656f]">
            <span className="text-pop-purple">{switches} 次切换</span>
            {' · '}
            <span className="text-pop-amber">{anomalies} 异常</span>
            {latestIndex != null && ` · 最新 ${turnLabel(latestIndex)}`}
          </span>
          <div className="mt-0.5 flex items-center gap-1">
            <button
              type="button"
              title="更早一轮"
              disabled={!current || current.turn_index <= (ascending[0]?.turn_index ?? 0)}
              onClick={() => {
                if (!current) return
                const idx = ascending.findIndex((t) => t.turn_index === current.turn_index)
                if (idx > 0) selectTurn(ascending[idx - 1].turn_index)
              }}
              className="grid size-5 place-items-center rounded-[4px] text-[10px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink disabled:opacity-30"
            >
              ‹
            </button>
            <button
              type="button"
              title="更新一轮"
              disabled={!current || current.turn_index >= (latestIndex ?? 0)}
              onClick={() => {
                if (!current) return
                const idx = ascending.findIndex((t) => t.turn_index === current.turn_index)
                if (idx >= 0 && idx < ascending.length - 1) selectTurn(ascending[idx + 1].turn_index)
              }}
              className="grid size-5 place-items-center rounded-[4px] text-[10px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink disabled:opacity-30"
            >
              ›
            </button>
            <button
              type="button"
              title="复制本轮快照 JSON"
              onClick={copySnapshot}
              disabled={!detail}
              className="ml-auto grid h-5 place-items-center rounded-[4px] px-1.5 text-[8.5px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink disabled:opacity-30"
            >
              {'{ }'}
            </button>
            <button
              type="button"
              title="刷新"
              onClick={() => setRefreshNonce((n) => n + 1)}
              className="grid h-5 place-items-center rounded-[4px] px-1 text-[9px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink"
            >
              ↻
            </button>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-1.5">
          <div className="flex h-[26px] items-end gap-px">
            {ascending.map((turn) => {
              const meta = statusMeta(turn.status)
              const color = identityColors.get(identityName(turn)) ?? 'var(--pop-dim)'
              return (
                <button
                  key={turn.id}
                  type="button"
                  data-debug-turn={turn.turn_index}
                  title={`${turnLabel(turn.turn_index)} · ${identityName(turn)} · ${formatDuration(durationOf(turn, now))} · ${fmtUsageCost(turn.usage, currency)}${turn.has_switch ? ' · 身份切换' : ''}${turn.status !== 'ok' ? ` · ${meta.label}` : ''}`}
                  onClick={() => selectTurn(turn.turn_index)}
                  className={cn(
                    'min-w-[3px] flex-1 rounded-t-[2px] transition-all hover:opacity-100',
                    turn.has_switch ? 'h-[19px] opacity-90' : 'h-[14px] opacity-[0.68]',
                    turn.turn_index === selectedTurn && 'h-[24px] opacity-100 outline outline-1 outline-offset-1 outline-pop-ink',
                  )}
                  style={{
                    backgroundColor: color,
                    boxShadow:
                      turn.status === 'interrupted'
                        ? 'inset 0 -3px 0 var(--pop-amber)'
                        : turn.status === 'error'
                          ? 'inset 0 -3px 0 var(--pop-red)'
                          : undefined,
                  }}
                />
              )
            })}
            {ascending.length === 0 && <span className="self-center text-[9px] text-[#5f616c]">还没有记录</span>}
          </div>
          <div className="flex items-center justify-between gap-2 text-[8px] text-[#5f616c]">
            <span>{ascending.length > 0 ? turnLabel(ascending[0].turn_index) : '—'}</span>
            <span className="flex flex-wrap items-center gap-2 text-[8px] text-[#63656f]">
              {[...identityColors.entries()].slice(0, 5).map(([name, color]) => (
                <span key={name} className="flex items-center gap-1">
                  <i className="inline-block size-1.5 rounded-[1px]" style={{ backgroundColor: color }} />
                  {name}
                </span>
              ))}
              <span className="flex items-center gap-1">
                <i className="inline-block size-1.5 rounded-[1px] bg-pop-amber" />
                异常
              </span>
            </span>
            <span>{latestIndex != null ? turnLabel(latestIndex) : '—'}</span>
          </div>
        </div>
      </div>

      {/* ── 列表 + 详情 ──────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[214px] shrink-0 flex-col border-r border-[#26262e] bg-[#18181d]">
          <div className="shrink-0 border-b border-[#232329] px-2 pb-1.5 pt-2">
            <div className="flex items-center gap-1">
              <span className="text-[8.5px] font-bold tracking-[0.08em] text-[#63656f]">
                {filter === 'switch' ? '身份切换 · 最新在前' : filter === 'anomaly' ? '异常轮 · 最新在前' : '轮次 · 最新在前'}
              </span>
              <button
                type="button"
                onClick={jumpLatest}
                className="ml-auto h-4 rounded-[4px] border border-pop-purple/30 px-1.5 text-[8.5px] text-pop-purple hover:bg-pop-purple-soft"
              >
                ↑ 最新
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-1 border-b border-[#232329] px-2 py-1.5">
            {([
              ['all', '全部', counts.all],
              ['switch', '切换', counts.switch],
              ['anomaly', '异常', counts.anomaly],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => changeFilter(key)}
                className={cn(
                  'h-[17px] whitespace-nowrap rounded-[4px] border px-1.5 text-[8.5px] transition-colors',
                  filter === key
                    ? 'border-pop-purple/35 bg-pop-purple-soft text-pop-purple'
                    : 'border-[#2d2d36] text-[#7f818c] hover:text-pop-ink',
                )}
              >
                {label} {count}
              </button>
            ))}
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            {listError && (
              <div className="px-2 py-4 text-[9.5px] leading-relaxed text-pop-red">
                {listError}
                <button
                  type="button"
                  onClick={() => setRefreshNonce((n) => n + 1)}
                  className="mt-2 block text-pop-purple hover:underline"
                >
                  重试
                </button>
              </div>
            )}
            {!listError && visible.length === 0 && !listLoading && (
              <div className="px-2 py-6 text-center text-[9.5px] leading-relaxed text-[#6f7280]">
                {turns.length === 0 ? (
                  <>
                    还没有调试记录。
                    <br />
                    发送一条消息后，本轮会记录在这里。
                  </>
                ) : (
                  '该过滤下没有轮次'
                )}
              </div>
            )}
            {visible.map((turn) => {
              const meta = statusMeta(turn.status)
              const selected = turn.turn_index === selectedTurn
              const latest = turn.turn_index === latestIndex
              return (
                <button
                  key={turn.id}
                  type="button"
                  data-debug-turn-on={selected ? 'true' : undefined}
                  data-debug-row={turn.turn_index}
                  onClick={() => selectTurn(turn.turn_index)}
                  className={cn(
                    'mb-px block w-full rounded-[6px] border px-1.5 py-[5px] text-left transition-colors',
                    selected
                      ? 'border-pop-purple/30 bg-pop-purple-soft'
                      : 'border-transparent hover:bg-[#1f1f26]',
                  )}
                >
                  <span className="flex items-center gap-1">
                    <span className={cn('text-[10px] font-bold', selected ? 'text-pop-purple' : 'text-pop-dim')}>
                      {turnLabel(turn.turn_index)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[9px] text-[#8b8d98]">{identityName(turn)}</span>
                    {latest && (
                      <span className="rounded-[3px] border border-pop-green/30 px-1 text-[7.5px] text-pop-green">
                        最新
                      </span>
                    )}
                    <span className="text-[8.5px]" style={{ color: meta.color }} title={meta.label}>
                      {meta.glyph}
                    </span>
                    <span className="text-[8px] text-[#5f616c]">{fmtClock(turn.started_at)}</span>
                  </span>
                  <span className="mt-px flex items-center gap-1.5 text-[8.5px] text-[#63656f]">
                    <span className="text-[#8b8d98]">{formatDuration(durationOf(turn, now))}</span>
                    <span>{formatTokenCount(usageTotal(turn.usage))} tok</span>
                    <span>{fmtUsageCost(turn.usage, currency)}</span>
                    {turn.has_switch && <span className="text-pop-amber">⇄ 身份切换</span>}
                  </span>
                </button>
              )
            })}
            {listLoading && turns.length === 0 && (
              <div className="flex justify-center py-6">
                <Spinner className="size-4 text-pop-dim" />
              </div>
            )}
          </div>

          {filter === 'all' && filtered.length > 10 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mx-1.5 mb-1.5 shrink-0 rounded-[6px] border border-dashed border-[#3a3a44] px-1.5 py-1 text-center text-[8.5px] text-[#8b8d98] hover:border-pop-dim hover:text-pop-ink"
            >
              {expanded ? '收起，只看最近 10 轮' : `显示更早的 ${filtered.length - 10} 轮`}
            </button>
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <nav role="tablist" aria-label="调试页签" className="flex h-[37px] shrink-0 items-stretch gap-0 overflow-x-auto border-b border-[#26262e] px-2">
            {([
              ['overview', '概览'],
              ['prompt', 'Prompt'],
              ['identity', '身份'],
              ['sdk', 'SDK'],
              ['timeline', '时间线'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  'flex items-center gap-1 whitespace-nowrap border-b-2 px-2.5 text-[10.5px] transition-colors',
                  tab === key
                    ? 'border-pop-purple text-pop-ink'
                    : 'border-transparent text-[#7f818c] hover:text-pop-ink',
                )}
              >
                {label}
                {key === 'identity' && current?.has_switch && (
                  <span className="rounded-full bg-pop-purple-soft px-1 text-[8.5px] text-pop-purple">!</span>
                )}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-6 pt-3">
            {detailLoading && !detail && (
              <div className="flex items-center justify-center gap-2 py-12 text-[10px] text-pop-dim">
                <Spinner className="size-4" />
                读取本轮快照…
              </div>
            )}
            {detailError && !detailLoading && (
              <div className="rounded-[8px] border border-pop-red/25 bg-pop-red/5 px-3 py-3 text-[10px] leading-relaxed text-pop-red">
                {detailError}
                <button
                  type="button"
                  onClick={() => setRefreshNonce((n) => n + 1)}
                  className="mt-2 block text-pop-purple hover:underline"
                >
                  重试
                </button>
              </div>
            )}
            {!detailLoading && !detailError && !detail && turns.length === 0 && (
              <Empty
                title="还没有调试记录"
                detail="调试记录从本功能启用后的第一轮开始。发送一条消息，再回到这里查看实际交给 SDK 的 prompt、身份卡与参数。"
              />
            )}
            {detail && detailMeta && (
              <>
                {tab === 'overview' && (
                  <OverviewTab detail={detail} latest={isLatest} currency={currency} now={now} />
                )}
                {tab === 'prompt' && (
                  <PromptTab detail={detail} userView={userView} setUserView={setUserView} />
                )}
                {tab === 'identity' && (
                  <IdentityTab detail={detail} turns={newest} onOpenTurn={(turnIndex) => selectTurn(turnIndex, 'identity')} />
                )}
                {tab === 'sdk' && <SdkTab detail={detail} />}
                {tab === 'timeline' && <TimelineTab detail={detail} />}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────────

function OverviewTab({
  detail,
  latest,
  currency,
  now,
}: {
  detail: TurnDebugDetail
  latest: boolean
  currency: ReturnType<typeof useBillingCurrency>
  now: number
}) {
  const meta = statusMeta(detail.status)
  const usage = detail.usage
  const total = usageTotal(usage)
  const fresh = usage?.inputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheCreationTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const segments = [
    ['新增输入', fresh, 'var(--pop-cyan)'],
    ['缓存读', cacheRead, 'var(--pop-green)'],
    ['缓存写', cacheWrite, 'var(--pop-purple)'],
    ['输出', output, 'var(--pop-pink)'],
  ] as const
  const pct = (n: number) => `${Math.max(total > 0 && n > 0 ? 0.6 : 0, total > 0 ? (n / total) * 100 : 0)}%`
  const ctx = detail.context_usage
  const ctxPct = ctx?.percentage ?? (ctx?.maxTokens ? ((ctx.totalTokens ?? 0) / ctx.maxTokens) * 100 : null)
  const duration = durationOf(detail, now)
  const stop = detail.status === 'interrupted'
    ? 'interrupted（用户按停止）'
    : detail.status === 'error'
      ? 'error（错误收尾，账本仍保留用量）'
      : detail.ledger_calls[0]?.stop_reason ?? 'end_turn'
  const initEvent = detail.events.find((e) => e.type === 'init')
  const summary = detail.has_switch
    ? `身份切换在本轮送达；岗位包随 user turn 注入，system prompt 未重建。`
    : detail.status === 'interrupted'
      ? '用户中止了本轮；已完成的模型调用用量仍进入账本。'
      : detail.status === 'error'
        ? detail.error ?? '本轮以 error 收尾。'
        : `第 ${detail.turn_index} 轮正常结束；身份与 system prompt 均沿用上一轮。`

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] text-pop-purple">{detail.identity.kind === 'clone' ? '◈' : '✳'}</span>
        <span className="text-[13px] font-bold">{detail.identity.name}</span>
        <Tag tone={meta.tag}>{meta.label}</Tag>
        {detail.has_switch && <Tag tone="purple">⇄ 本轮切换身份</Tag>}
        <Tag>{new Date(detail.started_at).toLocaleString('zh-CN', { hour12: false })}</Tag>
        {latest && <Tag tone="green">最新一轮</Tag>}
      </div>

      <div className="mb-2.5 rounded-[6px] border border-[#26262e] bg-[#18181d] px-2.5 py-1.5 text-[10px] leading-relaxed text-[#9a9ca6]">
        {summary}
      </div>

      <div className="mb-2.5 grid grid-cols-4 gap-1.5">
        <Stat label="耗时" value={formatDuration(duration)} sub={`首 token ${formatDuration(detail.ttft_ms)}`} tone="pink" />
        <Stat label="本轮用量" value={formatTokenCount(total)} sub={`入 ${fmtExact(fresh + cacheRead + cacheWrite)} · 出 ${fmtExact(output)}`} tone="green" />
        <Stat label="账本成本" value={fmtUsageCost(usage, currency)} sub="含缓存读/写" tone="amber" />
        <Stat
          label="上下文"
          value={ctxPct == null ? '—' : `${ctxPct.toFixed(1)}%`}
          sub={ctx ? `${fmtExact(ctx.totalTokens)} / ${fmtExact(ctx.maxTokens)}` : 'SDK 未上报'}
          tone="cyan"
        />
      </div>

      <div className="mb-2.5 overflow-hidden rounded-[8px] border border-[#2a2a32]">
        <KV k="模型 / effort" v={<><code className="text-pop-cyan">{detail.model ?? '—'}</code> · effort {detail.effort ?? '—'}</>} />
        <KV k="停止原因" v={stop} />
        <KV k="首 token" v={<>{formatDuration(detail.ttft_ms)} <span className="text-[#63656f]">（SDK 启动 {formatDuration(initEvent?.off ?? null)}）</span></>} />
        <KV k="provider resume" v={<code className="text-pop-cyan">{String(detail.sdk_options.resume ?? '—')}</code>} />
        <KV
          k="system prompt"
          v={<><code className="text-pop-cyan">{detail.system_prompt_hash ?? '—'}</code> · {detail.system_prompt_frozen ? '与冻结快照一致' : '快照已重建或缺失'}</>}
        />
        <KV
          k="身份 revision"
          v={detail.identity.kind === 'base' ? '—（基础身份）' : `role_revision ${detail.identity.revision} · ${detail.has_switch ? '本轮送达' : '已送达'}`}
        />
      </div>

      <Section title="TOKEN 拆分" link={<span className="text-pop-purple">{fmtExact(total)} tok</span>} />
      <div className="flex h-[10px] overflow-hidden rounded-full bg-[#26262e]">
        {segments.map(([name, value, color]) => (
          value > 0 ? (
            <i key={name} title={`${name} ${fmtExact(value)}`} style={{ width: pct(value), backgroundColor: color }} className="block h-full" />
          ) : null
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[8.5px] text-[#6f7280]">
        {segments.map(([name, value, color]) => (
          <span key={name} className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-[2px]" style={{ backgroundColor: color }} />
            {name} {fmtExact(value)}
          </span>
        ))}
      </div>

      <Section title="上下文占用" link={<span className="text-pop-purple">{ctxPct == null ? '—' : `${ctxPct.toFixed(1)}%`}</span>} />
      <div className="h-1.5 overflow-hidden rounded-full bg-[#26262e]">
        <i
          className="block h-full bg-pop-cyan"
          style={{ width: `${Math.min(100, Math.max(0, ctxPct ?? 0))}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[8.5px] text-[#6f7280]">
        <span>0</span>
        <span>{ctx ? `${fmtExact(ctx.totalTokens)} / ${fmtExact(ctx.maxTokens)}` : '未上报'}</span>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {detail.has_switch && <Tag tone="purple">⇄ 身份切换</Tag>}
        {detail.status === 'interrupted' && <Tag tone="amber">已中止</Tag>}
        {detail.status === 'error' && <Tag tone="red">错误轮</Tag>}
        {latest && <Tag tone="green">最新</Tag>}
        <Tag>{detail.model ?? '模型未知'}</Tag>
        <Tag>{detail.identity.name}</Tag>
      </div>

      <Callout>
        <b className="text-pop-purple">看哪：</b>
        {detail.has_switch
          ? '身份切换没有抬高 system prompt，成本增量主要来自岗位包与工具往返。'
          : '成本主要来自上下文重放与工具往返；缓存读占比越高，说明前缀复用越好。'}
      </Callout>

      {detail.status === 'error' && (
        <Callout tone="amber">
          <b className="text-pop-amber">错误轮：</b>
          result 以 error 收尾，但已完成模型调用的 token / 成本仍要进账本；调试页不能只显示「失败」。
        </Callout>
      )}
    </>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'pink' | 'green' | 'amber' | 'cyan' }) {
  const color =
    tone === 'pink' ? 'text-pop-pink' : tone === 'green' ? 'text-pop-green' : tone === 'amber' ? 'text-pop-amber' : 'text-pop-cyan'
  return (
    <div className="min-w-0 rounded-[8px] border border-[#2a2a32] bg-[#18181d] px-2 py-1.5">
      <div className="text-[8.5px] font-bold tracking-[0.07em] text-[#6f7280]">{label}</div>
      <div className={cn('mt-0.5 truncate text-[15px] font-bold leading-tight', color)}>{value}</div>
      <div className="mt-0.5 truncate text-[8.5px] text-[#6f7280]">{sub}</div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 border-b border-[#26262e] px-2 py-1.5 text-[10px] last:border-b-0">
      <span className="w-[112px] shrink-0 text-[#6f7280]">{k}</span>
      <span className="min-w-0 flex-1 break-all text-[#c7c8cf]">{v}</span>
    </div>
  )
}

// ── Prompt ────────────────────────────────────────────────────────

function PromptTab({
  detail,
  userView,
  setUserView,
}: {
  detail: TurnDebugDetail
  userView: UserView
  setUserView: (v: UserView) => void
}) {
  const sent = userView === 'sent'
  const raw = detail.user_message ?? ''
  const catTotal = (detail.context_usage?.categories ?? [])
    .filter((c) => c.name !== 'Free space')
    .reduce((n, c) => n + c.tokens, 0)
  const same = raw && detail.provider_message === raw
  const prompt = detail.system_prompt ?? ''
  const appendTokens = Math.max(0, Math.ceil(prompt.length / 4))

  return (
    <>
      <Section
        title="用户消息"
        link={
          <span className="flex overflow-hidden rounded-[5px] border border-[#30303a] bg-[#020202]">
            <SegButton on={!sent} onClick={() => setUserView('raw')}>原始</SegButton>
            <SegButton on={sent} onClick={() => setUserView('sent')}>实际发送</SegButton>
          </span>
        }
      />
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border border-[#26262e] bg-pop-inset px-2.5 py-2 text-[9.5px] leading-relaxed text-[#c7c8cf]">
        {sent ? detail.provider_message ?? '（未保存实际发送消息）' : raw || '（本轮没有持久化用户消息）'}
      </pre>
      <p className="mt-1.5 text-[9.5px] leading-relaxed text-[#6f7280]">
        {sent ? (
          same
            ? <>本轮没有追加 transient reminder，实际发送与原始消息一致。</>
            : <><b className="text-[#a9abb5]">实际发送</b> = 原始消息 + 本轮 transient reminder（角色卡 / 委派提醒 / 任务上下文）。角色卡只进这一轮，不写库、不进 system prompt。</>
        ) : (
          <>库里只存原始消息；切到「实际发送」才能看到模型真正收到的 user turn。</>
        )}
        {' '}调试快照会在本地对 API key / token 等敏感值打码。
      </p>

      <div className="mt-3.5">
        <Section title="SYSTEM PROMPT" link={<span className="text-pop-purple">append ≈ {fmtExact(appendTokens)} tok</span>} />
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-[7px] border border-dashed border-pop-purple/30 bg-pop-purple/[0.045] px-2 py-1.5 text-[9px] text-[#a9abb5]">
        <span>append 快照</span>
        <b className="text-pop-purple"><code className="text-pop-cyan">{detail.system_prompt_hash ?? '—'}</code></b>
        <span className="ml-auto text-[8.5px] text-pop-green">
          {detail.system_prompt_frozen ? '✓ 与当前冻结快照一致' : '! 快照已重建或缺失'}
        </span>
      </div>

      <details className="overflow-hidden rounded-[8px] border border-[#2a2a32] bg-[#18181d]">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[9.5px] text-[#9a9ca6] hover:text-pop-ink [&::-webkit-details-marker]:hidden">
          <span className="text-[9px] text-[#63656f]">▸</span>
          展开 system prompt append 全文
          <span className="ml-auto text-[8.5px] text-[#63656f]">{fmtExact(prompt.length)} 字符</span>
        </summary>
        <div className="px-2 pb-2">
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-pop-inset px-2 py-1.5 text-[9px] leading-relaxed text-[#9fa1ab]">
            {prompt || '（本轮没有 system prompt append）'}
          </pre>
        </div>
      </details>

      <Callout tone="amber">
        <b className="text-pop-amber">两层不要混淆：</b>
        这里是我们拼的 <code className="text-pop-green">append</code>；SDK 还会套上{' '}
        <code className="text-pop-green">{'{ type: \'preset\', preset: \'claude_code\' }'}</code>，preset
        全文不对外返回。下面「SDK 运行时报告」才是模型实际看到的合计。
      </Callout>

      <div className="mt-3.5">
        <Section
          title="SDK 运行时报告"
          link={<span className="text-pop-purple">已占用 {fmtExact(catTotal)} tok</span>}
        />
      </div>
      {detail.context_usage?.categories && detail.context_usage.categories.length > 0 ? (
        <details className="overflow-hidden rounded-[8px] border border-[#2a2a32] bg-[#18181d]" open>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[9.5px] text-[#9a9ca6] [&::-webkit-details-marker]:hidden">
            <span className="text-[9px] text-[#63656f]">▸</span>
            getContextUsage() 分段 · {turnLabel(detail.turn_index)} · {fmtClock(detail.started_at)}
          </summary>
          <div className="px-2 pb-2">
            <table className="w-full border-collapse text-[9.5px]">
              <tbody>
                {detail.context_usage.categories.map((row) => (
                  <tr key={row.name} className="border-b border-[#232329] last:border-b-0">
                    <td className="py-1 pr-1">
                      <span className="mr-1.5 inline-block size-[7px] rounded-[2px]" style={{ backgroundColor: row.color }} />
                      {row.name}
                    </td>
                    <td className="py-1 text-right tabular-nums text-[#a9abb5]">{fmtExact(row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-[#26262e]">
              {detail.context_usage.categories
                .filter((row) => row.name !== 'Free space' && row.name !== 'Messages')
                .map((row) => (
                  <i
                    key={row.name}
                    title={`${row.name} ${fmtExact(row.tokens)}`}
                    style={{
                      width: `${Math.max(0, (row.tokens / (detail.context_usage?.maxTokens || 200_000)) * 100)}%`,
                      backgroundColor: row.color,
                    }}
                  />
                ))}
            </div>
            <p className="mt-1.5 text-[9px] leading-relaxed text-[#6f7280]">
              我们拼的 append ≈ {fmtExact(appendTokens)} tok ≠ SDK 报的 System prompt：
              差值来自 preset 包装、记忆文件重排与 SDK 自己的分段口径。
            </p>
          </div>
        </details>
      ) : (
        <p className="text-[9.5px] text-[#6f7280]">本轮没有 SDK context_usage 上报（旧轮或 provider 未返回）。</p>
      )}

      {detail.context_usage?.systemPromptSections && detail.context_usage.systemPromptSections.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[9px] text-[#6f7280]">SYSTEM PROMPT SECTIONS（SDK 口径）</div>
          <div className="overflow-hidden rounded-[8px] border border-[#2a2a32]">
            {detail.context_usage.systemPromptSections.map((row) => (
              <div key={row.name} className="flex items-center justify-between border-b border-[#26262e] px-2 py-1 text-[9.5px] last:border-b-0">
                <span className="text-[#c7c8cf]">{row.name}</span>
                <span className="tabular-nums text-[#8b8d98]">{fmtExact(row.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ── Identity ──────────────────────────────────────────────────────

function IdentityTab({
  detail,
  turns,
  onOpenTurn,
}: {
  detail: TurnDebugDetail
  turns: TurnDebugSummary[]
  onOpenTurn: (turnIndex: number) => void
}) {
  const previousSwitch = turns.find((t) => t.has_switch && t.turn_index < detail.turn_index)
  const prev = detail.previous
  const prevIdentity = prev?.identity ?? null

  if (!detail.has_switch) {
    return (
      <>
        <Empty
          title="本轮没有身份切换"
          detail={`当前身份：${detail.identity.name}${detail.identity.kind === 'base' ? ' · 基础身份' : ` · role_revision ${detail.identity.revision}`}`}
        />
        {detail.identity.kind !== 'base' ? (
          <>
            {previousSwitch && (
              <Callout>
                <b className="text-pop-purple">最近一次切换：</b>
                {turnLabel(previousSwitch.turn_index)} · {fmtClock(previousSwitch.started_at)}（
                {prevIdentity?.name ?? detail.identity.name}）。岗位包只在那轮注入过一次，本轮继续沿用，不重复发送。
                <button
                  type="button"
                  onClick={() => onOpenTurn(previousSwitch.turn_index)}
                  className="ml-1 text-pop-purple hover:underline"
                >
                  回到 {turnLabel(previousSwitch.turn_index)} 查看 diff
                </button>
              </Callout>
            )}
            <div className="mt-3">
              <Section title="当前身份包" />
            </div>
            <div className="overflow-hidden rounded-[8px] border border-[#2a2a32]">
              <KV k="clone" v={<><code className="text-pop-cyan">{detail.identity.id ?? '—'}</code> · {detail.identity.name}</>} />
              <KV k="SKILL" v={detail.identity.skills?.join(' · ') || '全部全局技能'} />
              <KV k="memory" v={detail.identity.memoryScope === 'shared' ? 'shared（跨会话共享）' : detail.identity.memoryScope === 'isolated' ? 'isolated（本分身独立）' : '—'} />
              <KV k="岗位包" v={previousSwitch ? `已送达（${turnLabel(previousSwitch.turn_index)}）· 本轮不重发` : '未见送达记录'} />
            </div>
          </>
        ) : (
          <Callout>
            <b className="text-pop-purple">基础身份：</b>
            没有挂分身；system prompt 只含主 Agent 的 persona / memory / skills。
          </Callout>
        )}
      </>
    )
  }

  const before = prevIdentity?.name ?? '（无上一轮记录）'
  const beforeOpts = prev?.sdk_options ?? {}
  const afterOpts = detail.sdk_options
  const beforeAgents = listValue(beforeOpts.agents)
  const afterAgents = listValue(afterOpts.agents)
  const beforeMcp = listValue(beforeOpts.mcpServers)
  const afterMcp = listValue(afterOpts.mcpServers)
  const beforePlugins = pluginPaths(beforeOpts.plugins)
  const afterPlugins = pluginPaths(afterOpts.plugins)
  const cards = detail.role_card ?? ''
  const cardTokens = Math.ceil(cards.length / 4)
  const promptUnchanged = prev?.system_prompt_hash && detail.system_prompt_hash
    ? prev.system_prompt_hash === detail.system_prompt_hash
    : null

  const rows: Array<{ key: string; before: string; after: string; changed: boolean }> = [
    { key: '身份', before, after: detail.identity.name, changed: before !== detail.identity.name },
    { key: 'clone / 来源', before: prevIdentity?.id ?? '—', after: detail.identity.id ?? '—', changed: (prevIdentity?.id ?? '—') !== (detail.identity.id ?? '—') },
    { key: 'role_revision', before: String(prevIdentity?.revision ?? '—'), after: String(detail.identity.revision), changed: (prevIdentity?.revision ?? -1) !== detail.identity.revision },
    { key: '工作目录', before: prev?.cwd ?? '—', after: detail.cwd ?? '—', changed: (prev?.cwd ?? '—') !== (detail.cwd ?? '—') },
    { key: 'AGENTS', before: beforeAgents.join(' · ') || '—', after: afterAgents.join(' · ') || '—', changed: beforeAgents.join('·') !== afterAgents.join('·') },
    { key: 'MCP', before: beforeMcp.join(' · ') || '—', after: afterMcp.join(' · ') || '—', changed: beforeMcp.join('·') !== afterMcp.join('·') },
    { key: '插件', before: beforePlugins.join(' · ') || '—', after: afterPlugins.join(' · ') || '—', changed: beforePlugins.join('·') !== afterPlugins.join('·') },
    {
      key: 'system prompt',
      before: prev?.system_prompt_hash?.slice(0, 12) ?? '—',
      after: detail.system_prompt_hash?.slice(0, 12) ?? '—',
      changed: promptUnchanged === false,
    },
  ]

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-[8px] border border-pop-purple/35 bg-gradient-to-r from-pop-purple/[0.09] to-pop-purple/[0.02] px-2.5 py-2">
        <span className="text-[#9a9ca6]">{before}</span>
        <span className="font-bold text-pop-purple">→</span>
        <span className="font-bold text-pop-purple">{detail.identity.name}</span>
        <span className="text-[9.5px] text-[#7f818c]">
          clone <code className="text-pop-cyan">{detail.identity.id ?? '—'}</code>
        </span>
        <span className="ml-auto rounded-[4px] border border-[#34343e] px-1.5 text-[8.5px] text-[#8b8d98]">
          role_revision {detail.identity.revision}
        </span>
      </div>

      <div className="mb-2.5 flex flex-wrap gap-1">
        <Tag tone="purple">自本轮起生效 · {fmtClock(detail.started_at)}</Tag>
        <Tag>岗位包 ≈ {fmtExact(cardTokens)} tok</Tag>
        <Tag tone="amber">只送达一次</Tag>
      </div>

      <table className="mb-2.5 w-full border-collapse text-[9.5px]">
        <thead>
          <tr>
            <th className="border-b border-[#2a2a32] px-1.5 py-1 text-left text-[8.5px] tracking-[0.06em] text-[#6f7280]">维度</th>
            <th className="border-b border-[#2a2a32] px-1.5 py-1 text-left text-[8.5px] tracking-[0.06em] text-[#6f7280]">切换前（{before}）</th>
            <th className="border-b border-[#2a2a32] px-1.5 py-1 text-left text-[8.5px] tracking-[0.06em] text-[#6f7280]">切换后（{detail.identity.name}）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-[#232329] last:border-b-0">
              <td className="px-1.5 py-1 align-top text-[#6f7280]">{row.key}</td>
              <td className="px-1.5 py-1 align-top text-[#8b8d98]">{row.before}</td>
              <td className={cn('px-1.5 py-1 align-top', row.changed ? 'text-pop-green' : 'text-[#6f7280]')}>{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Callout>
        <b className="text-pop-purple">为什么 system prompt 没变：</b>
        provider 按前缀缓存；system prompt 一旦重建，整个 transcript 缓存失效。所以身份切换不重拼
        prompt，而是把完整岗位包作为<strong className="text-pop-ink">本轮 user 消息的 transient reminder</strong>
        送达，并在 result 后把 revision 标记为 delivered。
      </Callout>

      <div className="mt-3">
        <Section title="本轮送达的岗位包" link={<span className="text-pop-purple">≈ {fmtExact(cardTokens)} tok · 折叠</span>} />
      </div>
      <details className="overflow-hidden rounded-[8px] border border-[#2a2a32] bg-[#18181d]">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[9.5px] text-[#9a9ca6] hover:text-pop-ink [&::-webkit-details-marker]:hidden">
          <span className="text-[9px] text-[#63656f]">▸</span>
          展开岗位包全文（与 provider message 中一致）
        </summary>
        <div className="px-2 pb-2">
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-pop-inset px-2 py-1.5 text-[9px] leading-relaxed text-[#9fa1ab]">
            {cards || '（本轮 role_card 为空）'}
          </pre>
        </div>
      </details>

      <p className="mt-1.5 text-[9.5px] leading-relaxed text-[#6f7280]">
        下一轮起：身份保持，岗位包不再重复注入。若用户再切到第三个分身，revision +1，并重新送达一次新的岗位包。
      </p>
    </>
  )
}

// ── SDK ───────────────────────────────────────────────────────────

function SdkTab({ detail }: { detail: TurnDebugDetail }) {
  const opts = detail.sdk_options ?? {}
  const init = detail.system_init
  const known = new Set([
    'systemPrompt', 'model', 'effort', 'resume', 'cwd', 'agents', 'mcpServers',
    'plugins', 'interruptible', 'settingSources', 'allowDangerouslySkipPermissions',
    'transientReminder', 'ephemeral',
  ])
  const extraKeys = Object.keys(opts).filter((k) => !known.has(k))
  const systemPrompt = opts.systemPrompt as { preset?: string; appendChars?: number } | undefined

  const optionRows: Array<[string, React.ReactNode]> = [
    ['systemPrompt', systemPrompt
      ? <span><code className="text-pop-cyan">{systemPrompt.preset ?? 'preset'}</code> · append {fmtExact(systemPrompt.appendChars ?? 0)} 字符</span>
      : '—'],
    ['model', <code className="text-pop-cyan">{String(opts.model ?? '—')}</code>],
    ['effort', String(opts.effort ?? '—')],
    ['resume', <code className="text-pop-cyan">{String(opts.resume ?? '—')}</code>],
    ['cwd', <span className="break-all">{String(opts.cwd ?? '—')}</span>],
    ['agents', `${listValue(opts.agents).length} 个${listValue(opts.agents).length ? `：${listValue(opts.agents).join(' · ')}` : ''}`],
    ['mcpServers', listValue(opts.mcpServers).join(' · ') || '—'],
    ['plugins', `${listValue(opts.plugins).length} 个`],
    ['interruptible', opts.interruptible ? 'true（流式输入 + interrupt()）' : 'false'],
    ['settingSources', listValue(opts.settingSources).join(' · ') || '—'],
    ['transientReminder', opts.transientReminder ? 'true（本轮 user 消息带 reminder）' : 'false'],
  ]
  if (extraKeys.length > 0) {
    optionRows.push(['其他', extraKeys.map((k) => `${k}=${JSON.stringify(opts[k])}`).join(' · ')])
  }

  return (
    <>
      <Section title="sendQuery options" link={<span className="text-pop-purple">{turnLabel(detail.turn_index)} 快照</span>} />
      <div className="mb-2 overflow-hidden rounded-[8px] border border-[#2a2a32]">
        {optionRows.map(([key, value]) => (
          <div key={key} className="flex gap-2 border-b border-[#232329] px-2 py-1 text-[9.5px] last:border-b-0">
            <span className="w-[118px] shrink-0 text-pop-cyan">{key}</span>
            <span className="min-w-0 flex-1 break-all text-[#c7c8cf]">{value}</span>
          </div>
        ))}
      </div>

      <details className="mb-2.5 overflow-hidden rounded-[8px] border border-[#2a2a32] bg-[#18181d]">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[9.5px] text-[#9a9ca6] hover:text-pop-ink [&::-webkit-details-marker]:hidden">
          <span className="text-[9px] text-[#63656f]">▸</span>
          raw JSON（实际调用参数）
        </summary>
        <div className="px-2 pb-2">
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-pop-inset px-2 py-1.5 text-[9px] leading-relaxed text-[#9fa1ab]">
            {JSON.stringify(opts, null, 2)}
          </pre>
        </div>
      </details>

      <Section
        title="装载面"
        link={<span className="text-pop-purple">{init ? `${init.tools.length} tools · ${init.mcpServers.length} MCP` : 'init 未上报'}</span>}
      />
      {init ? (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            <Tag>{init.claudeCodeVersion ?? 'CLI ?'}</Tag>
            <Tag>{init.model ?? 'model ?'}</Tag>
            <Tag>{init.permissionMode ?? 'permission ?'}</Tag>
            {init.outputStyle && <Tag>{init.outputStyle}</Tag>}
            {init.effort && <Tag>effort {init.effort}</Tag>}
            {init.apiKeySource && <Tag>key {init.apiKeySource}</Tag>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[9px] text-[#6f7280]">SYSTEM TOOLS · {init.tools.length}</div>
              <div className="flex flex-wrap gap-1">
                {init.tools.slice(0, 30).map((tool) => <Tag key={tool}>{tool}</Tag>)}
                {init.tools.length > 30 && <Tag>+{init.tools.length - 30}</Tag>}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[9px] text-[#6f7280]">MCP SERVERS · {init.mcpServers.length}</div>
              <div className="flex flex-wrap gap-1">
                {init.mcpServers.map((server) => (
                  <Tag key={server.name} tone={server.status === 'connected' ? 'green' : 'amber'}>
                    {server.name} · {server.status}
                  </Tag>
                ))}
                {init.mcpServers.length === 0 && <span className="text-[9px] text-[#6f7280]">无</span>}
              </div>
            </div>
            <div>
              <div className="mb-1 mt-2 text-[9px] text-[#6f7280]">AGENTS · {init.agents.length}</div>
              <div className="flex flex-wrap gap-1">
                {init.agents.map((agent) => <Tag key={agent}>{agent}</Tag>)}
                {init.agents.length === 0 && <span className="text-[9px] text-[#6f7280]">无</span>}
              </div>
            </div>
            <div>
              <div className="mb-1 mt-2 text-[9px] text-[#6f7280]">SKILLS · {init.skills.length}</div>
              <div className="flex flex-wrap gap-1">
                {init.skills.slice(0, 24).map((skill) => <Tag key={skill} tone="purple">{skill}</Tag>)}
                {init.skills.length > 24 && <Tag>+{init.skills.length - 24}</Tag>}
                {init.skills.length === 0 && <span className="text-[9px] text-[#6f7280]">无</span>}
              </div>
            </div>
          </div>

          <div className="mt-2.5">
            <div className="mb-1 text-[9px] text-[#6f7280]">SLASH COMMANDS · {init.slashCommands.length}</div>
            <div className="flex flex-wrap gap-1">
              {init.slashCommands.slice(0, 24).map((cmd) => <Tag key={cmd}>/{cmd}</Tag>)}
              {init.slashCommands.length > 24 && <Tag>+{init.slashCommands.length - 24}</Tag>}
              {init.slashCommands.length === 0 && <span className="text-[9px] text-[#6f7280]">无</span>}
            </div>
          </div>

          {init.plugins.length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[9px] text-[#6f7280]">PLUGINS · {init.plugins.length}</div>
              <div className="flex flex-wrap gap-1">
                {init.plugins.map((plugin) => (
                  <Tag key={plugin.name} title={plugin.path}>{plugin.name}{plugin.version ? ` ${plugin.version}` : ''}</Tag>
                ))}
              </div>
            </div>
          )}

          {init.capabilities && init.capabilities.length > 0 && (
            <div className="mt-2.5">
              <div className="mb-1 text-[9px] text-[#6f7280]">CAPABILITIES</div>
              <div className="flex flex-wrap gap-1">
                {init.capabilities.map((cap) => <Tag key={cap}>{cap}</Tag>)}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-[9.5px] leading-relaxed text-[#6f7280]">
          本轮没有收到 SDK <code className="text-pop-green">system:init</code>（旧轮或 provider 未上报）。
          新版记录会把 tools / MCP 状态 / skills / plugins 一并留下。
        </p>
      )}

      <Callout tone="amber">
        <b className="text-pop-amber">SDK init 是主缺口：</b>
        provider 此前只消费 <code className="text-pop-green">system:init</code> 的{' '}
        <code className="text-pop-green">slash_commands</code>；现在整包留下（脱敏后按轮存），
        工具清单、MCP 连接状态、permissionMode 与 skills 才终于可见。
      </Callout>
    </>
  )
}

// ── Timeline ──────────────────────────────────────────────────────

const EVENT_COLOR: Record<TurnDebugEvent['type'], string> = {
  init: 'var(--pop-cyan)',
  llm: 'var(--pop-pink)',
  tool: 'var(--pop-amber)',
  res: 'var(--pop-green)',
  err: 'var(--pop-red)',
  sys: 'var(--pop-dim)',
}

function TimelineTab({ detail }: { detail: TurnDebugDetail }) {
  const meta = statusMeta(detail.status)
  const initEvent = detail.events.find((e) => e.type === 'init' && e.label === 'SDK init')
  const initPct = detail.ttft_ms && initEvent ? Math.round((initEvent.off / detail.ttft_ms) * 100) : null

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[9.5px] text-[#8b8d98]">
        <span>首响应 <b className="text-pop-ink">{formatDuration(detail.ttft_ms)}</b></span>
        <span>·</span>
        <span>总 <b className="text-pop-ink">{formatDuration(detail.duration_ms)}</b></span>
        <span>·</span>
        <span>{detail.events.length} 事件</span>
        <span className="ml-auto" style={{ color: meta.color }}>{detail.status}</span>
      </div>

      <div className="relative ml-[7px] border-l border-[#2e2e38] pl-3.5">
        {detail.events.map((event, index) => (
          <div key={`${event.off}-${index}`} className="relative py-1">
            <span
              className="absolute -left-[19px] top-2 size-[7px] rounded-full border"
              style={{ backgroundColor: EVENT_COLOR[event.type] ?? 'var(--pop-dim)', borderColor: EVENT_COLOR[event.type] ?? 'var(--pop-dim)' }}
            />
            <div className="flex items-baseline gap-2 text-[9.5px]">
              <span className="w-[50px] shrink-0 text-right tabular-nums text-[#63656f]">{fmtOffset(event.off)}</span>
              <span className="font-bold text-[#d3d4da]">{event.label}</span>
              {event.det && <span className="ml-auto text-right text-[9px] text-[#7f818c]">{event.det}</span>}
            </div>
            {event.sub && (
              <div className="ml-[57px] whitespace-pre-wrap break-words text-[8.5px] text-[#63656f]">{event.sub}</div>
            )}
          </div>
        ))}
        {detail.events.length === 0 && (
          <p className="py-4 text-[9.5px] text-[#6f7280]">本轮没有记录到时间线事件。</p>
        )}
      </div>

      {initEvent && detail.ttft_ms != null && (
        <Callout>
          <b className="text-pop-purple">首 token {formatDuration(detail.ttft_ms)} 里，SDK 启动占 {formatDuration(initEvent.off)}（{initPct ?? 0}%）。</b>
          这部分是子进程 boot + settings/plugins/skills 装载 + resume transcript，不是模型推理；
          把它单独标出来，才知道该优化哪一段。
        </Callout>
      )}
      {detail.status === 'interrupted' && (
        <Callout tone="amber">
          <b className="text-pop-amber">中止轮也记账：</b>
          interrupt() 后 SDK 仍产出一条带 usage 的 error result；本页把它和正常 end_turn
          分开标色，但 token / 成本照常进账本。
        </Callout>
      )}
      {detail.status === 'error' && (
        <Callout tone="amber">
          <b className="text-pop-amber">错误轮也记账：</b>
          error result 里可能已经包含若干次完成的模型调用；调试页把「调用失败」与「没有产生用量」分开，
          避免账本被误读。
        </Callout>
      )}
    </>
  )
}