'use client'

// 详情 · 子代理页签（2026-11-25 用户；原型 docs/cabin-design/cockpit-v22.html renderAgents）。
//
// 只列**这个作业自己的会话**派出去的子代理（按 session_id 归属）：
//   · 数据 = GET /api/agent/sessions/:id/subagents（subagent_runs）；
//   · 运行中置顶、已结束留档（口径与右栏「活动」同一套 activity-model）。
// 2026-11-25 用户：这里不要后台作业（run_in_background 的 Bash 等）—— 这一页只关注
// 子代理。后台作业仍在右栏「活动」/「更多 → 活动日志」看，不在这里重复列。
// 点一行看过程（右半边）：SubagentWindow。
// 全舱历史仍在右栏「更多 → 活动日志」；这里只是按作业收窄的一扇窗。

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  listSessionSubagents,
  type SubagentRunSummary,
} from '@/lib/agent/api'
import { formatCost, formatDuration, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import {
  subagentElapsedMs, subagentTokenTotal,
} from '@/lib/subagent-format'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import {
  activityIsLive,
  activityItems,
  activityRightLabel,
  activityTitle,
  type ActivityItem,
} from '../rail/activity-model'

/** 本页签只展示子代理；activity-model 的联合类型在这里收窄。 */
type SubagentItem = Extract<ActivityItem, { kind: 'subagent' }>

const POLL_MS = 5_000

export interface SessionActivity {
  items: ActivityItem[]
  live: number
  total: number
  loading: boolean
  error: string | null
}

const EMPTY_ACTIVITY: SessionActivity = { items: [], live: 0, total: 0, loading: false, error: null }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 单个会话的子代理电平（详情面用；右栏「活动」仍走主会话 Provider，含后台作业）。 */
export function useSessionActivity(sessionId: string | null): SessionActivity {
  const [runs, setRuns] = useState<SubagentRunSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRuns([])
    setError(null)
    if (!sessionId) {
      setLoading(false)
      return
    }

    let alive = true
    let timer: number | undefined
    setLoading(true)
    const tick = async () => {
      try {
        const res = await listSessionSubagents(sessionId)
        if (!alive) return
        setRuns(res.runs ?? [])
        setError(null)
      } catch (err) {
        if (!alive) return
        // 沿用上一帧：一次超时 / 连接抖动不该让子代理列表闪没。
        setError(errorText(err))
      }
      setLoading(false)
      timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [sessionId])

  return useMemo<SessionActivity>(() => {
    if (!sessionId) return EMPTY_ACTIVITY
    const items = activityItems(runs, [])
    return {
      items,
      live: items.filter(activityIsLive).length,
      total: items.length,
      loading,
      error,
    }
  }, [sessionId, runs, loading, error])
}

/** 行副文案：类型 · 步数 · 开始。 */
function itemMeta(item: SubagentItem): string {
  return [
    item.run.agent_type ?? 'subagent',
    item.run.step_count > 0 ? `${item.run.step_count} 步` : null,
    item.run.started_at
      ? `${new Date(item.run.started_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 起`
      : null,
  ].filter(Boolean).join(' · ')
}

export interface CockpitJobAgentsProps {
  sessionId: string | null
  /** 宿主已挂 useSessionActivity 时传进来（页签角标复用同一份数据）。 */
  activity?: SessionActivity
  /** 文案语境（会话 / 任务 / 作业）。 */
  what?: string
}

export function CockpitJobAgents({ sessionId, activity, what = '作业' }: CockpitJobAgentsProps) {
  const own = useSessionActivity(activity ? null : sessionId)
  const feed = activity ?? own
  const [sel, setSel] = useState<string | null>(null)

  // 换会话：选中行作废（不然会拿 A 会话的 id 去 B 会话拉详情）。
  useEffect(() => { setSel(null) }, [sessionId])

  // 只留子代理：本页签不列后台作业（2026-11-25 用户）。
  const items = useMemo(
    () => feed.items.filter((item): item is SubagentItem => item.kind === 'subagent'),
    [feed.items],
  )

  const selected = useMemo(
    () => items.find((item) => item.id === sel) ?? null,
    [items, sel],
  )

  if (!sessionId) {
    return <div className="ck12-face-empty">这条{what}还没有会话 · 没有子代理。</div>
  }

  if (items.length === 0) {
    return (
      <div className="ck12-face-empty" data-testid="cockpit-job-agents-empty">
        {feed.error && !feed.loading
          ? `子代理读取失败 · ${feed.error}`
          : feed.loading
            ? '读取子代理…'
            : `这个${what}还没有子代理 · 需要时在对话里让它开一个。`}
      </div>
    )
  }

  const live = items.filter(activityIsLive)
  const done = items.filter((item) => !activityIsLive(item))

  return (
    <div className="ck12-agwrap" data-testid="cockpit-job-agents">
      <div className="ck12-aglist">
        <div className="ck12-agsum">
          <span className="k">子代理</span>
          <b>{items.length}</b>
          <span className="k">运行中</span>
          <b>{live.length}</b>
        </div>

        {live.length > 0 && <div className="ck12-aggrp">运行中</div>}
        {live.map((item) => (
          <AgentRow key={item.id} item={item} on={sel === item.id} onPick={() => setSel(item.id)} />
        ))}
        {done.length > 0 && <div className="ck12-aggrp">已结束</div>}
        {done.map((item) => (
          <AgentRow key={item.id} item={item} on={sel === item.id} onPick={() => setSel(item.id)} />
        ))}
      </div>

      {selected && (
        <div className="ck12-agdetail">
          <div className="ck12-agdetail-h">
            <b>{activityTitle(selected)}</b>
            <span>子代理</span>
            <button
              type="button"
              className="ck12-agclose"
              aria-label="收起详情"
              title="收起详情"
              onClick={() => setSel(null)}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
          <div className="ck12-agdetail-b">
            <SubagentWindow sessionId={sessionId} agentId={selected.run.id} />
          </div>
        </div>
      )}
    </div>
  )
}

function AgentRow({ item, on, onPick }: { item: SubagentItem; on: boolean; onPick: () => void }) {
  const currency = useBillingCurrency()
  const live = activityIsLive(item)
  const tokens = subagentTokenTotal(item.run)
  const cost = { usd: item.run.cost_usd, complete: item.run.cost_complete === 1 }
  const status = activityRightLabel(item, Date.now())
  const elapsed = subagentElapsedMs(item.run, Date.now())

  return (
    <button
      type="button"
      className={`ck12-agrow${on ? ' is-on' : ''}`}
      data-testid={`cockpit-agent-row-${item.id}`}
      title="点开看过程"
      onClick={onPick}
    >
      <span className="agk">◈ 子代理</span>
      <span className="agb">
        <b>{activityTitle(item)}</b>
        <span>{itemMeta(item)}</span>
      </span>
      <span className="agr">
        <span className={`st${live ? '' : ' is-done'}`}>
          {live && elapsed != null ? `运行 · ${formatDuration(elapsed)}` : status}
        </span>
        <span className="mt">
          {tokens != null && tokens > 0 ? `${formatTokenCount(tokens)} tok · ` : ''}
          {formatCost(cost.usd, cost.complete, currency)}
        </span>
      </span>
      <span className="go">{on ? '收起' : '详情 →'}</span>
    </button>
  )
}
