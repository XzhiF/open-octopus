'use client'

// 2026-10-31 用户需求：作业坞「消耗」通用化 —— 普通会话也要看得到账本。
// 骨架与任务窗同构：用量卡（读数 + token 拆分合一）→ 耗时（对话 + 工作流）→
// 按模型 → 工作流列表。会话里跑过的 N 个工作流全部并进这一本账；不做按轮。

import { useEffect, useState } from 'react'
import { getSessionUsage, type SessionUsagePayload, type SessionUsageWorkflowWire } from '@/lib/tasks-api'
import { formatCost, formatDuration, formatPercent, formatTokenCount, type CostDisplay } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { Spinner } from '@/components/ui/spinner'
import { ModelBreakdownList } from '@/components/agent/chat/usage-totals-grid'
import { cn } from '@/lib/utils'

/** 工作流色条：与列表圆点同色（前两个青/紫，与原型一致）。 */
const WORKFLOW_BARS = [
  'bg-pop-purple',
  'bg-pop-cyan',
  'bg-pop-amber',
  'bg-pop-green',
  'bg-pop-pink',
  'bg-pop-navy',
]

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'border-pop-bd text-pop-dim bg-pop-paper' },
  ready: { label: '待执行', cls: 'border-pop-cyan/35 text-pop-cyan bg-pop-cyan-soft' },
  running: { label: '运行中', cls: 'border-pop-green/35 text-pop-green bg-pop-green-soft' },
  paused: { label: '已暂停', cls: 'border-pop-amber/30 text-pop-amber bg-pop-amber-soft' },
  awaiting_review: { label: '待验收', cls: 'border-pop-amber/30 text-pop-amber bg-pop-amber-soft' },
  awaiting_archive: { label: '待归档', cls: 'border-pop-pink/30 text-pop-pink bg-pop-pink-soft' },
  archiving: { label: '归档中', cls: 'border-pop-amber/30 text-pop-amber bg-pop-amber-soft' },
  done: { label: '已完成', cls: 'border-pop-green/35 text-pop-green bg-pop-green-soft' },
  failed: { label: '失败', cls: 'border-pop-red/35 text-pop-red bg-pop-red/10' },
  aborted: { label: '中止', cls: 'border-pop-amber/30 text-pop-amber bg-pop-amber-soft' },
}

const STATUS_FALLBACK = { label: '未知', cls: 'border-pop-bd text-pop-dim bg-pop-paper' }

const CALIBER = (
  <>
    <b>口径</b><br />
    对话 = 本会话聊天调用（execution_id 为空），按调用时间区间并集计，重复上报只算一次。<br />
    工作流 = 本会话发起的每一个任务（tasks.source_chat_session_id = 本会话）全部执行轮的实跑段之和；排队 / 待验收不计。<br />
    总耗时 = 对话 + 工作流（两段重叠不扣减）。智能体工时 = 对话调用时长合计 + 各工作流 agent 节点时长，可大于总耗时，显示倍数。
  </>
)

function tokenCell(label: string, value: number, swatch: string) {
  return (
    <div className="flex flex-col gap-px">
      <span className="text-[9.5px] text-pop-dim">
        <i className={cn('mr-1.5 inline-block size-2 rounded-sm align-middle', swatch)} />
        {label}
      </span>
      <b className="text-[13px] font-black tabular-nums">{formatTokenCount(value)}</b>
    </div>
  )
}

