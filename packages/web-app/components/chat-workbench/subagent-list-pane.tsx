'use client'

// 作业坞「子代理」面板（2026-11-04）：主 Agent 通过 Agent 工具派生的子代理。
// 运行中置顶，已完成/失败留档；点一条打开详情窗（prompt + 操作日志 + token）。
// 数据源：GET /api/agent/sessions/:id/subagents（运行中轮询）。

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Users,
} from 'lucide-react'
import type { SubagentRunSummary } from '@/lib/agent/api'
import { formatStopwatch, formatTokenCount } from '@/lib/format'
import {
  isSubagentLive,
  subagentElapsedMs,
  subagentStatusLabel,
  subagentTitle,
  subagentTokenTotal,
} from '@/lib/subagent-format'
import { cn } from '@/lib/utils'

const FAILED_STATUS = new Set(['failed', 'killed'])

export function SubagentListPane({
  sessionId,
  runs,
  activeAgentId,
  onPick,
}: {
  sessionId: string | null
  runs: SubagentRunSummary[]
  activeAgentId?: string | null
  onPick: (run: SubagentRunSummary) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const liveCount = useMemo(() => runs.filter(isSubagentLive).length, [runs])

  // 只有运行中才有「一直在走」的读数；终态耗时是定值。
  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [liveCount])

  const { live, done } = useMemo(() => {
    const live: SubagentRunSummary[] = []
    const done: SubagentRunSummary[] = []
    for (const run of runs) (isSubagentLive(run) ? live : done).push(run)
    return { live, done }
  }, [runs])

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] leading-5 text-pop-dim">
        还没有会话。
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] leading-5 text-pop-dim">
        <CircleDashed className="size-5 opacity-50" />
        <span>本会话还没有子代理。</span>
        <span className="text-[10px] text-pop-dim/60">
          主 Agent 在对话里派出子代理后，这里会列出它们的运行状态与操作日志。
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]" data-testid="subagent-list-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <Users className="size-3.5 text-pop-purple" />
        <span className="text-[10px] font-bold tracking-tight text-pop-ink">子代理</span>
        <span className="text-[9.5px] text-pop-dim">本会话</span>
        <span className="ml-auto rounded-full border border-pop-bd/70 px-1.5 py-[1px] text-[9px] tabular-nums text-pop-dim">
          {runs.length} 个
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-pop-dim">
        {live.length > 0 ? (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-pop-purple" />
            {live.length} 个运行中
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-pop-dim/50" />
            没有运行中的子代理
          </>
        )}
        <span className="text-pop-dim/50">·</span>
        <span>{done.length} 个已结束</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {live.length > 0 && (
          <Section label="运行中" count={live.length}>
            {live.map((run) => (
              <SubagentRow
                key={run.id}
                run={run}
                active={run.id === activeAgentId}
                now={now}
                onPick={onPick}
              />
            ))}
          </Section>
        )}
        {done.length > 0 && (
          <Section label="已结束" count={done.length}>
            {done.map((run) => (
              <SubagentRow
                key={run.id}
                run={run}
                active={run.id === activeAgentId}
                now={now}
                onPick={onPick}
              />
            ))}
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.05] px-3 py-1.5 text-[9px] leading-4 text-pop-dim/70">
        点一条查看指令 prompt、操作日志与 token。
      </div>
    </div>
  )
}

function Section({ label, count, children }: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[9.5px] text-pop-dim">
        <span>{label}</span>
        <span className="tabular-nums text-pop-dim/60">{count}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function SubagentRow({ run, active, now, onPick }: {
  run: SubagentRunSummary
  active: boolean
  now: number
  onPick: (run: SubagentRunSummary) => void
}) {
  const live = isSubagentLive(run)
  const failed = FAILED_STATUS.has(run.status)
  const elapsed = subagentElapsedMs(run, now)
  const tokens = subagentTokenTotal(run)
  const meta = [
    run.agent_type ?? 'subagent',
    run.step_count > 0 ? `${run.step_count} 步` : null,
    tokens > 0 ? `${formatTokenCount(tokens)} tok` : null,
  ].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      data-testid="subagent-row"
      data-subagent-id={run.id}
      data-subagent-status={run.status}
      onClick={() => onPick(run)}
      className={cn(
        'flex w-full items-center gap-2 rounded-[7px] border px-1.5 py-1.5 text-left transition-colors',
        active
          ? 'border-pop-purple/40 bg-pop-purple-soft/30'
          : 'border-transparent hover:border-white/[0.07] hover:bg-white/[0.04]',
      )}
    >
      <span
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md border',
          live
            ? 'border-pop-purple/35 bg-pop-purple-soft text-pop-purple'
            : failed
              ? 'border-pop-red/35 bg-pop-red-soft text-pop-red'
              : 'border-pop-bd/70 bg-black/20 text-pop-dim',
        )}
      >
        {live ? (
          <span className="size-1.5 animate-pulse rounded-full bg-pop-purple" />
        ) : failed ? (
          <AlertTriangle className="size-3" />
        ) : (
          <CheckCircle2 className="size-3" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-pop-ink">
          {subagentTitle(run)}
        </span>
        <span className="mt-[1px] block truncate text-[9px] text-pop-dim">{meta}</span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-[1px]">
        <span
          className={cn(
            'text-[9.5px] font-bold',
            live ? 'text-pop-purple' : failed ? 'text-pop-red' : 'text-pop-dim',
          )}
        >
          {subagentStatusLabel(run.status)}
        </span>
        <span className="text-[9px] tabular-nums text-pop-dim/70">
          {elapsed != null ? formatStopwatch(elapsed) : '—'}
        </span>
      </span>

      <ChevronRight className="size-3 shrink-0 text-pop-dim/50" />
    </button>
  )
}
