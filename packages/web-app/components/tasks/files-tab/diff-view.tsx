// packages/web-app/components/tasks/files-tab/diff-view.tsx
//
// 票 03：实物 diff 的呈现单源 —— 从 acceptance/round-diff-panel.tsx 提升为共享件
// （GitHub Files-changed 语义：统计条 / 目录组 / 文件行 A·M·D·R 徽标 + ±行 + 绿红
// 比例条 / 就地展开 unified diff 双行号 + @@ hunk + 加绿删红）。
// 两个宿主：① 壳的「≡ 变更」页签（整页布局）；② 走查面「实物」卡（折叠 Box 包装，
// round-diff-panel 保留其卡片/折页/口径开关外壳不动）。testid 与 data-* 契约逐字
// 保留（acceptance-surface 回归即钉）。
// 票 07 契约：DiffFileRow 的 `rowDecor(file)` 渲染位 = 💬chat 快改徽标的挂载钩子，
// FilesTab 原样透传，07 不需要再复制行组件。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal, Layers } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { getRoundPatch, type DiffFile, type RepoDiff, type RoundDiffPayload } from "@/lib/tasks-api"
import { addRatio, scopeTotals, sortRepoGroups } from "./files-tab-model"

// ── 统计条（票09 契约：数字与台账预览同源 = scopeTotals）─────────────────

export function StatStrip({ diff, cost }: { diff: RoundDiffPayload; cost?: string | null }) {
  const s = scopeTotals(diff)
  const expiredRepos = diff.repos.filter((r) => r.expired).length
  const tiles: Array<{ label: string; value: string; tone: string }> = [
    { label: "提交", value: String(s.commits), tone: "text-pop-ink" },
    { label: "文件", value: String(s.files), tone: "text-pop-cyan" },
    { label: "新增行", value: `+${s.additions}`, tone: "text-pop-green" },
    { label: "删除行", value: `−${s.dels}`, tone: "text-pop-red" },
    {
      label: "harness 干预",
      value: s.interventions == null ? "—" : String(s.interventions),
      tone: s.interventions ? "text-pop-amber" : "text-pop-dim",
    },
    ...(cost != null ? [{ label: "成本", value: cost, tone: "text-pop-yellow" }] : []),
  ]
  return (
    <div className={`grid ${cost != null ? "grid-cols-6" : "grid-cols-5"} gap-1.5`} data-testid="round-diff-strip">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[10px] border-[1.5px] border-pop-bd bg-pop-paper shadow-pop-sm px-2 py-1.5 text-center">
          <div className={`font-mono text-[15px] font-black tabular-nums leading-none ${t.tone}`} data-acceptance-stat={t.label}>
            {t.value}
          </div>
          <div className="mt-1 font-mono text-[8.5px] font-black tracking-[.09em] text-pop-dim">{t.label}</div>
        </div>
      ))}
      {expiredRepos > 0 && (
        <div className="col-span-full -mt-1 font-mono text-[9.5px] font-black text-pop-amber" data-testid="round-diff-partial-expired">
          ⏳ {expiredRepos} 个仓库实物已过期，仅统计可达部分
        </div>
      )}
      {diff.repos.some((r) => r.truncated) && (
        <div className="col-span-full -mt-1 font-mono text-[9.5px] text-muted-foreground">
          文件数超出展示上限 — 汇总行数为截断前值
        </div>
      )}
    </div>
  )
}

// ── 实物不可得：诚实过期卡（两宿主共用）──────────────────────────────────

