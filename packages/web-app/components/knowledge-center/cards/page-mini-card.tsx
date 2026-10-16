'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcPageMiniCardData } from '@/lib/knowledge-center/card-protocol'

/** 📇 页迷你卡 — 对话提到某页（知识中心改版 ADR-0033：原「右栏渲染/全页打开」
 *  两钮随跟随与双模式废除合一为「在主场打开」——正文区渲染，抽屉保持原位）。 */
export function PageMiniCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcPageMiniCardData
  const target = d.pageId ?? d.path ?? ''
  return (
    <CardShell testId="page-mini" title={`📇 ${d.title}${d.isNew ? ' · 新建' : ''}`}>
      {d.type && <CardRow k="type" v={d.type} tone="muted" />}
      {d.path && <CardRow k="路径" v={d.path} tone="muted" />}
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => ctx.openPage(target)} testId="kc-mini-follow">在主场打开</KcBtn>
      </CardBtnRow>
    </CardShell>
  )
}
