'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcBackfillCardData } from '@/lib/knowledge-center/card-protocol'

/**
 * ↩️ 回填卡（票13 AC4，原型 Tab④「策展人给出有价值的合成答案后」）——
 * [编进 wiki] ctx.backfillWiki：对话摘录落 raw（票02 冻结契约，origin=chat:session）
 * → 编译投递 → diff 卡落流（宿主接 feed.trackTask 挂编译卡链）；
 * [不用] ctx.dismissBackfill：纯前端弃卡，**零请求**（负断言测试钉）。
 * 窄口纪律：执行中 agent 的产出不进本卡——只有知识中心对话的合成答案会带卡。
 */
export function BackfillCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcBackfillCardData
  const statusText =
    d.status === 'submitted'
      ? '已入 raw · 编译投递'
      : d.status === 'committed'
        ? '✓ 已入库'
        : d.status === 'failed'
          ? `✕ 失败 ${d.error?.code ?? ''}`
          : undefined

  return (
    <CardShell
      testId="backfill"
      title="↩️ 回填卡 · 对话合成答案"
      status={statusText}
      tone={d.status === 'failed' ? 'danger' : d.status === 'ready' ? 'default' : 'ok'}
    >
      <div className="max-h-24 overflow-y-auto whitespace-pre-wrap border-l-[1.5px] border-pop-bd pl-2 text-pop-ink" data-testid="kc-backfill-excerpt">
        {d.title ? `${d.title}\n` : ''}{d.excerpt.length > 400 ? `${d.excerpt.slice(0, 400)}…` : d.excerpt}
      </div>
      {d.rawPath && <CardRow k="raw" v={d.rawPath} tone="muted" />}
      {d.hash && <CardRow k="hash" v={`${d.hash.slice(0, 12)}…`} tone="muted" />}
      {d.error && <CardRow k="错误" v={`${d.error.code}: ${d.error.message}`} tone="danger" />}
      {d.status === 'ready' && (
        <CardBtnRow>
          <KcBtn tone="pri" onClick={() => ctx.backfillWiki(event.id, { text: d.excerpt, ...(d.title ? { title: d.title } : {}), ...(d.sessionId ? { sessionId: d.sessionId } : {}) })} testId="kc-backfill-commit">
            编进 wiki
          </KcBtn>
          <KcBtn onClick={() => ctx.dismissBackfill(event.id)} testId="kc-backfill-dismiss">不用</KcBtn>
        </CardBtnRow>
      )}
      {d.status === 'submitted' && (
        <div className="mt-1 text-[11px] text-pop-dim" data-testid="kc-backfill-note">探索复利：答案已冻结为不可变源，编译完成后 diff 卡落流</div>
      )}
    </CardShell>
  )
}
