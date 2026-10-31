'use client'

// 2026-10-31 用户需求：作业坞「消耗」窗口要有总耗时。
// 两个口径（服务端 taskUsage.timing 一次算好）：
//   · 总耗时 = 全部执行轮 started_at→completed_at 实跑段之和，与看板 ⏱ 同源；
//   · 智能体 = node_type='agent' 的节点 duration 之和 —— 工时不是墙钟，并行/重试会叠加，
//     进度条按 100% 截断，「编排 / 等待」只显示剩下的那部分。
// 一轮都没跑过（count=0）时整个卡不渲染 —— 不留空壳。

import type { TaskTimingSummary, TaskUsagePart } from '@/lib/tasks-api'
import { formatDuration, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

/** 相位配色：与明细行的时间条/圆点同族，P1 青、P2 紫、P3 琥珀，之后循环。 */
const PHASE_COLORS = [
  'bg-pop-cyan',
  'bg-pop-purple',
  'bg-pop-amber',
  'bg-pop-green',
  'bg-pop-pink',
  'bg-pop-navy',
]

function phaseColor(part: TaskUsagePart): string {
  if (part.phase_index == null) return 'bg-pop-dim/50'
  const index = ((part.phase_index - 1) % PHASE_COLORS.length + PHASE_COLORS.length) % PHASE_COLORS.length
  return PHASE_COLORS[index]
}

export function UsageTimingCard({ timing, rounds }: {
  timing: TaskTimingSummary
  /** 有实跑时长的执行轮（breakdown 里 kind==='execution' 且 duration_ms>0）。 */
  rounds: TaskUsagePart[]
}) {
  const total = timing.duration_ms
  if (!(total > 0)) return null
  const agent = Math.max(0, timing.agent_duration_ms)
  const ratio = agent / total
  // 并行/重试会让工时超过墙钟：此时百分比没有意义，直接报倍数（×1.3）。
  const parallel = ratio > 1.005
  const agentWidth = Math.min(100, ratio * 100)
  const other = Math.max(0, total - agent)
  const longest = rounds.reduce<TaskUsagePart | null>(
    (best, part) => ((part.duration_ms ?? 0) > (best?.duration_ms ?? 0) ? part : best),
    null,
  )

  return (
    <section
      data-testid="usage-timing"
      className="mb-3 rounded-xl border border-pop-amber/25 bg-pop-amber-soft/45 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-amber">耗时</span>
        <span className="ml-auto font-mono text-[9.5px] text-pop-dim">
          {timing.count} 轮实跑 · 不含排队与待验收等待
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-end gap-x-2.5 gap-y-1">
        <span
          data-testid="usage-timing-total"
          className="text-[30px] font-black leading-none tracking-tight tabular-nums text-pop-ink"
        >
          {formatDuration(total)}
        </span>
        <span className="pb-[3px] text-[11px] text-pop-dim">总耗时</span>
        <div className="ml-auto text-right text-[10.5px] leading-relaxed text-pop-dim">
          <div>
            智能体{' '}
            <b className="font-black tabular-nums text-pop-cyan">{formatDuration(agent)}</b>
            <span
              data-testid="usage-timing-agent-pct"
              title={parallel ? `工时是墙钟的 ${ratio.toFixed(1)} 倍（并行/重试叠加）` : undefined}
            >
              {' · '}
              {parallel ? `×${ratio.toFixed(1)}` : formatPercent(ratio, 0)}
            </span>
          </div>
          {other > 0 && (
            <div>
              编排 / 等待 <b className="font-black tabular-nums text-pop-dim">{formatDuration(other)}</b>
            </div>
          )}
        </div>
      </div>

      <div
        data-testid="usage-timing-bar"
        className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]"
        role="img"
        aria-label={`总耗时 ${formatDuration(total)}，其中智能体 ${formatDuration(agent)}`}
      >
        <i className="block h-full bg-pop-cyan" style={{ width: `${agentWidth}%` }} />
        {agentWidth < 100 && (
          <i className="block h-full bg-pop-dim/30" style={{ width: `${100 - agentWidth}%` }} />
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] text-pop-dim">
        <span>
          <i className="mr-1.5 inline-block size-2 rounded-sm bg-pop-cyan align-middle" />
          智能体 <b className="font-black tabular-nums text-pop-ink">{formatDuration(agent)}</b>
        </span>
        {other > 0 && (
          <span>
            <i className="mr-1.5 inline-block size-2 rounded-sm bg-pop-dim/45 align-middle" />
            编排 / 等待 <b className="font-black tabular-nums text-pop-ink">{formatDuration(other)}</b>
          </span>
        )}
        <span className="ml-auto opacity-75">agent 节点时长 = 工时，并行/重试会叠加</span>
      </div>

      {rounds.length > 0 && (
        <div className="mt-2.5 border-t border-dashed border-pop-amber/20 pt-2">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
            按轮 · 时长占比
            {longest && (
              <span className="ml-auto font-sans text-[9.5px] font-bold tracking-normal">
                最长 {longest.label} {formatDuration(longest.duration_ms)} · 占{' '}
                {formatPercent((longest.duration_ms ?? 0) / total, 0)}
              </span>
            )}
          </div>
          <div
            data-testid="usage-timing-rounds"
            className="flex h-2 overflow-hidden rounded-full bg-white/[0.05]"
          >
            {rounds.map((part) => (
              <i
                key={part.execution_id ?? `${part.label}:${part.started_at}`}
                title={`${part.label} · ${formatDuration(part.duration_ms)}${part.round_index != null && part.round_index > 1 ? '（修复轮）' : ''}`}
                className={cn(
                  'block h-full',
                  phaseColor(part),
                  part.round_index != null && part.round_index > 1 && 'opacity-50',
                )}
                style={{ width: `${Math.max(0.5, ((part.duration_ms ?? 0) / total) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9.5px] text-pop-dim">
            {rounds.map((part) => (
              <span key={`legend:${part.execution_id ?? `${part.label}:${part.started_at}`}`}>
                <i
                  className={cn(
                    'mr-1 inline-block size-1.5 rounded-sm align-middle',
                    phaseColor(part),
                    part.round_index != null && part.round_index > 1 && 'opacity-50',
                  )}
                />
                {part.label}{' '}
                <b className="font-black tabular-nums text-pop-ink">{formatDuration(part.duration_ms)}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
