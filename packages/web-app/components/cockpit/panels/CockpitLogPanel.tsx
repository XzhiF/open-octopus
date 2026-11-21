'use client'

// v22 十五轮（2026-11-21 用户）· 右栏「更多 → 日志」：
// 主会话里**我发出的 prompt** 时间线（倒序）+ 每轮 TUI 摘要行。
//
// 原型 = docs/cabin-design/cockpit-v22.html（对话日志 · COMMS LOG · 指令时间线）。
// 数据：
//   · 消息 = GET /api/agent/sessions/:id（本舱 main_session_id，最近 200 条）；
//   · 每轮统计 = 会话账本 /api/sessions/:id/llm-calls → buildTurnStats 挂到
//     assistant 行，再由 log-model 聚合成一条 prompt 的摘要。
// 展示：
//   · 顶部一条紧凑统计（指令 / 总 token / 最长耗时 / 总费用）+ 关键词搜索；
//   · 每条只两行：prompt 原文 +（✦ 汐音 · 状态 · 耗时 · 步数 · 工具 · 思考 ·
//     token · 费用 · 时间）。过程明细不在日志里回放 —— 要看过程回主对话。
//
// 只读：不选中、不展开、不跳转；面板重开即重取一帧，开面板期间不能发新指令
// （有 scrim），不需要轮询。

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { getSession } from '@/lib/agent/api'
import type { AgentMessage } from '@/lib/agent/types'
import { buildTurnStats } from '@/lib/turn-stats'
import { useSessionLedger } from '@/hooks/useSessionLedger'
import { formatCost, formatDuration, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { CockpitPanelShell } from './CockpitPanelShell'
import {
  buildLogTurns,
  filterLogTurns,
  logTotals,
  type LogTurn,
  type LogTurnStatus,
} from './log-model'

const STATUS_LABEL: Record<LogTurnStatus, string> = {
  done: '已完成',
  interrupted: '已中断',
  pending: '进行中',
}

/** 消息窗口：服务端上限 200 条；按经验足够覆盖最近几十轮。 */
const MESSAGE_LIMIT = 200

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 时间线分组标签：今天 / 昨天 / MM-DD（本地时区）。 */
function dayLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (target.getTime() === today.getTime()) return '今天'
  if (target.getTime() === yesterday.getTime()) return '昨天'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 摘要行最右的时间（HH:MM）。 */
function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 命中段包 <mark>；大小写不敏感。 */
function highlighted(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let index = haystack.indexOf(target)
  while (index >= 0) {
    if (index > from) parts.push(text.slice(from, index))
    parts.push(
      <mark key={`${index}-${parts.length}`} className="ck12-log-hit">
        {text.slice(index, index + needle.length)}
      </mark>,
    )
    from = index + needle.length
    index = haystack.indexOf(target, from)
  }
  if (parts.length === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

function LogRow({ turn, query }: { turn: LogTurn; query: string }) {
  const currency = useBillingCurrency()
  return (
    <div className="ck12-log-row" data-testid={`cockpit-log-row-${turn.id}`}>
      <div className="ck12-log-p">
        <span className="ck12-log-pr" aria-hidden="true">❯</span>
        {highlighted(turn.prompt, query)}
      </div>
      <div className="ck12-log-meta">
        <span className="ck12-log-nm">✦ 汐音</span>
        <span className="ck12-log-dot">·</span>
        <span className={`ck12-log-st is-${turn.status}`}>{STATUS_LABEL[turn.status]}</span>
        {turn.durationMs > 0 && (
          <>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-dur">{formatDuration(turn.durationMs)}</span>
          </>
        )}
        {turn.steps > 0 && (
          <>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-stp">{turn.steps} 步</span>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-tl">工具 {turn.tools}</span>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-th">思考 {turn.thinks}</span>
          </>
        )}
        {turn.tokens > 0 && (
          <>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-tk">{formatTokenCount(turn.tokens)} tok</span>
          </>
        )}
        {turn.hasStats && (
          <>
            <span className="ck12-log-dot">·</span>
            <span className="ck12-log-cst">
              {formatCost(turn.costUsd, turn.costComplete, currency)}
            </span>
          </>
        )}
        <span className="ck12-log-tm">{clockOf(turn.at)}</span>
      </div>
    </div>
  )
}

export function CockpitLogPanel() {
  const sessionId = useCabinOptional()?.cabin?.main_session_id ?? null
  const { calls } = useSessionLedger(sessionId)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    // 换舱 / 换主会话：先收起上一舱的帧与搜索词，再重取。
    setMessages([])
    setError(null)
    setQuery('')
    if (!sessionId) return
    let cancelled = false
    setLoading(true)
    void getSession(sessionId, { limit: MESSAGE_LIMIT })
      .then((session) => {
        if (cancelled) return
        setMessages(session.messages.items)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        // 保留上一帧，只报原因；不让整张列表闪成空。
        setError('对话记录载入失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  // 与通讯台同一口径：账本行按消息归属后再聚类，不另算一套 token。
  const turns = useMemo(() => {
    if (messages.length === 0) return []
    const stats = buildTurnStats(messages, calls)
    const withStats = stats.size === 0
      ? messages
      : messages.map((message) => {
        const turnStats = stats.get(message.id)
        return turnStats ? { ...message, turnStats } : message
      })
    return buildLogTurns(withStats)
  }, [messages, calls])

  // 倒序：最新在前。
  const ordered = useMemo(() => [...turns].reverse(), [turns])
  const shown = useMemo(() => filterLogTurns(ordered, query), [ordered, query])
  const totals = useMemo(() => logTotals(turns), [turns])
  const hits = query.trim() ? shown.length : 0
  const currency = useBillingCurrency()

  const rows: ReactNode[] = []
  let lastDay = ''
  for (const turn of shown) {
    const day = dayLabel(turn.at)
    if (day !== lastDay) {
      rows.push(
        <div key={`day-${day}-${turn.id}`} className="ck12-log-day">
          <span>{day}</span>
          <i aria-hidden="true" />
        </div>,
      )
      lastDay = day
    }
    rows.push(<LogRow key={turn.id} turn={turn} query={query} />)
  }

  const nothingToShow = !loading && shown.length === 0
  const emptyText = query.trim()
    ? '没有匹配的指令 · 换个关键词'
    : sessionId
      ? '本会话还没有我发出的指令'
      : '该舱还没有主会话 · 没有对话日志'

  return (
    <CockpitPanelShell kind="log" title="对话日志" en="COMMS LOG · 指令时间线">
      <div className="ck12-log" data-testid="cockpit-log">
        <div className="ck12-log-search">
          <Search className="size-3.5 ck12-log-search-i" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索我的指令…（关键词）"
            aria-label="搜索我的指令"
            data-testid="cockpit-log-search"
          />
          <span className="ck12-log-count" data-testid="cockpit-log-count">
            {query.trim() ? <><b>{hits}</b> / {turns.length}</> : `${turns.length} 条`}
          </span>
          {query.trim() && (
            <button
              type="button"
              className="ck12-log-clear"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => setQuery('')}
            >
              <X className="size-2.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="ck12-log-stats" data-testid="cockpit-log-stats">
          <div className="ck12-log-stat">
            <span>指令</span>
            <b>{totals.count}<em>轮</em></b>
          </div>
          <div className="ck12-log-stat">
            <span>总 TOKEN</span>
            <b>{totals.tokens > 0 ? formatTokenCount(totals.tokens) : '—'}</b>
          </div>
          <div className="ck12-log-stat is-hot">
            <span>最长耗时</span>
            <b>{totals.longestMs > 0 ? formatDuration(totals.longestMs) : '—'}</b>
          </div>
          <div className="ck12-log-stat">
            <span>总费用</span>
            <b>{formatCost(totals.costUsd, totals.costComplete, currency)}</b>
          </div>
        </div>

        <div className="ck12-log-list" data-testid="cockpit-log-list">
          {rows}
          {nothingToShow && (
            <div className="ck12-log-empty" data-testid="cockpit-log-empty">
              <b aria-hidden="true">{query.trim() ? '⌕' : '≡'}</b>
              {emptyText}
            </div>
          )}
          {loading && messages.length === 0 && (
            <div className="ck12-log-empty" data-testid="cockpit-log-loading">读主会话记录…</div>
          )}
        </div>

        <div className="ck12-log-foot">
          <span>只列我发出的 prompt · 摘要行口径同主对话 TUI</span>
          {error && <span className="ck12-log-err" title={error}>⚠ {error} · 沿上一帧</span>}
          <span className="ck12-log-sp" />
          <span>倒序 · 最新在前</span>
        </div>
      </div>
    </CockpitPanelShell>
  )
}
