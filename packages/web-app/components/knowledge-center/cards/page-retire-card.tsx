'use client'

import { CardShell, CardRow } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcPageRetireCardData } from '@/lib/knowledge-center/card-protocol'
import { kcTaskStateLabel } from '@/lib/knowledge-center/card-protocol'

/**
 * 🗄️ 页退役卡（票08 清理账 · 故事32）——对话「退役 <页>」触发 POST /retire →
 * 队列 page-retire 执行：页迁 `_retired/` + superseded + 四路摘除 + 单 commit。
 * 本卡只**回显**退役回执（去向 / commit / 错误），无操作钮（触发口在对话意图，
 * 不在卡上——红线「审批不复活」，退役是人裁对话动作，卡是事后沉淀）。
 */
export function PageRetireCard({ event }: KcCardViewProps) {
  const d = event.data as KcPageRetireCardData
  const statusText = kcTaskStateLabel({ status: d.status, position: d.position, hash: d.commit, verb: 'retire' })

  return (
    <CardShell
      testId="page-retire"
      title="🗄️ 页退役卡 · superseded"
      status={statusText}
      tone={d.status === 'failed' ? 'danger' : d.status === 'committed' ? 'ok' : 'default'}
    >
      <CardRow k="页" v={d.pagePath} tone="muted" />
      {d.to && <CardRow k="去向" v={d.to} tone="muted" />}
      {d.commit && <CardRow k="commit" v={`${d.commit.slice(0, 7)}`} tone="muted" />}
      {d.error && <CardRow k="错误" v={`${d.error.code}: ${d.error.message}`} tone="danger" />}
    </CardShell>
  )
}
