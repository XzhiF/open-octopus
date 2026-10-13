'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import { shortHash, kcTaskStateLabel } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'
import type { KcFindingCardData } from '@/lib/knowledge-center/card-protocol'

/** kind → 图标+通道标签（原型 Tab④ finding 卡；卡片目录行「编译期矛盾/巡检发现」）。 */
const KIND_LABEL: Record<string, string> = {
  contradiction: '⚠️ 矛盾',
  stale: '🕰 stale 上报',
  orphan: '🏝 孤儿页',
  'missing-page': '🕳 概念缺页',
  'missing-xref': '🔗 缺互链',
}

/**
 * ⚠️ finding 卡（票13 AC2/AC3）——三钮合同：
 * [采纳修订] ctx.adoptFinding（服务端生成修订稿经全局队列编译；卡上流式状态
 * 排队中 #N→编译中→已提交 hash；committed ⇒ 卡终态 resolved）
 * [忽略] ctx.ignoreFinding（记录在案不再扰，按钮退场）
 * [讨论] ctx.sayToCurator（对话继续，零状态变更零请求）。
 * 终态卡（detail 面 status=resolved/ignored）不再出钮——裁决一次性。
 */
export function FindingCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcFindingCardData
  const label = KIND_LABEL[d.kind] ?? `⚠️ ${d.kind}`
  const terminal = d.status !== 'open'

  const statusText = terminal
    ? d.status === 'resolved'
      ? `✓ 已修订${d.fix?.commit ? ` ${shortHash(d.fix.commit)}` : ''}`
      : '已忽略 · 记录在案'
    : d.fix
      ? d.fix.status === 'failed'
        ? `修订失败 ${d.fix.error?.code ?? ''}`
        : kcTaskStateLabel({ status: d.fix.status, position: d.fix.position, hash: d.fix.commit })
      : '待裁决'

  const tone = terminal
    ? d.status === 'resolved' ? 'ok' : 'default'
    : d.fix?.status === 'failed'
      ? 'danger'
      : 'warn'

  return (
    <CardShell testId="finding" title={`${label} · FINDING 卡`} status={statusText} tone={tone}>
      <div className="leading-relaxed text-pop-ink">{d.title}</div>
      {d.claims && (
        <>
          <CardRow k="旧断言" v={d.claims.old} tone="muted" />
          <CardRow k="新断言" v={d.claims.new} />
        </>
      )}
      {d.pages.length > 0 && (
        <CardRow
          k="涉事页"
          v={
            <span className="flex flex-wrap gap-1">
              {d.pages.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => ctx.openPage(p)}
                  className="text-pop-cyan hover:underline"
                  data-testid={`kc-finding-page-${p.split('/').pop()}`}
                >
                  {p}
                </button>
              ))}
            </span>
          }
        />
      )}
      {d.rawRef && <CardRow k="对质指针" v={d.rawRef} tone="muted" />}
      <CardRow k="来源" v={d.source === 'compile' ? '编译期矛盾' : d.source === 'patrol' ? '语义巡检' : d.source} tone="muted" />
      {d.fix?.status === 'failed' && (
        <CardRow k="错误" v={`${d.fix.error?.code ?? 'FAILED'}: ${d.fix.error?.message ?? ''}`} tone="danger" />
      )}

      {!terminal && (
        <CardBtnRow>
          <KcBtn
            tone="green"
            disabled={d.fix?.status === 'queued' || d.fix?.status === 'running'}
            onClick={() => ctx.adoptFinding(d.findingId)}
            testId="kc-finding-adopt"
          >
            采纳修订（裁决即编译）
          </KcBtn>
          <KcBtn tone="no" disabled={!!d.fix} onClick={() => ctx.ignoreFinding(d.findingId)} testId="kc-finding-ignore">
            忽略
          </KcBtn>
          <KcBtn tone="pri" onClick={() => ctx.sayToCurator(`关于 finding「${d.title}」，我想讨论：`)} testId="kc-finding-discuss">
            讨论
          </KcBtn>
        </CardBtnRow>
      )}
      {terminal && (
        <div className="mt-2 text-[11px] text-pop-dim" data-testid="kc-finding-terminal">
          {d.status === 'resolved' ? '裁决已落地（采纳修订→编译 commit；git LOG 为审计真相）' : '已记录在案——证据不变不再扰，可在对话里重新提出'}
        </div>
      )}
    </CardShell>
  )
}
