'use client'

import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import { kcTaskStateLabel, type KcCaseCardData } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'

/**
 * ⚖️ 判例卡（P3 票03；spec §卡片与 UI「判例卡（五段预览+source 指针+退役钮）」，
 * 票面第 4 行逐字）。
 *
 * 判例由归档链自动入档（先存后知——本卡是入档后的事后通知，非审批），卡面给全五段
 * （现场/诊断/根因/修复/教训，CBR 叙事序）供 owner 一眼对质；source 指回 exec/task
 * 可定位指针；[看判例页] 走右栏渲染；[退役] 经 case-archive 队列通道标 superseded
 * （红线2：判例一切写走唯一写闸，本钮只发 REST 回执；Lane B 覆盖层回灌位次）；
 * 对策展人说 = 对话改写通道（story 11 事后纠的另一腿，灌进取号器零状态变更）。
 * 终态（superseded）去钮样式沿 finding 卡先例（终态一次性，不留二次点击）。
 */

const SECTIONS = ['现场', '诊断', '根因', '修复', '教训'] as const

export function CaseCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcCaseCardData
  const rt = d.retire
  const retired = d.status === 'superseded'
  const retireCommitted = rt?.status === 'committed'

  const retireStatus = rt
    ? rt.status === 'queued'
      ? `退役 ${kcTaskStateLabel({ status: rt.status, position: rt.position })}`
      : rt.status === 'running'
        ? '退役入队执行中…'
        : rt.status === 'committed'
          ? '退役已提交'
          : `退役失败 ${rt.error?.code ?? ''}`
    : null

  const status = retired
    ? '已退役'
    : d.status === 'distilled'
      ? `已蒸馏 ${d.ruleRef ?? ''}`
      : retireStatus ?? (d.action === 'merged' ? `自动并档 ×${d.occurrences} 次命中` : '自动入档 ✓')

  const tone = retired ? 'default' : rt?.status === 'failed' ? 'danger' : d.status === 'distilled' ? 'ok' : 'warn'

  return (
    <CardShell testId="case" title={`⚖️ 判例卡 · ${d.symptom}`} status={status} tone={tone}>
      <CardRow k="来源" v={d.source} tone="muted" />
      <CardRow
        k="计数"
        v={`严重度 ${d.severity} · 命中 ${d.occurrences} 次${d.tags.length > 0 ? ` · tags ${d.tags.join("/")}` : ""}`}
      />
      {rt?.status === 'failed' && (
        <CardRow k="错误" v={`${rt.error?.code ?? 'FAILED'}: ${rt.error?.message ?? ''}`} tone="danger" />
      )}
      <div className="mt-1 space-y-1 border-t border-dashed border-pop-bd pt-1">
        {SECTIONS.map(s => (
          <div key={s} className="leading-relaxed" data-testid={`kc-case-section-${s}`}>
            <span className="font-black text-pop-cyan">{s}</span>
            <span className="ml-1 text-pop-ink">{d.sections?.[s] ?? '（该段缺失——入库结构闸外显）'}</span>
          </div>
        ))}
      </div>
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => ctx.openPage(d.path)} testId="kc-case-open">看判例页</KcBtn>
        {!retired && !retireCommitted && (
          <KcBtn
            tone="no"
            disabled={rt?.status === 'queued' || rt?.status === 'running'}
            onClick={() => ctx.retireCase(d.caseId)}
            testId="kc-case-retire"
          >
            退役（superseded）
          </KcBtn>
        )}
        <KcBtn
          tone="pri"
          onClick={() => ctx.sayToCurator(`改写判例 ${d.caseId}（${d.symptom}，${d.path}）：`)}
          testId="kc-case-ask-curator"
        >
          对策展人说（改写/退役理由）
        </KcBtn>
      </CardBtnRow>
    </CardShell>
  )
}
