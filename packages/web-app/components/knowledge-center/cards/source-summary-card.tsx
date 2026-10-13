'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcSourceSummaryCardData } from '@/lib/knowledge-center/card-protocol'

/** 📄 来源摘要卡 — sources/ 页生成（原型：要点 + 回指 raw 与 hash；看 raw / 看摘要页钮）。 */
export function SourceSummaryCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcSourceSummaryCardData
  return (
    <CardShell testId="source-summary" title={<>📄 来源摘要卡 · <span className="font-bold">{d.sourcePath}</span></>}>
      <CardRow k="回指 raw" v={`${d.rawPath}${d.hash ? `（${d.hash.slice(0, 6)}…）` : ''}`} />
      {d.points.length > 0 ? (
        <div className="space-y-0.5">
          <div className="text-pop-dim">要点 {d.points.length} 条：</div>
          {d.points.map((p, i) => (
            <div key={i} className="text-pop-ink">{`${i + 1}) ${p}`}</div>
          ))}
        </div>
      ) : (
        <div className="text-pop-dim">回执页已生成（sources/），要点见摘要页。</div>
      )}
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => ctx.openRaw(`raw/${d.rawPath.replace(/^raw\//, '')}`)} testId="kc-ss-open-raw">看 raw 原文</KcBtn>
        <KcBtn onClick={() => ctx.openPage(d.sourcePath)} testId="kc-ss-open-page">看摘要页</KcBtn>
      </CardBtnRow>
    </CardShell>
  )
}
