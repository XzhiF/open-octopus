'use client'

import { CardShell, CardRow } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcAutoRetireCardData } from '@/lib/knowledge-center/card-protocol'

/**
 * 🍂 自动退役通知卡（P4 票09 · spec 故事16/AC3）——夜巡窄口命中（锚点 90 天零引用 ∧
 * 零活页入链 ∧ 非人工文件）退役**发生后**沉进知识中心对话流：页/去向/commit +
 * 判据数据（末引时刻与静默天数——人可复核「确实是僵尸」）+ **可恢复提示**
 * （对话口令「恢复 oct-XXX」，故事17 的后悔药入口）。
 *
 * 红线2 形态钉死：先斩后奏但可逆——本卡**零操作钮**（非审批形态；批准/否决概念
 * 不存在）。恢复走对话意图分类（classifyKcRestore → POST /restore），与「退役一页」
 * 同款动线；卡只是信息沉淀。S4 测试对「无 button/无审批词」下负断言。
 */
export function AutoRetireCard({ event }: KcCardViewProps) {
  const d = event.data as KcAutoRetireCardData
  const statusText = d.status === 'committed' ? '窄口已执行（可恢复）' : `✕ 未成 ${d.error?.code ?? ''}`
  const silent = d.lastCited
    ? `${d.daysSilent} 天（末引 ${d.lastCited.slice(0, 10)}）`
    : `${d.daysSilent} 天（从未有引用记录）`
  return (
    <CardShell
      testId="auto-retire"
      title="🍂 自动退役通知 · 窄口"
      status={statusText}
      tone={d.status === 'failed' ? 'danger' : 'warn'}
    >
      <CardRow k="页" v={d.pagePath} tone="muted" />
      {d.to && <CardRow k="去向" v={d.to} tone="muted" />}
      {d.commit && <CardRow k="commit" v={d.commit.slice(0, 7)} tone="muted" />}
      <CardRow k="锚点" v={d.anchors.length > 0 ? d.anchors.join('、') : '—'} tone="muted" />
      <CardRow k="静默" v={silent} />
      {d.restoreHints.length > 0 && (
        <CardRow k="恢复" v={`对话说「${d.restoreHints.join('」或「')}」——原号原行回迁`} tone="warn" />
      )}
      {d.error && <CardRow k="错误" v={`${d.error.code}: ${d.error.message}`} tone="danger" />}
    </CardShell>
  )
}
