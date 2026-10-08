// packages/web-app/components/tasks/acceptance/round-diff-panel.tsx
//
// 验货台「实物」卡（acceptance v2）— the awaiting round's REAL git change
// range rendered from the server-resolved commit pair (start..end). This is
// the anti-narration surface: numstat/patches come from the object store, not
// from anything the agent wrote.
//
// 票 03 起本文件只剩「走查面」的 Box 包装（折叠把手 / 口径开关 / 卡片头），
// 统计条·目录组·文件行·双行号 patch 全部住进 files-tab/diff-view.tsx ——
// 「≡ 变更」页签与本卡同一套件、同一份数据契约（shared 单源，禁止复印）。

"use client"

import { FoldHandle, useFold } from "../fold-context"
import { Spinner } from "@/components/ui/spinner"
import type { RoundDiffPayload } from "@/lib/tasks-api"
import { DiffUnavailable, RepoSection, StatStrip } from "../files-tab/diff-view"

interface RoundDiffPanelProps {
  taskId: string
  diff: RoundDiffPayload | null
  loading: boolean
  error: string | null
  onRetry: () => void
  /** 实物口径（B 档/server S3）：round = 本轮增量（缺省）；cumulative = 本 phase 累计。 */
  scope?: "round" | "cumulative"
  onScopeChange?: (s: "round" | "cumulative") => void
  /** round-1 时两口径同物 → 不出开关。 */
  canCumulative?: boolean
  /** 当前待验收轮号（开关 title 用）。 */
  roundIndex?: number | null
}

export function RoundDiffPanel({ taskId, diff, loading, error, onRetry, scope = "round", onScopeChange, canCumulative, roundIndex }: RoundDiffPanelProps) {
  const fold = useFold()
  const closed = fold ? fold.closed("item-diff", "info") : false
  if (loading && !diff) {
    return (
      <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground" data-testid="round-diff-loading">
        <Spinner className="size-3.5" /> 读取实物提交区间…
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-4 text-[11px]" data-testid="round-diff-error">
        <div className="text-pop-red">实物读取失败：{error}</div>
        <button className="mt-1 underline underline-offset-2" onClick={onRetry}>重试</button>
      </div>
    )
  }
  if (!diff) return null

  if (!diff.available) return <DiffUnavailable diff={diff} />

  return (
    <div className="overflow-hidden rounded-[13px] border-[1.5px] border-pop-bd bg-pop-paper shadow-pop-sm" data-testid="round-diff-card" data-fold-box="item-diff" data-fold-closed={closed ? "true" : undefined}>
      <div className="flex items-center gap-2 border-b-[1.5px] border-pop-bd px-3 py-2">
        {fold && <FoldHandle id="item-diff" closed={closed} onToggle={() => fold.toggle("item-diff", "info")} />}
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">项目代码的变动</span>
        {canCumulative && !closed && (
          <span className="flex overflow-hidden rounded-full border-[1.5px] border-pop-bd font-mono text-[9px] font-black" data-testid="round-diff-scope">
            {(["round", "cumulative"] as const).map((s) => (
              <button
                key={s}
                onClick={() => onScopeChange?.(s)}
                aria-selected={scope === s}
                title={s === "round" ? `本轮增量（R${roundIndex ?? "?"}）` : "本 phase 累计实物（首轮起）—— 放行的是终态，不只看这一轮"}
                className={`px-2 py-px transition-colors ${
                  scope === s ? "border-pop-navy bg-pop-navy text-pop-ink" : "border-pop-bd bg-pop-paper text-pop-dim hover:text-pop-ink"
                }`}
                data-testid={`round-diff-scope-${s}`}
              >
                {s === "round" ? "本轮" : "累计"}
              </button>
            ))}
          </span>
        )}
        {closed ? (
          <span className="truncate font-mono text-[10px] font-black text-pop-cyan" data-fold-badge="item-diff">
            {diff.aggregate.commits} 提交 · +{diff.aggregate.additions} −{diff.aggregate.dels} · {diff.aggregate.files} 文件
          </span>
        ) : (
          <span className="ml-auto font-mono text-[9.5px] text-pop-dim" data-testid="round-diff-scope-label">
            {scope === "cumulative" ? "全 phase 累计 · " : ""}{diff.repos.length} 仓
          </span>
        )}
      </div>
      {!closed && (
        <div className="space-y-3 p-3">
          <StatStrip diff={diff} />
          {diff.repos.map((repo) => (
            <RepoSection key={repo.name} taskId={taskId} repo={repo} />
          ))}
        </div>
      )}
    </div>
  )
}
