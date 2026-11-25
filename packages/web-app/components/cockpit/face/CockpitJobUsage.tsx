'use client'

// 详情 · 消耗页签（2026-11-25 用户；原型 docs/cabin-design/cockpit-v22.html renderUsage）。
//
// 口径：只算**这一个作业自己**的账 —— 本舱全域累计仍在右栏「消耗」。
//   · 任务：GET /api/tasks/:id/usage（主对话 + 每一轮执行 / 修复轮；按轮有真时长）；
//   · 会话 / 其它作业：GET /api/sessions/:id/usage（SUMMARY LEDGER）+ 调试轮次
//     /api/agent/debug/sessions/:id/turns（按轮 = 主回合，含模型与终态）；
//   · 子代理：subagent_runs **单列**（不与主回合 llm_calls 盲加，防双算）。
// 成本一律查询时派生（钱不落账本）；拿不到价钱的行走 formatCost 的「≈ / —」。
// 10s 轮询，与作业面其它页签同一节奏。

import { useEffect, useMemo, useState } from 'react'
import { getSessionUsage, getTaskUsage, type SessionUsagePayload, type TaskUsagePayload } from '@/lib/tasks-api'
import { listSessionDebugTurns } from '@/lib/agent/debug-api'
import type { TurnDebugSummary } from '@/lib/agent/debug-types'
import { listSessionSubagents, type SubagentRunSummary } from '@/lib/agent/api'
import { formatCost, formatDuration, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import {
  isSubagentLive, subagentStatusLabel, subagentTitle, subagentTokenTotal,
} from '@/lib/subagent-format'

const POLL_MS = 10_000

interface UsageModelRow {
  model: string
  calls: number
  tokens: number
  costUsd: number | null
}

interface UsageRound {
  key: string
  label: string
  meta: string
  tokens: number
  costUsd: number | null
  costComplete: boolean
  durationMs: number | null
}

interface UsageView {
  totalCalls: number
  tokens: number
  costUsd: number | null
  costComplete: boolean
  cacheHitRate: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  models: UsageModelRow[]
  rounds: UsageRound[]
  /** 这一本账的轮次口径名（任务 = 轮次 / 会话 = 主回合）。 */
  roundLabel: string
}

function turnStatusLabel(status: TurnDebugSummary['status']): string {
  if (status === 'ok') return '完成'
  if (status === 'running') return '运行中'
  if (status === 'interrupted') return '中断'
  if (status === 'error') return '异常'
  return status
}

function fromTaskUsage(payload: TaskUsagePayload): UsageView {
  const { summary, breakdown } = payload
  const rounds: UsageRound[] = breakdown.map((part) => ({
    key: `${part.kind}:${part.session_id ?? part.execution_id ?? part.label}`,
    label: part.label,
    meta: [
      part.kind === 'chat' ? '主对话' : '执行轮',
      part.phase_index != null ? `P${part.phase_index}` : null,
      part.round_index != null ? `R${part.round_index}` : null,
      part.workflow_ref ?? null,
    ].filter(Boolean).join(' · '),
    tokens: part.totals.tokens,
    costUsd: part.totals.cost.usd,
    costComplete: part.totals.cost.complete,
    durationMs: part.kind === 'chat' ? null : (part.duration_ms ?? null),
  }))
  return {
    totalCalls: summary.totalCalls,
    tokens: summary.totals.tokens,
    costUsd: summary.totals.cost.usd,
    costComplete: summary.totals.cost.complete,
    cacheHitRate: summary.totals.cacheHitRate,
    inputTokens: summary.usage.inputTokens,
    outputTokens: summary.usage.outputTokens,
    cacheReadTokens: summary.usage.cacheReadTokens,
    cacheCreationTokens: summary.usage.cacheCreationTokens,
    models: Object.entries(summary.modelBreakdown ?? {}).map(([model, m]) => ({
      model,
      calls: m.calls,
      tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens,
      costUsd: m.costUsd,
    })),
    rounds,
    roundLabel: '按轮 · 任务周期',
  }
}

function fromSessionUsage(payload: SessionUsagePayload, turns: readonly TurnDebugSummary[]): UsageView {
  const { summary } = payload
  const rounds: UsageRound[] = turns
    .slice()
    .sort((a, b) => a.turn_index - b.turn_index)
    .map((turn) => ({
      key: turn.id,
      label: `T${turn.turn_index}`,
      meta: [turn.model ?? '模型未知', turnStatusLabel(turn.status)]
        .filter(Boolean).join(' · '),
      tokens: turn.usage?.totalTokens ?? 0,
      costUsd: turn.usage?.costUsd ?? null,
      costComplete: turn.usage?.costComplete !== false,
      durationMs: turn.duration_ms,
    }))
  return {
    totalCalls: summary.totalCalls,
    tokens: summary.totals.tokens,
    costUsd: summary.totals.cost.usd,
    costComplete: summary.totals.cost.complete,
    cacheHitRate: summary.totals.cacheHitRate,
    inputTokens: summary.usage.inputTokens,
    outputTokens: summary.usage.outputTokens,
    cacheReadTokens: summary.usage.cacheReadTokens,
    cacheCreationTokens: summary.usage.cacheCreationTokens,
    models: Object.entries(summary.modelBreakdown ?? {}).map(([model, m]) => ({
      model,
      calls: m.calls,
      tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens,
      costUsd: m.costUsd,
    })),
    rounds,
    roundLabel: '按轮 · 主回合',
  }
}

export interface CockpitJobUsageProps {
  /** 任务账本（任务类作业才传；有它时按任务周期算，不看 doer 会话单本账）。 */
  taskId?: string | null
  /** 会话账本（会话 / 工作流 / 子代理作业）。 */
  sessionId?: string | null
  /** 页签语境名（「会话」/「任务」/「作业」），只用于文案。 */
  what?: string
}

export function CockpitJobUsage({ taskId, sessionId, what = '作业' }: CockpitJobUsageProps) {
  const currency = useBillingCurrency()
  const [taskUsage, setTaskUsage] = useState<TaskUsagePayload | null>(null)
  const [sessionUsage, setSessionUsage] = useState<SessionUsagePayload | null>(null)
  const [turns, setTurns] = useState<TurnDebugSummary[]>([])
  const [subs, setSubs] = useState<SubagentRunSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setTaskUsage(null)
    setSessionUsage(null)
    setTurns([])
    setSubs([])
    setError(null)
    if (!taskId && !sessionId) {
      setLoading(false)
      return
    }

    let alive = true
    setLoading(true)
    const tick = async () => {
      const calls: Array<Promise<unknown>> = []
      if (taskId) {
        calls.push(getTaskUsage(taskId).then((next) => { if (alive) setTaskUsage(next) }))
      } else if (sessionId) {
        calls.push(getSessionUsage(sessionId).then((next) => { if (alive) setSessionUsage(next) }))
      }
      if (sessionId) {
        calls.push(listSessionDebugTurns(sessionId).then((res) => { if (alive) setTurns(res.turns ?? []) }))
        calls.push(listSessionSubagents(sessionId).then((res) => { if (alive) setSubs(res.runs ?? []) }))
      }
      const results = await Promise.allSettled(calls)
      if (!alive) return
      const failed = results.find((r) => r.status === 'rejected')
      setError(failed && failed.status === 'rejected'
        ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
        : null)
      setLoading(false)
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, sessionId])

  const view = useMemo<UsageView | null>(() => {
    if (taskId) return taskUsage ? fromTaskUsage(taskUsage) : null
    if (sessionId) return sessionUsage ? fromSessionUsage(sessionUsage, turns) : null
    return null
  }, [taskId, sessionId, taskUsage, sessionUsage, turns])

  const subUsage = useMemo(() => {
    let tokens = 0
    let cost: number | null = null
    let priced = 0
    for (const run of subs) {
      tokens += subagentTokenTotal(run)
      if (run.cost_usd != null) {
        cost = (cost ?? 0) + run.cost_usd
        priced += 1
      }
    }
    return {
      tokens,
      cost,
      complete: subs.length > 0 && priced === subs.length,
      live: subs.filter(isSubagentLive).length,
    }
  }, [subs])

  if (!taskId && !sessionId) {
    return (
      <div className="ck12-face-empty" data-testid="cockpit-job-usage-empty">
        这条{what}没有账本（既没有任务执行，也没有会话）。
      </div>
    )
  }

  if (!view) {
    return (
      <div className="ck12-face-empty" data-testid="cockpit-job-usage">
        {error && !loading ? `消耗读取失败 · ${error}` : `读取${what}账本…`}
      </div>
    )
  }

  const totalCost = [view.costUsd, subUsage.cost]
    .filter((usd): usd is number => usd != null)
    .reduce((sum, usd) => sum + usd, 0)
  const totalCostComplete = view.costComplete && subUsage.complete

  return (
    <div data-testid="cockpit-job-usage">
      <div className="ck12-pnote">
        本{what}账本 = 这一个{what}自己的消耗（主回合 + 子代理单列，只读）；
        本舱全域累计看右栏 <b>「消耗」</b>。
      </div>

      <div className="ck12-uledger">
        <div>
          <div className="ck12-ulbig">
            {formatTokenCount(view.tokens)} <small>tok</small>
          </div>
          <div className="ck12-ulsub">
            {view.rounds.length} 轮 · {subs.length} 个子代理 · {formatPercent(view.cacheHitRate, 1)} 命中
          </div>
        </div>
        <div className="ck12-ulcost">
          <b>{formatCost(totalCost > 0 ? totalCost : view.costUsd, totalCostComplete, currency)}</b>
          <span>主回合 + 子代理单列</span>
        </div>
      </div>

      <div className="ck12-utok">
        <div className="ck12-utokc is-in"><div className="k">输入</div><div className="v">{formatTokenCount(view.inputTokens)}</div></div>
        <div className="ck12-utokc is-out"><div className="k">输出</div><div className="v">{formatTokenCount(view.outputTokens)}</div></div>
        <div className="ck12-utokc is-cr"><div className="k">缓存读</div><div className="v">{formatTokenCount(view.cacheReadTokens)}</div></div>
        <div className="ck12-utokc is-cw"><div className="k">缓存写</div><div className="v">{formatTokenCount(view.cacheCreationTokens)}</div></div>
      </div>

      <div className="ck12-sect">{view.roundLabel}</div>
      {view.rounds.length === 0 ? (
        <div className="ck12-face-empty">还没有产生用量 · 跑起来后这里按轮累计。</div>
      ) : (
        view.rounds.map((round) => (
          <div className="ck12-umrow" key={round.key} title={round.meta}>
            <span className="mn">{round.label}</span>
            <span className="md">
              {round.meta}
              {round.durationMs ? <em> · {formatDuration(round.durationMs)}</em> : null}
            </span>
            <span className="mv">{formatTokenCount(round.tokens)}</span>
            <span className="mc">{formatCost(round.costUsd, round.costComplete, currency)}</span>
          </div>
        ))
      )}

      {view.models.length > 0 && (
        <>
          <div className="ck12-sect">按模型</div>
          {view.models.map((model) => (
            <div className="ck12-umrow" key={model.model}>
              <span className="mn">{model.model}</span>
              <span className="md">{model.calls} 次请求</span>
              <span className="mv">{formatTokenCount(model.tokens)}</span>
              <span className="mc">{formatCost(model.costUsd, model.costUsd != null, currency)}</span>
            </div>
          ))}
        </>
      )}

      <div className="ck12-sect">
        子代理 · 单列（不与主回合盲加）{subUsage.live > 0 ? ` · ${subUsage.live} 个运行中` : ''}
      </div>
      {subs.length === 0 ? (
        <div className="ck12-face-empty">这个{what}还没有子代理 · 需要时在对话里让它派一个。</div>
      ) : (
        subs.map((run) => (
          <div className="ck12-umrow" key={run.id}>
            <span className="mn">◈</span>
            <span className="md">
              {subagentTitle(run)} · {run.agent_type ?? 'subagent'} · {subagentStatusLabel(run.status)}
            </span>
            <span className="mv">{formatTokenCount(subagentTokenTotal(run))}</span>
            <span className="mc">{formatCost(run.cost_usd, run.cost_complete === 1, currency)}</span>
          </div>
        ))
      )}

      <div className="ck12-pnote is-faint">
        防双算：子代理 token 走 subagent_runs 单列（{formatTokenCount(subUsage.tokens)} tok ·{' '}
        {formatCost(subUsage.cost, subUsage.complete, currency)}），不与主回合的 llm_calls 相加；
        成本按 token 用量派生，钱不落账本。
      </div>
    </div>
  )
}
