// packages/web-app/components/tasks/files-tab/files-tab.tsx
//
// 票 03 —— 统一壳「≡ 变更」页签本体：GitHub Files-changed 视图。
//   统计条（提交/文件/+−/harness 干预/成本） · 本轮|累计口径切换 · 文件行
//   （A/M/D/R 徽标 + ±行 + 绿红比例条）点击就地展开双行号 unified diff。
//
// 数据纪律（票文铁律）：零新后端 —— 只用既有 GET /round-diff(+ /patch)。
// round 口径载荷由壳的 useRoundDiffFeed 单源供入（SSE 事件 + 节流 + ≤10s 兜底，
// 票03 起服务端 live 轮也供货）；cumulative 按需另拉、跟同一节拍补新。
// 呈现件与走查面「实物」卡同一套（files-tab/diff-view）—— 票 05/09 台账口径
// 通过 scopeTotals 与本条同源。
// 票 07 契约：`rowDecor`（💬chat 徽标渲染位）+ `toolbarExtra`（chat 计数 chip 位），
// 07 挂对话页签时把这两枚传进来即可，不必复制行组件。

"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Spinner } from "@/components/ui/spinner"
import { getRoundDiff, type RoundDiffPayload } from "@/lib/tasks-api"
import type { RoundDiffFeed } from "./use-round-diff-feed"
import { matchReveal, scopeTotals, type RevealTarget } from "./files-tab-model"
import { DiffUnavailable, RepoSection, StatStrip, type FileRowDecor } from "./diff-view"

export interface FilesTabProps {
  taskId: string
  /** 壳的单源 round 载荷（含节流轮询/事件触发节拍 —— 头栏 commits 也吃它）。 */
  feed: RoundDiffFeed
  /** 当前状态可供货吗（running/paused/awaiting_review；其余如实空置）。 */
  serving: boolean
  /** live 态（显示「≤10s 自动同步」指示 + 零提交预告）。 */
  isLive: boolean
  /** 成本统计位（壳的 llm-calls 聚合，"$0.42" 口径；null/undefined = 不铺该格）。 */
  costText?: string | null
  rowDecor?: FileRowDecor
  toolbarExtra?: ReactNode
  /** 票 07「查看 diff」跳链：工具卡路径（工作区绝对/相对均可）+ nonce —— 每次点击
   *  nonce 递增重触发揭示（展开目标行 + 青闪 1.6s，原型 jumpToDiff 语义）。 */
  reveal?: { path: string; nonce: number } | null
}

export function FilesTab({ taskId, feed, serving, isLive, costText, rowDecor, toolbarExtra, reveal }: FilesTabProps) {
  const [scope, setScope] = useState<"round" | "cumulative">("round")
  const [cum, setCum] = useState<RoundDiffPayload | null>(null)
  const [cumLoading, setCumLoading] = useState(false)
  const [cumError, setCumError] = useState<string | null>(null)
  const [cumReload, setCumReload] = useState(0)

  // 累计口径：按需拉，跟 round 的 nonce 同一节拍补新（票03 刷新动线只开一闸）。
  useEffect(() => {
    if (!serving || scope !== "cumulative") return
    let cancelled = false
    setCumLoading(true)
    setCumError(null)
    getRoundDiff(taskId, "cumulative")
      .then((d) => { if (!cancelled) setCum(d) })
      .catch((e: unknown) => { if (!cancelled) setCumError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setCumLoading(false) })
    return () => { cancelled = true }
  }, [serving, scope, taskId, feed.nonce, cumReload])

  const diff = scope === "round" ? feed.data : cum
  const loading = scope === "round" ? feed.loading : cumLoading
  const error = scope === "round" ? feed.error : cumError
  const stats = scopeTotals(diff)
  // 票 07 跳链定位（纯函数单源）：工具卡路径 → 在场载荷里的 {repo, path}。
  const revealTarget: RevealTarget | null = reveal ? matchReveal(diff, reveal.path) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-tab">
      {/* 工具行：口径段 · 同步指示 · 07 徽标位 · 数据源诚实标注 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-3 py-2 font-mono text-[10px]" data-testid="files-tab-toolbar">
        <span className="flex overflow-hidden rounded-full border-[1.5px] border-pop-bd font-mono text-[9.5px] font-black" data-testid="files-tab-scope">
          {(["round", "cumulative"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              aria-selected={scope === s}
              title={s === "round" ? "本轮增量（当前/待验收轮的实物区间）" : "本 phase 累计实物（首轮起）"}
              className={`px-2.5 py-px transition-colors ${
                scope === s ? "border-pop-navy bg-pop-navy text-pop-ink" : "bg-pop-paper text-pop-dim hover:text-pop-ink"
              }`}
              data-testid={s === "round" ? "files-tab-scope-round" : "files-tab-scope-cum"}
            >
              {s === "round" ? "本轮" : "累计"}
            </button>
          ))}
        </span>
        {serving && isLive && (
          <span className="flex items-center gap-1 text-pop-cyan" title="SSE 事件触发 + 节流轮询；兜底 ≤10s 一拍（spec 故事9）" data-testid="files-tab-sync">
            <i className="block size-[6px] animate-pulse rounded-full bg-pop-cyan" />≤10s 自动同步 · git diff -M --numstat
          </span>
        )}
        {toolbarExtra}
        <span className="ml-auto text-pop-dim">数据源 GET /api/tasks/:id/round-diff —— 与走查面同源，零新后端</span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!serving ? (
          <div className="mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim" data-testid="files-tab-idle">
            实物 diff 只在<b className="text-pop-ink">执行中与待验收</b>供货 —— 当前没有可出示的轮次。<br />
            轮次开跑（或产出入待验收）后本页自动出数；归档终态后回看走「✓ 走查 / 台账」。
          </div>
        ) : loading && !diff ? (
          <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground" data-testid="files-tab-loading">
            <Spinner className="size-3.5" /> 读取实物提交区间…
          </div>
        ) : error && !diff ? (
          <div className="p-4 text-[11px]" data-testid="files-tab-error">
            <div className="text-pop-red">实物读取失败：{error}</div>
            <button
              className="mt-1 underline underline-offset-2"
              onClick={() => (scope === "round" ? feed.retry() : setCumReload((v) => v + 1))}
              data-testid="files-tab-retry"
            >
              重试
            </button>
          </div>
        ) : diff ? (
          <>
            {error && (
              <div className="rounded-[10px] border-[1.5px] border-pop-bd bg-pop-amber-soft px-3 py-1.5 font-mono text-[10px] font-black text-pop-amber" data-testid="files-tab-stale">
                ⚠ 刷新失败：{error} —— 下方沿上一帧快照
              </div>
            )}
            {diff.available ? (
              <>
                <StatStrip diff={diff} cost={costText} />
                {stats.files === 0 && isLive && scope === "round" && (
                  <div className="rounded-[10px] border-[1.5px] border-dashed border-pop-bd px-3 py-2 text-center font-mono text-[10.5px] text-pop-dim" data-testid="files-tab-empty-live">
                    进行中 · 本轮还没有落第一个 commit —— 新提交落库即自动出现（≤10s）
                  </div>
                )}
                {diff.repos.map((repo) => (
                  <RepoSection
                    key={repo.name}
                    taskId={taskId}
                    repo={repo}
                    rowDecor={rowDecor}
                    reveal={revealTarget && revealTarget.repo === repo.name && reveal ? { path: revealTarget.path, nonce: reveal.nonce } : null}
                  />
                ))}
              </>
            ) : (
              <DiffUnavailable diff={diff} />
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> 读取中…
          </div>
        )}
      </div>
    </div>
  )
}