export function SessionUsageWindow({
  sessionId,
  onOpenTask,
}: {
  sessionId: string
  /** 点工作流行 → 跳到对应任务（缺省时行不可点）。 */
  onOpenTask?: (taskId: string) => void
}) {
  const [usage, setUsage] = useState<SessionUsagePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currency = useBillingCurrency()

  useEffect(() => {
    let alive = true
    setUsage(null)
    setError(null)
    const load = () => {
      getSessionUsage(sessionId)
        .then((next) => { if (alive) { setUsage(next); setError(null) } })
        .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '读取会话账本失败') })
    }
    load()
    const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [sessionId])

  if (error) {
    return <div className="p-4 text-[11.5px] text-pop-red" data-testid="session-usage-error">{error}</div>
  }
  if (!usage) {
    return (
      <div className="flex h-full items-center gap-2 p-6 text-[11px] text-pop-dim">
        <Spinner className="size-3.5" /> 读取会话账本…
      </div>
    )
  }

  const { summary, timing, workflows } = usage
  const total = timing.duration_ms
  const conversation = timing.conversation_ms
  const agent = Math.max(0, timing.agent_duration_ms)
  const ratio = total > 0 ? agent / total : 0
  const parallel = ratio > 1.005
  const empty = summary.totalCalls === 0 && workflows.length === 0

  if (empty) {
    return (
      <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="session-usage-window">
        <div className="rounded-xl border border-dashed border-pop-bd px-4 py-10 text-center text-[11.5px] text-pop-dim">
          本会话还没有产生用量。
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="session-usage-window">
      {/* 用量卡：头部读数 + token 拆分合一（2026-10-31 用户：突出） */}
      <div
        data-testid="session-usage-card"
        className="mb-3 rounded-xl border border-pop-cyan/30 bg-gradient-to-b from-pop-cyan-soft/55 to-pop-paper/35 px-3.5 py-3"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-dim">
            SESSION LEDGER · 本会话
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-pop-dim">
            {summary.totalCalls} 次请求 · cache {formatPercent(summary.totals.cacheHitRate, 1)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <span
            data-testid="session-usage-tokens"
            className="text-[28px] font-black leading-none tracking-tight tabular-nums text-pop-ink"
          >
            {formatTokenCount(summary.totals.tokens)}
          </span>
          <span className="text-[11px] text-pop-dim">tok</span>
          <span className="ml-1 text-[16px] font-black tabular-nums text-pop-amber">
            {formatCost(summary.totals.cost.usd, summary.totals.cost.complete, currency)}
          </span>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-pop-bd/55 pt-2 sm:grid-cols-4">
          {tokenCell('输入', summary.usage.inputTokens, 'bg-pop-cyan')}
          {tokenCell('输出', summary.usage.outputTokens, 'bg-pop-pink')}
          {tokenCell('缓存读', summary.usage.cacheReadTokens, 'bg-pop-green')}
          {tokenCell('缓存写', summary.usage.cacheCreationTokens, 'bg-pop-navy')}
        </div>
      </div>

      {/* 耗时卡：对话 + 工作流实跑 */}
      {total > 0 && (
        <section
          data-testid="session-usage-timing"
          className="mb-3 rounded-xl border border-pop-amber/25 bg-pop-amber-soft/45 px-3.5 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-amber">耗时</span>
            <span className="ml-auto font-mono text-[9.5px] text-pop-dim">对话 + 工作流实跑</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-end gap-x-2.5 gap-y-1">
            <span
              data-testid="session-usage-total"
              className="text-[30px] font-black leading-none tracking-tight tabular-nums text-pop-ink"
            >
              {formatDuration(total)}
            </span>
            <span className="pb-[3px] text-[11px] text-pop-dim">总耗时</span>
            <div className="ml-auto text-right text-[10.5px] leading-relaxed text-pop-dim">
              <div>
                工作流 <b className="font-black tabular-nums text-pop-ink">{workflows.length}</b> 个
                {workflows.length > 0 && (
                  <> · <b className="font-black tabular-nums text-pop-ink">{formatDuration(timing.workflow_ms)}</b></>
                )}
              </div>
              <div className="text-[9.5px]">
                智能体工时 <b className="font-black tabular-nums text-pop-ink">{formatDuration(agent)}</b>
                <span
                  data-testid="session-usage-agent-ratio"
                  className="ml-1 font-black text-pop-purple"
                  title={parallel ? `工时是总耗时的 ${ratio.toFixed(2)} 倍（并行/重试叠加）` : undefined}
                >
                  {parallel ? `×${ratio.toFixed(1)}` : formatPercent(ratio, 0)}
                </span>
              </div>
            </div>
          </div>

          <div
            data-testid="session-usage-bar"
            className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]"
            role="img"
            aria-label={`总耗时 ${formatDuration(total)}，对话 ${formatDuration(conversation)}，工作流 ${workflows.length} 个`}
          >
            <i className="block h-full bg-pop-cyan" style={{ width: `${(conversation / total) * 100}%` }} />
            {workflows.map((wf, index) => (
              <i
                key={wf.task_id}
                title={`${wf.name} · ${formatDuration(wf.duration_ms)}`}
                className={cn('block h-full', WORKFLOW_BARS[index % WORKFLOW_BARS.length])}
                style={{ width: `${(wf.duration_ms / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] text-pop-dim">
            <span>
              <i className="mr-1.5 inline-block size-2 rounded-sm bg-pop-cyan align-middle" />
              对话 <b className="font-black tabular-nums text-pop-ink">{formatDuration(conversation)}</b>
            </span>
            {workflows.map((wf, index) => (
              <span key={`legend:${wf.task_id}`} className="max-w-[240px] truncate">
                <i
                  className={cn(
                    'mr-1.5 inline-block size-2 rounded-sm align-middle',
                    WORKFLOW_BARS[index % WORKFLOW_BARS.length],
                  )}
                />
                {wf.name}{' '}
                <b className="font-black tabular-nums text-pop-ink">{formatDuration(wf.duration_ms)}</b>
              </span>
            ))}
            <span className="ml-auto opacity-75">对话按调用区间并集，重复上报只算一次</span>
          </div>
        </section>
      )}

      <ModelBreakdownList
        models={summary.modelBreakdown}
        className="mb-3 rounded-lg border border-pop-bd/60 bg-pop-paper/40 px-2.5 py-1.5"
      />

      {workflows.length > 0 && (
        <div
          data-testid="session-usage-workflows"
          className="overflow-hidden rounded-lg border border-pop-bd/60"
        >
          <div className="flex items-center gap-2 bg-pop-paper/65 px-2.5 py-1 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
            <span>工作流 · {workflows.length} 个</span>
            <span className="ml-auto w-16 text-right">耗时</span>
            <span className="w-14 text-right">费用</span>
            <span className="w-3" />
          </div>
          {workflows.map((wf, index) => (
            <WorkflowRow
              key={wf.task_id}
              workflow={wf}
              color={WORKFLOW_BARS[index % WORKFLOW_BARS.length]}
              currency={currency}
              onOpen={onOpenTask}
            />
          ))}
        </div>
      )}

      <div className="mt-2.5 flex justify-end">
        <span
          data-testid="session-usage-caliber"
          className="group relative grid size-4 cursor-help place-items-center rounded-full border border-pop-bd text-[10px] font-black leading-none text-pop-dim hover:border-pop-dim hover:text-pop-ink"
          tabIndex={0}
          aria-label="账本口径说明"
        >
          i
          <span className="pointer-events-none absolute bottom-6 right-0 z-10 hidden w-[520px] rounded-lg border border-pop-bd bg-pop-paper px-2.5 py-2 text-left text-[10px] font-normal leading-relaxed text-pop-dim shadow-pop-lg group-hover:block group-focus-visible:block">
            {CALIBER}
          </span>
        </span>
      </div>
    </div>
  )
}

function WorkflowRow({
  workflow,
  color,
  currency,
  onOpen,
}: {
  workflow: SessionUsageWorkflowWire
  color: string
  currency: CostDisplay
  onOpen?: (taskId: string) => void
}) {
  const meta = STATUS_META[workflow.status] ?? STATUS_FALLBACK
  const content = (
    <>
      <i className={cn('size-2 shrink-0 rounded-sm', color)} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-pop-ink/90">{workflow.name}</span>
      <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9.5px] font-black', meta.cls)}>
        {meta.label}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-pop-amber">
        {formatDuration(workflow.duration_ms)}
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-pop-dim">
        {formatCost(workflow.cost.usd, workflow.cost.complete, currency)}
      </span>
      <span className="w-3 shrink-0 text-right text-[10px] text-pop-dim">{onOpen ? '›' : ''}</span>
    </>
  )
  if (!onOpen) {
    return (
      <div className="flex items-center gap-2.5 border-t border-pop-bd/45 px-2.5 py-1.5" data-testid="session-usage-workflow">
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="session-usage-workflow"
      title={`打开 ${workflow.name}`}
      onClick={() => onOpen(workflow.task_id)}
      className="flex w-full items-center gap-2.5 border-t border-pop-bd/45 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      {content}
    </button>
  )
}
