'use client'

import { useState } from 'react'
import { MarkdownPreview } from '@/components/resource/MarkdownPreview'
import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcSkillDraftCardData, SkillGrantReceipt } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'

/**
 * 🧪 skill 草案卡（P3 票04 半张 + 票05 授予半张；spec §卡片与 UI 逐字
 * 「skill 草案卡（SKILL.md 渲染+目标分身选择+授予/撤销钮+版本回执）」）。
 *
 * 票05 补全位（票04 注释明示的扩展位，同 kind 同 data）：
 *  - 目标分身选择器：数据源=既有 `GET /api/clones`（宿主 ctx.grantTargets，零新端点）
 *    + 固定项「所有分身（共享层）」（cloneName='*'，ADR-0005 两层模型的共享轨）；
 *  - 授予/撤销钮：选中目标 ∉ grantedTo ⇒ [授予→]；∈ ⇒ [撤销⇐]（同目标二选一，
 *    并授走 union 再点另一目标）；revoked 终态钮全退场（finding/判例卡同律）；
 *  - 版本回执面：Lane A 沉淀卡的 data.receipt + 本地覆盖层 data.grant.receipt
 *    （use-kc-grants 点击即时显形，重发后 Lane A 接管）——分身名/版本号/预置源
 *    同步结果逐字段（spec 故事 23）；失败显形不伪造（error 行按 code 报，granted
 *    徽标不提前亮起）。
 *
 * 红线3：无审批态——钮即人裁治理动作（点一下=授予决定，零队列零 pending 徽标）。
 * 红线4：卡与钮全程不触 prompt——生效链在 server 机械链（目录/upgrade 原语/版本），
 * 本卡只读回执不注入文本。
 */

const ORIGIN_LABEL: Record<string, string> = {
  'sequence-similar': '跨task序列相似',
  'case-procedural': '判例流程型',
  'curator-proposal': '策展提议',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草案待人裁',
  granted: '已授予',
  revoked: '已退役',
}

/** 「所有分身（共享层）」固定项（cloneName='*'——server GRANT_TARGET_ALL 同值）。 */
const ALL_TARGET = "*"

function targetLabel(name: string, targets: Array<{ name: string; display_name: string }>): string {
  if (name === ALL_TARGET) return "所有分身（共享层）"
  return targets.find(t => t.name === name)?.display_name ?? name
}

function receiptText(r: SkillGrantReceipt, targets: Array<{ name: string; display_name: string }>): string {
  const parts = [
    `目标 ${targetLabel(r.target, targets)}(${r.target})`,
    r.version ? `版本 ${r.version}${r.published ? "（已发布现行版）" : ""}` : "版本 —（未走版本账）",
    `预置源 ${r.presetSync.ok ? "已同步" : "异常"}${r.presetSync.detail ? `：${r.presetSync.detail}` : ""}`,
  ]
  if (r.rolledBackTo) parts.push(`已回退至 ${r.rolledBackTo}`)
  if (r.idempotent) parts.push("幂等重放（零新发版）")
  return parts.join(" · ")
}

export function SkillDraftCard({ event, ctx }: KcCardViewProps) {
  const d = event.data as KcSkillDraftCardData
  const refs = d.sourceRefs ?? []
  const caseRef = refs.find(r => r.kind === 'case')
  const packRefs = refs.filter(r => r.kind === 'pack')
  const revisable = d.status === 'draft'
  const grantable = d.status === 'draft' || d.status === 'granted'

  const targets = ctx.grantTargets ?? []
  const overlay = d.grant
  // 授予清单真相链：本地覆盖层回执（刚点完）> Lane A 沉淀（服务端重发卡）
  const granted = overlay?.receipt?.grantedTo ?? d.grantedTo ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const currentTarget = picked && (picked === ALL_TARGET || targets.some(t => t.name === picked))
    ? picked
    : (targets[0]?.name ?? ALL_TARGET)
  const alreadyGranted = granted.includes(currentTarget)
  const busy = overlay?.pending === true
  const receipt = overlay?.receipt ?? d.receipt

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
      {granted.length > 0 && (
        <CardRow
          k="已授予"
          v={granted.map(g => `${targetLabel(g, targets)}(${g})`).join("、")}
        />
      )}
      <div className="mt-1 rounded border border-dashed border-pop-bd bg-pop-paper p-1.5" data-testid="kc-skl-preview">
        <MarkdownPreview content={d.content ?? ''} />
      </div>
      {(receipt !== undefined || overlay?.error) && (
        <div data-testid="kc-skl-receipt">
          <CardRow k="回执" v={overlay?.error && !receipt ? `失败：${overlay.error}` : `${receiptText(receipt!, targets)}${overlay?.error ? `（${overlay.error}）` : ""}`} tone={overlay?.error ? "danger" : "muted"} />
        </div>
      )}
      {overlay?.error && (
        <div data-testid="kc-skl-grant-error" className="text-[10px] font-bold text-pop-red">{overlay.error}</div>
      )}
      {/* aa-fix 项6：分身清单拉败≠确无分身——服务不可达必须显形（选择器仅剩固定项是降级不是事实） */}
      {ctx.grantTargetsError && (
        <div data-testid="kc-skl-target-error">
          <CardRow k="分身清单" v={`拉取失败：${ctx.grantTargetsError}（服务不可达≠确无分身；选择器仅「所有分身（共享层）」固定项可信）`} tone="danger" />
        </div>
      )}
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
        {grantable && (
          <select
            data-testid="kc-skl-target"
            aria-label="目标分身"
            className="rounded border border-pop-bd bg-pop-paper px-1 py-0.5 text-[10px]"
            value={currentTarget}
            onChange={(e) => setPicked(e.target.value)}
            disabled={busy}
          >
            {targets.map(t => (
              <option key={t.name} value={t.name}>
                {t.display_name}({t.name}){granted.includes(t.name) ? " ·已授" : ""}
              </option>
            ))}
            <option value={ALL_TARGET}>所有分身（共享层）</option>
          </select>
        )}
        {grantable && !alreadyGranted && (
          <KcBtn
            tone="pri"
            testId="kc-skl-grant"
            disabled={busy || !ctx.grantDraft}
            onClick={() => ctx.grantDraft?.(d.draftName, currentTarget)}
          >
            {busy ? "授予中…" : `授予→ ${targetLabel(currentTarget, targets)}`}
          </KcBtn>
        )}
        {grantable && alreadyGranted && (
          <KcBtn
            tone="no"
            testId="kc-skl-revoke"
            disabled={busy || !ctx.revokeDraft}
            onClick={() => ctx.revokeDraft?.(d.draftName, currentTarget)}
          >
            {busy ? "撤销中…" : `撤销⇐ ${targetLabel(currentTarget, targets)}`}
          </KcBtn>
        )}
      </CardBtnRow>
    </CardShell>
  )
}
