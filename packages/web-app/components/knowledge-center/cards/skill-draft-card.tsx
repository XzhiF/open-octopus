'use client'

import { MarkdownPreview } from '@/components/resource/MarkdownPreview'
import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcSkillDraftCardData } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'

/**
 * 🧪 skill 草案卡（P3 票04；spec §卡片与 UI「skill 草案卡（SKILL.md 渲染+目标分身选择+
 * 授予/撤销钮+版本回执）」的**本票半张**——票面第 3 行逐字=「SKILL.md 完整渲染
 * （name/description/触发条件/步骤/纪律）+ 来源指针可点」。
 *
 * 红线4 边界：本卡**没有**目标分身选择器、没有授予/撤销钮、没有版本回执位——
 * 生效链 UI 是票05 在同一 kind 上的扩展位（卡 data 三态字段已留）。
 * 红线3 边界：status 三值 draft|granted|revoked，无 pending 徽标位——
 * 草案的「人裁」是授予治理，对话改写走「对策展人说」取号器（确定性改写端点
 * POST /drafts/:name/revise 由策展人/卡动作经 API 触发，本卡给意图半腿）。
 * 终态（granted/revoked）改写钮退场（finding/判例卡同律）。
 */

const ORIGIN_LABEL: Record<string, string> = {
  'sequence-similar': '跨task序列相似',
  'case-procedural': '判例流程型',
  'curator-proposal': '策展提议',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草案待人裁',
  granted: '已授予（票05 治理面）',
  revoked: '已退役',
}

export function SkillDraftCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcSkillDraftCardData
  const refs = d.sourceRefs ?? []
  const caseRef = refs.find(r => r.kind === 'case')
  const packRefs = refs.filter(r => r.kind === 'pack')
  const revisable = d.status === 'draft'

  return (
    <CardShell
      testId="skill-draft"
      title={`🧪 skill 草案 · ${d.draftName}`}
      status={STATUS_LABEL[d.status] ?? `状态 ${d.status}`}
      tone={d.status === 'draft' ? 'warn' : d.status === 'granted' ? 'ok' : 'default'}
    >
      <CardRow k="名称" v={d.description} />
      <CardRow
        k="来源"
        v={`${ORIGIN_LABEL[d.origin] ?? d.origin} · ${d.source}${typeof d.similarity === 'number' ? `（相似 ${d.similarity.toFixed(2)}）` : ''}${d.ruleRef ? ` · 规则锚 ${d.ruleRef}` : ''}`}
        tone="muted"
      />
      <div className="mt-1 rounded border border-dashed border-pop-bd bg-pop-paper p-1.5" data-testid="kc-skl-preview">
        <MarkdownPreview content={d.content ?? ''} />
      </div>
      <CardBtnRow>
        {packRefs.map((r) => (
          <KcBtn
            key={r.pointer}
            tone="cy"
            testId={`kc-skl-raw-${refs.indexOf(r)}`}
            onClick={() => ctx.openRaw(r.pointer)}
          >
            开原文 {r.label}
          </KcBtn>
        ))}
        {caseRef && (
          <KcBtn tone="cy" testId="kc-skl-case" onClick={() => ctx.openPage(caseRef.pointer)}>
            看判例页
          </KcBtn>
        )}
        {revisable && (
          <KcBtn
            tone="pri"
            testId="kc-skl-say"
            onClick={() => ctx.sayToCurator(`改写草案 ${d.draftName}（${d.skillPath}）：`)}
          >
            对策展人说（改写草案）
          </KcBtn>
        )}
      </CardBtnRow>
    </CardShell>
  )
}
