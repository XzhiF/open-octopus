'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcPageMiniCardData } from '@/lib/knowledge-center/card-protocol'

/** 📇 词条迷你卡 — 对话提到某页（原型：右栏渲染 · 全页打开 两钮）。 */
export function PageMiniCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcPageMiniCardData
  const target = d.pageId ?? d.path ?? ''
  return (
    <CardShell testId="page-mini" title={`📇 ${d.title}${d.isNew ? ' · 新建' : ''}`}>
      {d.type && <CardRow k="type" v={d.type} tone="muted" />}
      {d.path && <CardRow k="路径" v={d.path} tone="muted" />}
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => ctx.openPage(target)} testId="kc-mini-follow">右栏渲染</KcBtn>
        <KcBtn onClick={() => ctx.openFullPage(target)} testId="kc-mini-open">全页打开</KcBtn>
      </CardBtnRow>
    </CardShell>
  )
}
