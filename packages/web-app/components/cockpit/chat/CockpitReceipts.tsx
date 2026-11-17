'use client'

// v20（design 29 §3.3）：双模式同步的本地 sys 回执 —— overlay 在转录底部，
// 不写服务端转录（真 transcript 仍是服务端唯一真源）。mono 居中小字，
// 与原型 con-log 的 sys 行同语义；只展示最近 3 条，全量在 title 里。

import { useCockpitState } from '../state/CockpitStateProvider'

export function CockpitReceipts({ threadKey }: { threadKey: string }) {
  const { threads: api } = useCockpitState()
  const list = api.receipts[threadKey] ?? []
  if (!list.length) return null
  const shown = list.slice(-3)

  return (
    <div
      className="ck12-comms-receipts"
      data-testid="cockpit-receipts"
      title={list.map((r) => r.text).join('\n')}
      aria-live="polite"
    >
      {shown.map((receipt) => (
        <div key={receipt.id} className="ck12-receipt">⌁ {receipt.text}</div>
      ))}
    </div>
  )
}
