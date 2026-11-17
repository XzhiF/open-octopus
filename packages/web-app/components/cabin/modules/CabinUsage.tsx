'use client'

// 消耗窗（原型 wbUsage · C7）：舱级累计 ledger 三列 + byJob（orchestrator 主对话
// chat execution_id IS NULL / task / workflow）+ 子代理单列（subagent_runs，不与
// llm_calls 盲加）。成本经 llm_calls_costed 查询时派生、钱不落账本；币种随
// billing_setting。骨架复用 UsageTotalsGrid/ModelBreakdownList，10s 轮询。

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, MessageSquare } from 'lucide-react'
import { getCabinUsage, type CabinUsagePayload } from '@/lib/cabin-api'
import { formatCost, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { UsageTotalsGrid, ModelBreakdownList } from '@/components/agent/chat/usage-totals-grid'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WbH, WbNote, WbSec, type SBadgeColor } from './ui'

const JOB_COLOR: Record<string, SBadgeColor> = { chat: 'purple', task: 'cyan', workflow: 'violet' }
const JOB_LABEL: Record<string, string> = { chat: 'chat', task: 'task', workflow: 'workflow' }

export function CabinUsage() {
  const { cabinId } = useCabinContext()
  const currency = useBillingCurrency()
  const [data, setData] = useState<CabinUsagePayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await getCabinUsage(cabinId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '消耗读取失败')
    }
  }, [cabinId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const cost = (usd: number | null, complete = true) => formatCost(usd, complete, currency)
  const taskJobs = data?.byJob.filter((j) => j.kind === 'task') ?? []

  return (
    <div data-testid="cabin-usage-body">
      <WbH icon={BarChart3} title="消耗" cap="舱级累计 · 成本派生自 llm_calls_costed" />
      {!data ? (
        <Empty>{error ?? '读取舱级消耗…'}</Empty>
      ) : (
        <>
          <div className="my-2.5 grid grid-cols-3 gap-2" data-testid="cabin-usage-ledger">
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-ink" data-testid="cabin-usage-grand-cost">
                {cost(data.grand.totals.cost.usd, data.grand.totals.cost.complete)}
              </b>
              <span className="text-[9.5px] text-pop-dim">累计消耗</span>
            </div>
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-cyan">{taskJobs.length}</b>
              <span className="text-[9.5px] text-pop-dim">任务作业</span>
            </div>
            <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5 text-center">
              <b className="block text-[18px] text-pop-purple">{data.subagents.count}</b>
              <span className="text-[9.5px] text-pop-dim">子代理</span>
            </div>
          </div>

          <div className="rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle p-2.5">
            <UsageTotalsGrid usage={data.grand} />
          </div>

          <WbSec cap={`${data.byJob.length} 行`}>按作业（byJob）</WbSec>
          <div className="space-y-1.5" data-testid="cabin-usage-byjob">
            {data.byJob.map((j) => (
              <div key={`${j.kind}-${j.ref_id ?? j.job_id}`} className="flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2">
                {j.kind === 'chat' && <MessageSquare className="size-3 shrink-0 text-pop-purple" />}
                <span className="ui-font min-w-0 flex-1 truncate text-[11.5px] font-semibold text-pop-ink">{j.label}</span>
                <span className="shrink-0 text-[9.5px] text-pop-dim">
                  {JOB_LABEL[j.kind]}{j.kind === 'chat' ? ' · execution_id IS NULL' : ''} · {formatTokenCount(j.totals.tokens)} tok
                </span>
                <SBadge color={JOB_COLOR[j.kind] ?? 'dim'}>{cost(j.totals.cost.usd, j.totals.cost.complete)}</SBadge>
              </div>
            ))}
          </div>

          <WbSec cap={`${data.subagents.count} 个 · ${cost(data.subagents.cost.usd, data.subagents.cost.complete)}`}>
            子代理（单列 · 不与 llm_calls 盲加）
          </WbSec>
          {data.subagents.runs.length === 0 ? (
            <WbNote className="mb-2">暂无子代理作业</WbNote>
          ) : (
            <div className="space-y-1.5" data-testid="cabin-usage-subagents">
              {data.subagents.runs.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2">
                  <span className="ui-font min-w-0 flex-1 truncate text-[11.5px] font-semibold text-pop-ink">{s.label}</span>
                  <span className="shrink-0 text-[9.5px] text-pop-dim">subagent · {formatTokenCount(s.tokens)} tok · {s.status}</span>
                  <SBadge color="dim">{cost(s.cost.usd, s.cost.complete)}</SBadge>
                </div>
              ))}
            </div>
          )}

          {data.summary.modelBreakdown && Object.keys(data.summary.modelBreakdown).length > 0 && (
            <>
              <WbSec>按模型</WbSec>
              <ModelBreakdownList models={data.summary.modelBreakdown} />
            </>
          )}

          <WbNote className="mt-3">
            防双算：chat 行 execution_id IS NULL；子代理 token 走 subagent_runs 单列
            （{formatTokenCount(data.subagents.tokens)} tok）。成本查询时派生、钱不落账本；币种随 billing_setting。
          </WbNote>
        </>
      )}
    </div>
  )
}