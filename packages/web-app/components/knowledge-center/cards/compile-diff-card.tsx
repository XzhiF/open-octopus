'use client'

import { useState } from 'react'
import { CardShell, CardRow, CardBtnRow, KcBtn } from './card-shell'
import { shortHash, kcTaskStateLabel } from '@/lib/knowledge-center/card-protocol'
import type { KcCardViewProps } from './registry'
import type { KcCompileDiffCardData } from '@/lib/knowledge-center/card-protocol'

/** 触及页按类分组计数（原型 diff 卡「触及 12 页 = 实体×3 · 概念×2 …」行的值半）。 */
export function touchedSummary(touched: KcCompileDiffCardData['touched']): string {
  if (touched.length === 0) return '排队/编译中…（完成后展开触及明细）'
  const byType = new Map<string, number>()
  for (const t of touched) byType.set(t.type ?? '页', (byType.get(t.type ?? '页') ?? 0) + 1)
  const label: Record<string, string> = { entity: '实体', concept: '概念', topic: '主题', source: '来源', case: '判例' }
  const parts = [...byType.entries()].map(([ty, n]) => `${label[ty] ?? ty}×${n}`)
  return `${touched.length} 页 = ${parts.join(' · ')}`
}

/**
 * ⚙️ 编译 diff 卡 — 每次编译 commit 后（AC2/AC3 主卡 + AC5 回滚钮宿主）。
 * 流式状态带（AC3 故事11）：排队中 #N → 编译中 → 已提交 hash（票06 位次 API 喂 position）。
 * 回滚交互纪律（票面 AC5）：点「回滚本次编译」→ 原地二次确认 → ctx.revert(commit)，
 * 回滚任务状态回灌到本卡 data.revert（queued #N → running → committed 已回滚 hash /
 * failed 显形 LOCK_HELD|WORKTREE_DIRTY——票02 后 REVERT_CONFLICT 已废）。
 */
export function CompileDiffCard({ event, ctx, archive }: KcCardViewProps & { archive?: boolean }) {
  const d = event.data as KcCompileDiffCardData
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const revertFailed = d.revert?.status === 'failed'
  const tone = revertFailed || d.status === 'failed'
    ? 'danger'
    : (d.contradictions ?? 0) > 0
      ? 'warn'
      : d.revert?.status === 'committed'
        ? 'ok'
        : 'default'
  const statusText = d.revert
    ? d.revert.status === 'committed'
      ? `已回滚 ${shortHash(d.revert.revertCommit)}`
      : d.revert.status === 'failed'
        ? `回滚失败 ${d.revert.error?.code ?? ''}`
        : kcTaskStateLabel({ status: d.revert.status, position: d.revert.position, verb: 'revert' })
    : kcTaskStateLabel({ status: d.status, position: d.position, hash: d.commit })

  return (
    <CardShell
      testId={archive ? 'archive-compile' : 'compile-diff'}
      title={archive ? `📦 归档编译卡 · ${(d as { taskLabel?: string }).taskLabel ?? d.rawTitle ?? '归档'}` : `⚙️ 编译 DIFF 卡${d.commit ? ` · commit ${shortHash(d.commit)}` : ''}`}
      status={statusText}
      tone={tone}
    >
      {d.rawPath && <CardRow k="raw" v={d.rawPath} tone="muted" />}
      <CardRow k="触及" v={touchedSummary(d.touched)} />
      {(d.created ?? 0) > 0 && <CardRow k="新页" v={`${d.created} 页${d.updated ? ` · 更新 ${d.updated}` : ''}`} />}
      {(d.contradictions ?? 0) > 0 && <CardRow k="冲突" v={`${d.contradictions}（矛盾标记，待裁决——finding 卡票13 接位）`} tone="warn" />}
      {d.status === 'committed' && d.ftsOk !== false && <CardRow k="FTS / DB" v="同步 ✓" tone="muted" />}
      {d.status === 'failed' && <CardRow k="错误" v={`${d.error?.code ?? 'FAILED'}: ${d.error?.message ?? ''}`} tone="danger" />}

      {expanded && d.touched.length > 0 && (
        <div className="mt-1 space-y-0.5 border-l-[1.5px] border-pop-bd pl-2" data-testid="kc-diff-pages">
          {d.touched.map(t => (
            <button
              key={t.path}
              type="button"
              onClick={() => ctx.openPage(t.path)}
              className="block w-full text-left text-[11px] text-pop-cyan hover:underline"
            >
              {t.created ? '＋' : '✎'} {t.path}
            </button>
          ))}
        </div>
      )}

      <CardBtnRow>
        {d.touched.length > 0 && (
          <KcBtn tone="cy" onClick={() => setExpanded(v => !v)} testId="kc-diff-expand">{expanded ? '收起 diff' : '展开 diff'}</KcBtn>
        )}
        {d.status === 'committed' && d.commit && !d.revert && (
          confirming ? (
            <>
              <KcBtn tone="no" onClick={() => { setConfirming(false); ctx.revert(d.commit!) }} testId="kc-revert-confirm">确认回滚（状态重建单 commit）</KcBtn>
              <KcBtn onClick={() => setConfirming(false)} testId="kc-revert-cancel">取消</KcBtn>
            </>
          ) : (
            <KcBtn tone="no" onClick={() => setConfirming(true)} testId="kc-revert-arm">回滚本次编译</KcBtn>
          )
        )}
        {d.revert && d.revert.status !== 'committed' && (
          <span className="text-[11px] font-bold text-pop-amber" data-testid="kc-revert-progress">
            {d.revert.status === 'failed'
              ? `回滚失败：${d.revert.error?.code ?? ''}（${d.revert.error?.message ?? ''}）`
              : `回滚${d.revert.status === 'queued' ? `排队中${typeof d.revert.position === 'number' ? ` #${d.revert.position}` : ''}` : '中'}…`}
          </span>
        )}
        {d.touched.length > 0 && (
          <KcBtn onClick={() => ctx.openPage(d.touched.find(t => t.created)?.path ?? d.touched[0].path)} testId="kc-diff-view-page">在主场看页</KcBtn>
        )}
        {archive && d.commit && (
          <KcBtn tone="pri" onClick={() => ctx.sayToCurator(`关于归档编译 ${shortHash(d.commit)}，我想说：`)} testId="kc-archive-say">对策展人说</KcBtn>
        )}
      </CardBtnRow>
    </CardShell>
  )
}
