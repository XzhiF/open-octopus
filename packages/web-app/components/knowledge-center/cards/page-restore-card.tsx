'use client'

import { CardShell, CardRow } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcPageRestoreCardData } from '@/lib/knowledge-center/card-protocol'
import { kcTaskStateLabel } from '@/lib/knowledge-center/card-protocol'

/**
 * ↩️ 页恢复回执卡（P4 票09 · spec 故事17/AC4）——对话「恢复 oct-XXX」→ POST /restore
 * → 队列 page-restore：_retired/ 原号原行回迁 + 入链反放 + LOG restore 行 + 单 commit。
 * 形态对偶页退役回执卡（票08）：只**回显**恢复回执（去向/commit/入链回补数/漂移
 * warnings），零操作钮（触发口在对话意图，不在卡上——红线「审批不复活」同款）。
 * warnings 显形不吞：漂移宿主归人裁（窄口之外零自动取舍）。
 */
export function PageRestoreCard({ event }: KcCardViewProps) {
  const d = event.data as KcPageRestoreCardData
  const statusText = kcTaskStateLabel({ status: d.status, position: d.position, hash: d.commit, verb: 'restore' })
  return (
    <CardShell
      testId="page-restore"
      title="↩️ 页恢复卡 · 原号回迁"
      status={statusText}
      tone={d.status === 'failed' ? 'danger' : d.status === 'committed' ? 'ok' : 'default'}
    >
      {d.anchor && <CardRow k="口令" v={`oct 锚点 ${d.anchor}`} tone="muted" />}
      <CardRow k="页" v={d.pagePath} tone="muted" />
      {d.from && <CardRow k="来自" v={d.from} tone="muted" />}
      {d.commit && <CardRow k="commit" v={d.commit.slice(0, 7)} tone="muted" />}
      {typeof d.linksRestored === 'number' && <CardRow k="入链回补" v={`${d.linksRestored} 页`} />}
      {d.warnings && d.warnings.length > 0 && (
        <CardRow k="显形" v={d.warnings.join('；')} tone="warn" />
      )}
      {d.error && <CardRow k="错误" v={`${d.error.code}: ${d.error.message}`} tone="danger" />}
    </CardShell>
  )
}
