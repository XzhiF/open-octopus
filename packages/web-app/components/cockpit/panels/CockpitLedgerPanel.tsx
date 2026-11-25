'use client'

// v20（design 29 §6 usage / §8）：SESSION LEDGER 模态 —— 舱账本全集。
// 真数据 = GET /api/cabins/:id/usage（30s 轮询，失败留上次值并标 stale）：
// 总 tok / ¥ / 请求数 / cache% → 四 token 格 → 按模型行 → 作战账本行（点击→详情）。
// 数字纪律：null 成本显式「未计价」，不写 0；回合结束更新（不暗示边流边涨）。

import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost, formatTokenCount } from '@/lib/format'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinUsage } from '../bridge/use-cabin-usage'
import { CockpitPanelShell } from './CockpitPanelShell'

const CELL_LABELS = [
  ['inputTokens', '输入 ↑'],
  ['outputTokens', '输出 ↓'],
  ['cacheReadTokens', '缓存读'],
  ['cacheCreationTokens', '缓存写'],
] as const

export function CockpitLedgerPanel() {
  const { entryCabinId, select, closePanel, chatWindow } = useCockpitState()
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()

  const grand = usage?.grand ?? null
  const summary = usage?.summary ?? null

  const openJob = (jobId: string | null, kind: string, refId: string | null) => {
    closePanel()
    if (jobId) {
      select({ kind: 'job', cabinId: entryCabinId, id: jobId })
      return
    }
    if (kind === 'task' && refId) {
      select({ kind: 'task', cabinId: entryCabinId, id: refId })
      return
    }
    // 主通讯台固定主对话：直接展开即可（v22 #5 起不再有线程切换）。
    chatWindow.openWithFocus()
  }

  return (
    <CockpitPanelShell kind="ledger" title="本舱账本" en="CABIN LEDGER · 全域只读">
      <div className="ck12-ledger-note" data-testid="cockpit-ledger-note">
        本舱账本 = 全域累计（各作战汇总，只读）；本会话明细看通讯台头部 <b>CTX / TOKEN</b> 下拉。
      </div>
      {!usage && (
        <div className="ck12-ops-empty">{stale ? '账本读取失败 · 稍后重试' : '读账本…'}</div>
      )}
      {usage && grand && (
        <>
          <div className="ck12-ledger-top" data-testid="cockpit-ledger-top">
            <span><b>{formatTokenCount(grand.totals.tokens)}</b> tok</span>
            <span><b>{formatCost(grand.totals.cost.usd, grand.totals.cost.complete, currency)}</b></span>
            <span><b>{grand.totalCalls}</b> 请求</span>
            <span>
              <b>{grand.totals.cacheHitRate == null ? '未就绪' : `${Math.round(grand.totals.cacheHitRate * 100)}%`}</b> cache
            </span>
            {stale && <i className="ck12-ledger-stale">stale · 上次成功值</i>}
          </div>
          <div className="ck12-ledger-cells" data-testid="cockpit-ledger-cells">
            {CELL_LABELS.map(([key, label]) => (
              <div key={key} className="ck12-ledger-cell">
                <b>{formatTokenCount(grand.usage[key])}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <div className="ck12-ledger-sec">按模型</div>
          {summary?.modelBreakdown && Object.keys(summary.modelBreakdown).length > 0 ? (
            Object.entries(summary.modelBreakdown).map(([model, row]) => (
              <div key={model} className="ck12-ledger-row" data-testid={`cockpit-ledger-model-${model}`}>
                <b className="ck12-ledger-name">{model}</b>
                <span>{row.calls} 请求</span>
                <span>{formatTokenCount(row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens)} tok</span>
                <span className="ck12-ledger-cost">
                  {row.costUsd == null ? '未计价' : formatCost(row.costUsd, true, currency)}
                </span>
              </div>
            ))
          ) : (
            <div className="ck12-ledger-none">还没有按模型明细</div>
          )}

          <div className="ck12-ledger-sec">作战账本 · 点击进详情</div>
          {usage.byJob.length > 0 ? (
            usage.byJob.map((row) => (
              <button
                key={`${row.job_id ?? 'chat'}-${row.label}`}
                type="button"
                className="ck12-ledger-row is-job"
                data-testid={`cockpit-ledger-job-${row.job_id ?? row.ref_id ?? 'chat'}`}
                onClick={() => openJob(row.job_id, row.kind, row.ref_id)}
              >
                <b className="ck12-ledger-name">{row.label}</b>
                <span>{row.kind}</span>
                <span>{formatTokenCount(row.totals.tokens)} tok</span>
                <span className="ck12-ledger-cost">
                  {formatCost(row.totals.cost.usd, row.totals.cost.complete, currency)}
                </span>
              </button>
            ))
          ) : (
            <div className="ck12-ledger-none">还没有作战消耗</div>
          )}
          <div className="ck12-ops-foot">回合结束更新 · 30s 轮询 · 与舰桥 ¥ 同源</div>
        </>
      )}
    </CockpitPanelShell>
  )
}
