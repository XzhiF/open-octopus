'use client'

import { useState } from 'react'
import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import type { KcCardViewProps } from './registry'
import type { KcGuardCardData } from '@/lib/knowledge-center/card-protocol'

/**
 * ⛔ 写保护卡 — 触到人工文件（SCHEMA.md）的修改意图（原型卡目录末行）。
 * 语义纪律：**建议文本 + 人工确认步骤，零自动落盘**。卡上所有钮只改本地展开态，
 * 无任何 ctx 写调用；硬闸在服务层路径级拒写（server `wiki/manual-files.ts`，
 * MANUAL_FILE_WRITE），wiki 仓 pre-commit 为纵深防御——行为测试已钉：
 * `packages/server/src/services/knowledge/wiki/__tests__/wiki-write-gate.test.ts`。
 */
export function GuardCard({ event }: KcCardViewProps) {
  const d = event.data as KcGuardCardData
  const [open, setOpen] = useState(false)
  return (
    <CardShell testId="guard" title={`⛔ 写保护卡 · ${d.target}（人工文件）`} status="AI 不改写" tone="warn">
      <CardRow k="意图" v={d.intent} />
      <CardBtnRow>
        <KcBtn tone="cy" onClick={() => setOpen(v => !v)} testId="kc-guard-toggle">{open ? '收起建议' : '查看建议'}</KcBtn>
      </CardBtnRow>
      {open && (
        <div className="mt-1.5 space-y-2 border-l-[1.5px] border-pop-amber pl-2" data-testid="kc-guard-detail">
          <div>
            <div className="text-[10px] font-black text-pop-amber">建议文本（供人工誊改）</div>
            <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-pop-ink">{d.suggestion}</pre>
          </div>
          <div>
            <div className="text-[10px] font-black text-pop-amber">人工确认步骤（永不自动执行）</div>
            <ol className="mt-0.5 list-decimal pl-4 text-pop-ink">
              {d.manualSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        </div>
      )}
    </CardShell>
  )
}