export function DiffUnavailable({ diff }: { diff: RoundDiffPayload }) {
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

// ── repo 节：目录组折叠 + 文件行（含 07 徽标渲染位）───────────────────────

export type FileRowDecor = (file: DiffFile) => ReactNode

export function RepoSection({
  taskId, repo, rowDecor, reveal, defaultOpenThreshold = 25,
}: {
  taskId: string
  repo: RepoDiff
  rowDecor?: FileRowDecor
  /** 票 07「查看 diff」：命中的仓相对行 + nonce —— 所在组强制展开，行自动开 + 青闪。 */
  reveal?: { path: string; nonce: number } | null
  /** 小仓库全开；大仓库默认折叠（>threshold 文件/组）。 */
  defaultOpenThreshold?: number
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const isGroupOpen = (g: { dir: string }) => overrides[g.dir] ?? repo.files <= defaultOpenThreshold
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
      {sortRepoGroups(repo.groups).map((g) => {
        const revealInGroup = reveal != null && g.files.some((f) => f.path === reveal.path)
        const open = isGroupOpen(g) || revealInGroup // 跳链目标所在组强制展开（不然行不在场，揭示落空）
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
              <DiffFileRow
                key={`${repo.name}:${f.path}`}
                taskId={taskId}
                repo={repo.name}
                file={f}
                rowDecor={rowDecor}
                revealNonce={reveal && f.path === reveal.path ? reveal.nonce : undefined}
              />
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

export function DiffFileRow({ taskId, repo, file, rowDecor, revealNonce }: {
  taskId: string
  repo: string
  file: DiffFile
  rowDecor?: FileRowDecor
  /** 票 07 跳链命中：本行是揭示目标 —— nonce 每次点击递增重触发（展开 + 1.6s 青闪，
   *  原型 .fitem.flash）。同 nonce 不重放，切页往返不谎闪。 */
  revealNonce?: number
}) {
  const [open, setOpen] = useState(false)
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const seenNonce = useRef(0)

  const loadPatch = useCallback(() => {
    if (patch == null && !loading && !file.binary) {
      setLoading(true)
      setErr(null)
      getRoundPatch(taskId, repo, file.path)
        .then((r) => setPatch({ text: r.patch, truncated: r.truncated }))
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    }
  }, [patch, loading, file.binary, taskId, repo, file.path])

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (next) loadPatch()
  }, [open, loadPatch])

  // nonce 变化（含首次挂载即命中）→ 展开 + 闪一次；同 nonce 重复渲染不再闪。
  useEffect(() => {
    if (revealNonce == null || revealNonce === seenNonce.current) return
    seenNonce.current = revealNonce
    setOpen(true)
    loadPatch()
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1600)
    wrapRef.current?.scrollIntoView?.({ block: "center" })
    return () => clearTimeout(t)
  }, [revealNonce, loadPatch])

  const statusTone = file.status === "A" ? "text-pop-green" : file.status === "D" ? "text-pop-red" : file.status === "R" ? "text-pop-cyan" : "text-pop-amber"

  return (
    <div ref={wrapRef} className={`border-t border-pop-bd${flash ? " pop-flash-row" : ""}`} data-diff-flash={flash ? "true" : undefined}>
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
        {rowDecor?.(file)}
        {file.binary ? (
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground">binary</span>
        ) : (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
            <span className="text-pop-green">+{file.adds}</span> <span className="text-pop-red">−{file.dels}</span>
            {/* 原型 dbar：绿(新增)/红(删除)占比条 —— 一眼看出这行是「写」还是「删」。 */}
            <span
              aria-hidden
              className="inline-block h-1.5 w-9 shrink-0 overflow-hidden rounded-full border-[1px] border-pop-bd bg-pop-pink-soft align-middle"
              data-diff-bar={file.adds + file.dels === 0 ? undefined : `${Math.round(addRatio(file.adds, file.dels) * 100)}`}
            >
              <i className="block h-full bg-pop-green" style={{ width: `${Math.round(addRatio(file.adds, file.dels) * 100)}%` }} />
            </span>
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

// ── unified diff 就地展开：双行号 + @@ 青 + 加绿删红（原型 diffHtml 语义）──

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function classifyPatchLine(l: string): "hunk" | "meta" | "add" | "del" | "ctx" {
  if (l.startsWith("@@")) return "hunk"
  if (
    l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") ||
    l.startsWith("new file ") || l.startsWith("deleted file ") || l.startsWith("similarity ") ||
    l.startsWith("rename from ") || l.startsWith("rename to ") || l.startsWith("copy from ") ||
    l.startsWith("copy to ") || l.startsWith("Binary files ")
  ) return "meta"
  if (l.startsWith("+")) return "add"
  if (l.startsWith("-")) return "del"
  return "ctx"
}

interface PatchRow { k: "hunk" | "meta" | "add" | "del" | "ctx" | "blank"; text: string; oldNo: string; newNo: string }

/** patch 文本 → 双行号行集（纯函数导出供单测钉死计数器语义）。 */
export function patchRows(text: string): PatchRow[] {
  let o = 0
  let n = 0
  return text.split("\n").map((line): PatchRow => {
    const k = classifyPatchLine(line)
    if (k === "hunk") {
      const m = HUNK_RE.exec(line)
      if (m) { o = Number(m[1]); n = Number(m[2]) }
      return { k, text: line, oldNo: "", newNo: "" }
    }
    if (k === "meta") return { k, text: line, oldNo: "", newNo: "" }
    if (line === "") return { k: "blank", text: "", oldNo: "", newNo: "" } // 尾部换行伪行 —— 不推计数
    if (k === "add") return { k, text: line, oldNo: "", newNo: String(n++) }
    if (k === "del") return { k, text: line, oldNo: String(o++), newNo: "" }
    return { k, text: line, oldNo: String(o++), newNo: String(n++) }
  })
}

export function PatchBlock({ patch }: { patch: { text: string; truncated: boolean } }) {
  const rows = useMemo(() => patchRows(patch.text), [patch.text])
  return (
    <div className="rounded-md border-[1.5px] border-pop-bd bg-pop-paper overflow-x-auto" data-testid="round-diff-patch">
      <pre className="min-w-max p-2 font-mono text-[10.5px] leading-[1.5]">
        {rows.map((r, i) => {
          const cls =
            r.k === "add" ? "bg-pop-green-soft text-pop-green"
            : r.k === "del" ? "bg-pop-pink-soft text-pop-red"
            : r.k === "hunk" ? "bg-pop-cyan-soft text-pop-cyan"
            : r.k === "meta" ? "text-pop-dim font-black"
            : "text-pop-ink/70"
          return (
            <div key={i} className={`flex whitespace-pre ${cls}`} data-diff-line={r.k} data-diff-old={r.oldNo || undefined} data-diff-new={r.newNo || undefined}>
              <span className="w-9 shrink-0 select-none pr-1.5 text-right tabular-nums text-pop-dim/60">{r.oldNo}</span>
              <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-pop-dim/60">{r.newNo}</span>
              <span className="whitespace-pre-wrap break-all pr-2">{r.text || " "}</span>
            </div>
          )
        })}
        {patch.truncated && (
          <div className="px-1 pt-1 font-black text-pop-amber">[…patch 超 512K 已截断 — 完整内容请在批次目录/仓库侧查看]</div>
        )}
      </pre>
    </div>
  )
}
