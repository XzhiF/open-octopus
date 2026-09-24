// packages/web-app/components/tasks/acceptance/round-diff-panel.tsx
//
// 验货台「实物」tab (acceptance v2) — the awaiting round's REAL git change
// range rendered from the server-resolved commit pair (start..end). This is
// the anti-narration surface: numstat/patches come from the object store, not
// from anything the agent wrote. Line-coloring pattern copied from
// components/agent/clone/VersionDiff.tsx (+绿/-红/@@青); chunky Box-card
// styling per run-console/phase-surface Box.

"use client"

import { FoldHandle, useFold } from "../fold-context"
import { useCallback, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal, Layers } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { getRoundPatch, type RoundDiffPayload, type RepoDiff, type DiffFile } from "@/lib/tasks-api"

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

  if (!diff.available) {
    return (
      <div
        className="m-3 rounded-[13px] border-[1.5px] border-pop-bd bg-pop-amber-soft p-5 text-xs space-y-1.5"
        data-testid="round-diff-expired"
      >
        <div className="flex items-center gap-2 font-black">
          <AlertTriangle className="size-4 text-pop-amber" /> 实物不可得
        </div>
        <p className="text-pop-ink">
          {diff.reason === "no_workspace"
            ? "任务工作区已不在 — diff 依赖的 git 目录丢失。"
            : "本轮的提交对象不可达（仓库/对象库被动过）— 无法出示实物 diff。"}
        </p>
        <p className="text-[10px] text-muted-foreground">
          历史复检输出与 verdict 仍可看（复检块），但请知情：此时验收只剩转述。
        </p>
        {diff.repos.some((r) => r.expired) && (
          <ul className="pt-1 font-mono text-[10px] text-muted-foreground">
            {diff.repos.filter((r) => r.expired).map((r) => (
              <li key={r.name}>{r.name} · {r.reason}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

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

// ── stat strip：五个 chunky tile ────────────────────────────────────────

function StatStrip({ diff }: { diff: RoundDiffPayload }) {
  const expiredRepos = diff.repos.filter((r) => r.expired).length
  const tiles: Array<{ label: string; value: string; tone: string }> = [
    { label: "提交", value: String(diff.aggregate.commits), tone: "text-pop-ink" },
    { label: "新增行", value: `+${diff.aggregate.additions}`, tone: "text-pop-green" },
    { label: "删除行", value: `−${diff.aggregate.dels}`, tone: "text-pop-red" },
    { label: "文件", value: String(diff.aggregate.files), tone: "text-pop-cyan" },
    {
      label: "harness 干预",
      value: diff.interventions == null ? "—" : String(diff.interventions),
      tone: diff.interventions ? "text-pop-amber" : "text-pop-dim",
    },
  ]
  return (
    <div className="grid grid-cols-5 gap-1.5" data-testid="round-diff-strip">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[10px] border-[1.5px] border-pop-bd bg-pop-paper shadow-pop-sm px-2 py-1.5 text-center">
          <div className={`font-mono text-[15px] font-black tabular-nums leading-none ${t.tone}`} data-acceptance-stat={t.label}>
            {t.value}
          </div>
          <div className="mt-1 font-mono text-[8.5px] font-black tracking-[.09em] text-pop-dim">{t.label}</div>
        </div>
      ))}
      {expiredRepos > 0 && (
        <div className="col-span-5 -mt-1 font-mono text-[9.5px] font-black text-pop-amber" data-testid="round-diff-partial-expired">
          ⏳ {expiredRepos} 个仓库实物已过期，仅统计可达部分
        </div>
      )}
      {diff.repos.some((r) => r.truncated) && (
        <div className="col-span-5 -mt-1 font-mono text-[9.5px] text-muted-foreground">
          文件数超出展示上限 — 汇总行数为截断前值
        </div>
      )}
    </div>
  )
}

// ── repo 节：目录组折叠 + 文件行 + 懒拉 patch ───────────────────────────

function RepoSection({ taskId, repo }: { taskId: string; repo: RepoDiff }) {
  // 默认展开判据：小仓库全开；大仓库默认折叠、点击展开(overrides 记录在 map)。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const isGroupOpen = (g: { dir: string }) => overrides[g.dir] ?? repo.files <= 25
  if (repo.expired) {
    return (
      <div className="rounded-[13px] border-[1.5px] border-dashed border-pop-bd p-3 text-[11px] text-muted-foreground font-mono">
        {repo.name} · ⏳ {repo.reason}
      </div>
    )
  }
  return (
    <div className="rounded-[13px] border-[1.5px] border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden" data-testid={`round-diff-repo-${repo.name}`}>
      <div className="flex items-center gap-2 border-b-[1.5px] border-pop-bd px-3 py-2">
        <GitCommitHorizontal className="size-3.5 text-pop-dim" />
        <span className="font-mono text-[11px] font-black">{repo.name}</span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-pop-dim">
          {repo.commits} commits · {repo.files} files · <span className="text-pop-green">+{repo.additions}</span>{" "}
          <span className="text-pop-red">−{repo.dels}</span>
        </span>
      </div>
      {repo.groups.map((g) => {
        const open = isGroupOpen(g)
        return (
          <div key={g.dir} data-testid={`round-diff-group-${repo.name}-${g.dir}`}>
            <button
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-pop-idle"
              onClick={() => setOverrides((prev) => ({ ...prev, [g.dir]: !open }))}
            >
              {open ? <ChevronDown className="size-3 text-pop-dim" /> : <ChevronRight className="size-3 text-pop-dim" />}
              <Layers className="size-3 text-pop-dim" />
              <span className="font-mono text-[10.5px] font-black">{g.dir}/</span>
              <span className="ml-auto font-mono text-[9px] tabular-nums text-pop-dim">
                {g.files.length} · <span className="text-pop-green">+{g.additions}</span> <span className="text-pop-red">−{g.dels}</span>
              </span>
            </button>
            {open && g.files.map((f) => (
              <DiffFileRow key={`${repo.name}:${f.path}`} taskId={taskId} repo={repo.name} file={f} />
            ))}
          </div>
        )
      })}
      {repo.files === 0 && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground">本轮在该仓库零变更（区间相等/无提交）。</div>
      )}
    </div>
  )
}

function DiffFileRow({ taskId, repo, file }: { taskId: string; repo: string; file: DiffFile }) {
  const [open, setOpen] = useState(false)
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (next && patch == null && !loading && !file.binary) {
      setLoading(true)
      setErr(null)
      getRoundPatch(taskId, repo, file.path)
        .then((r) => setPatch({ text: r.patch, truncated: r.truncated }))
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    }
  }, [open, patch, loading, file.binary, taskId, repo, file.path])

  const statusTone = file.status === "A" ? "text-pop-green" : file.status === "D" ? "text-pop-red" : file.status === "R" ? "text-pop-cyan" : "text-pop-amber"

  return (
    <div className="border-t border-pop-bd">
      <button
        className="flex w-full items-center gap-2 px-3 py-1 pl-7 text-left hover:bg-pop-idle"
        onClick={toggle}
        data-acceptance-diff-row={`${repo}:${file.path}`}
      >
        {open ? <ChevronDown className="size-3 shrink-0 text-pop-dim" /> : <ChevronRight className="size-3 shrink-0 text-pop-dim" />}
        <FileCode2 className="size-3 shrink-0 text-pop-dim" />
        <span className="truncate font-mono text-[11px]">{file.path}</span>
        {file.oldPath && (
          <span className="shrink-0 font-mono text-[9px] text-pop-cyan line-through">{file.oldPath.split("/").pop()}</span>
        )}
        <span className={`shrink-0 rounded-full border-[1.5px] border-pop-bd px-1 py-px font-mono text-[8.5px] font-black ${statusTone}`}>
          {file.status}
        </span>
        {file.binary ? (
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground">binary</span>
        ) : (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <span className="text-pop-green">+{file.adds}</span> <span className="text-pop-red">−{file.dels}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2">
          {file.binary ? (
            <div className="rounded-md border-[1.5px] border-pop-bd bg-muted/30 p-2 font-mono text-[10px] text-muted-foreground">
              二进制文件 — 不出 patch（存在性即证据）。
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 p-2 text-[11px] text-muted-foreground"><Spinner className="size-3" /> 拉取 patch…</div>
          ) : err ? (
            <div className="p-2 text-[11px] text-pop-red">{err}</div>
          ) : patch ? (
            <PatchBlock patch={patch} />
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Unified-diff 行着色（VersionDiff.tsx:54-60 同款语义，行高更紧）。 */
function PatchBlock({ patch }: { patch: { text: string; truncated: boolean } }) {
  const lines = useMemo(() => patch.text.split("\n"), [patch.text])
  return (
    <div className="rounded-md border-[1.5px] border-pop-bd bg-pop-paper" data-testid="round-diff-patch">
      <pre className="p-2 font-mono text-[10.5px] leading-[1.5]">
        {lines.map((l, i) => {
          let cls = "text-pop-ink/70"
          if (l.startsWith("+") && !l.startsWith("+++")) cls = "bg-pop-green-soft text-pop-green"
          else if (l.startsWith("-") && !l.startsWith("---")) cls = "bg-pop-pink-soft text-pop-red"
          else if (l.startsWith("@@")) cls = "bg-pop-cyan-soft text-pop-cyan"
          else if (l.startsWith("diff ") || l.startsWith("index ")) cls = "text-pop-dim font-black"
          return (
            <div key={i} className={`whitespace-pre-wrap break-all px-1 ${cls}`}>{l || " "}</div>
          )
        })}
        {patch.truncated && (
          <div className="px-1 pt-1 font-black text-pop-amber">[…patch 超 512K 已截断 — 完整内容请在批次目录/仓库侧查看]</div>
        )}
      </pre>
    </div>
  )
}
