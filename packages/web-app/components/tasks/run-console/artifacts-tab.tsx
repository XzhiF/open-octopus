// packages/web-app/components/tasks/run-console/artifacts-tab.tsx
//
// 产物窗口（2026-10-29 方案2 定稿）：不再按文件名正则拍成五组，而是按
// **phase → 轮次** 展示交付面 ——
//   · 每个 phase 一张卡：批次级产物（spec/票/runbook/交接/未标轮报告）+ rN 分组；
//   · 未归属产物（旧布局 / 手工放置）单列一组；
//   · 工作区原型单列。
// 数据 = GET /:id/artifacts/manifest（server 单源归组；前端不重分组），
// 右侧内联预览（Markdown 渲染 / JSON 美化高亮 / >20K 截断），不再弹对话框。
// 左右默认 3:7，中间分隔条可拖动调整（2026-10-29 用户）。
// 产物 ≠ diff：代码改动看「变更」窗口。

"use client"

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { MarkdownPreview } from "@/components/resource/MarkdownPreview"
import { readArtifactManifestFile, type ArtifactContent } from "@/lib/tasks-api"
import { formatBytes } from "@/lib/format"
import type {
  ArtifactKind,
  ArtifactManifestBody,
  ArtifactManifestItem,
  ArtifactManifestPhase,
} from "@/lib/types"
import {
  prettyJsonForPreview,
  manifestTotalCount,
  phaseArtifactCount,
  previewTruncate,
  tokenizeJson,
  type JsonTokenKind,
} from "./artifacts-model"

const PREVIEW_MAX = 20_000
/** 左列默认占比（2026-10-29 用户：3:7，可拖动分隔条调整）。 */
const LEFT_DEFAULT_PCT = 30
const LEFT_MIN_PCT = 22
const LEFT_MAX_PCT = 62

const KIND_META: Record<ArtifactKind, { label: string; cls: string }> = {
  spec: { label: "spec", cls: "border-pop-cyan/45 text-pop-cyan" },
  brief: { label: "brief", cls: "border-pop-cyan/45 text-pop-cyan" },
  runbook: { label: "runbook", cls: "border-pop-cyan/45 text-pop-cyan" },
  ticket: { label: "票", cls: "border-pop-purple/45 text-pop-purple" },
  report: { label: "报告", cls: "border-pop-amber/45 text-pop-amber" },
  fix: { label: "修复", cls: "border-pop-amber/45 text-pop-amber" },
  feedback: { label: "反馈", cls: "border-pop-amber/45 text-pop-amber" },
  handoff: { label: "交接", cls: "border-pop-amber/45 text-pop-amber" },
  ledger: { label: "台账", cls: "border-pop-green/45 text-pop-green" },
  evidence: { label: "证据", cls: "border-pop-green/45 text-pop-green" },
  prototype: { label: "原型", cls: "border-pop-pink/45 text-pop-pink" },
}

const PHASE_STATUS: Record<ArtifactManifestPhase["status"], { label: string; cls: string }> = {
  pending: { label: "待执行", cls: "border-pop-bd text-pop-dim" },
  running: { label: "运行中", cls: "border-pop-cyan/50 text-pop-cyan" },
  awaiting_review: { label: "待验收", cls: "border-pop-amber/50 text-pop-amber" },
  accepted: { label: "已验收 ✓", cls: "border-pop-green/50 text-pop-green" },
}

/** Markdown 预览的排版（项目未装 typography 插件，用任意变体钉住 TUI 风格）。 */
const MD_CLASS = [
  "text-[11.5px] leading-relaxed",
  "[&_h1]:mb-2 [&_h1]:text-[13px] [&_h1]:font-bold [&_h1]:text-pop-ink",
  "[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[12px] [&_h2]:font-bold [&_h2]:text-pop-purple",
  "[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[11.5px] [&_h3]:font-bold",
  "[&_p]:mb-1.5 [&_p]:text-pop-ink/85",
  "[&_ul]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:mb-0.5 [&_li]:text-pop-ink/85",
  "[&_code]:rounded-[3px] [&_code]:bg-pop-bd/50 [&_code]:px-1 [&_code]:text-pop-green",
  "[&_pre]:mb-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-pop-bd [&_pre]:bg-pop-inset [&_pre]:p-2",
  "[&_table]:mb-2 [&_table]:w-full [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-pop-bd [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left",
  "[&_td]:border [&_td]:border-pop-bd [&_td]:px-1.5 [&_td]:py-0.5",
  "[&_a]:text-pop-cyan [&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-pop-bd [&_blockquote]:pl-2 [&_blockquote]:text-pop-dim",
].join(" ")

function fmtMtime(mtime: string): string {
  return mtime ? mtime.slice(5, 16).replace("T", " ") : ""
}

const JSON_TONE: Record<JsonTokenKind, string> = {
  key: "text-pop-cyan",
  string: "text-pop-green",
  number: "text-pop-amber",
  boolean: "text-pop-purple",
  null: "text-pop-red",
  punct: "text-pop-dim",
  plain: "text-pop-ink/85",
}

/** JSON 预览：能 parse 就 2 空格美化，再按词法上色（key 青 / 字符串绿 / 数字琥珀）。 */
function JsonPreview({ text }: { text: string }) {
  const formatted = useMemo(() => prettyJsonForPreview(text), [text])
  const tokens = useMemo(() => tokenizeJson(formatted.text), [formatted.text])
  return (
    <pre data-testid="json-preview" className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
      {tokens.map((token, i) => (
        <span key={i} data-json-token={token.kind} className={JSON_TONE[token.kind]}>{token.text}</span>
      ))}
    </pre>
  )
}

function KindBadge({ kind }: { kind: ArtifactKind }) {
  const meta = KIND_META[kind] ?? KIND_META.evidence
  return (
    <span className={`shrink-0 rounded-[3px] border px-1.5 text-[8.5px] font-black leading-[14px] ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

function ArtifactRow({ item, active, onSelect }: {
  item: ArtifactManifestItem
  active: boolean
  onSelect: (item: ArtifactManifestItem) => void
}) {
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(item.path)
      toast.success(`已复制路径 ${item.path}`)
    } catch {
      toast.error("剪贴板不可用 — 路径已在行内可见")
    }
  }
  return (
    <div
      data-testid="artifact-row"
      data-artifact-key={item.path}
      className={`group flex items-center gap-2 rounded px-1.5 py-1 text-[11.5px] transition-colors hover:bg-white/[0.04] ${active ? "bg-white/[0.07]" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSelect(item)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={item.path}
      >
        <KindBadge kind={item.kind} />
        <span className="min-w-0 truncate font-semibold text-pop-ink/90">{item.name}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-pop-dim">{fmtMtime(item.mtime)}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-pop-dim">{formatBytes(item.bytes)}</span>
      </button>
      <button
        type="button"
        onClick={() => { void copyPath() }}
        data-testid="artifact-copy-btn"
        className="grid size-5 shrink-0 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink group-hover:opacity-100"
        title="复制产物引用路径"
      >
        <Copy className="size-3" />
      </button>
    </div>
  )
}

function PhaseCard({ phase, selected, onSelect }: {
  phase: ArtifactManifestPhase
  selected: ArtifactManifestItem | null
  onSelect: (item: ArtifactManifestItem) => void
}) {
  const status = PHASE_STATUS[phase.status] ?? PHASE_STATUS.pending
  const count = phaseArtifactCount(phase)
  return (
    <section
      data-testid={`artifact-phase-${phase.index}`}
      className="mb-2 rounded-md border border-border bg-pop-idle/25 p-1.5"
    >
      <header className="flex items-center gap-2 px-1 pb-0.5 pt-0.5">
        <span className="shrink-0 font-mono text-[10.5px] text-pop-dim">P{phase.index}</span>
        <span className="min-w-0 truncate text-[12px] font-semibold text-pop-ink" title={phase.dir || phase.name}>
          {phase.name}
        </span>
        <span className={`shrink-0 rounded-full border px-1.5 text-[9px] leading-[15px] ${status.cls}`}>
          {status.label}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-pop-dim">{count} 件</span>
      </header>

      {phase.items.map((item) => (
        <ArtifactRow key={item.path} item={item} active={selected?.path === item.path} onSelect={onSelect} />
      ))}

      {phase.rounds.map((round) => (
        <div key={round.round} data-testid={`artifact-round-${round.round}`}>
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="rounded border border-pop-bd px-1 font-mono text-[9px] text-pop-dim">r{round.round}</span>
            <span className="flex-1 border-t border-dashed border-pop-bd/60" />
          </div>
          {round.items.map((item) => (
            <ArtifactRow key={item.path} item={item} active={selected?.path === item.path} onSelect={onSelect} />
          ))}
        </div>
      ))}

      {count === 0 && (
        <p className="px-1 py-1 text-[10.5px] text-pop-dim">该 phase 还没有产物。</p>
      )}
    </section>
  )
}

function ExtraSection({ title, items, selected, onSelect }: {
  title: string
  items: ArtifactManifestItem[]
  selected: ArtifactManifestItem | null
  onSelect: (item: ArtifactManifestItem) => void
}) {
  if (items.length === 0) return null
  return (
    <section className="mb-2 rounded-md border border-border bg-pop-idle/25 p-1.5" data-testid={`artifact-section-${title}`}>
      <header className="flex items-center gap-2 px-1 pb-0.5 pt-0.5">
        <span className="text-[11.5px] font-semibold text-pop-ink">{title}</span>
        <span className="ml-auto text-[10px] tabular-nums text-pop-dim">{items.length} 件</span>
      </header>
      {items.map((item) => (
        <ArtifactRow key={item.path} item={item} active={selected?.path === item.path} onSelect={onSelect} />
      ))}
    </section>
  )
}

function PreviewPane({ taskId, item }: { taskId: string; item: ArtifactManifestItem | null }) {
  const [data, setData] = useState<ArtifactContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!item) { setData(null); setError(null); return }
    let cancelled = false
    setBusy(true)
    setError(null)
    setData(null)
    readArtifactManifestFile(taskId, item.path)
      .then((r) => { if (!cancelled) setData(r) })
      .catch((err: unknown) => { if (!cancelled) { setData(null); setError(err instanceof Error ? err.message : String(err)) } })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [item, taskId])

  if (!item) {
    return (
      <div className="grid h-full place-items-center px-4 text-center text-[11px] text-pop-dim" data-testid="artifact-preview-empty">
        选一个产物 → 右侧预览
      </div>
    )
  }

  const { text, truncated } = previewTruncate(data?.content ?? "", PREVIEW_MAX)
  const isMarkdown = /\.md$/i.test(item.name)
  const isJson = /\.json$/i.test(item.name)
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(item.path)
      toast.success(`已复制路径 ${item.path}`)
    } catch {
      toast.error("剪贴板不可用 — 路径已在行内可见")
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-preview-pane">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <KindBadge kind={item.kind} />
        <span className="min-w-0 truncate text-[11.5px] font-semibold text-pop-ink" title={item.path}>{item.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-pop-dim">{formatBytes(item.bytes)}</span>
        <button
          type="button"
          onClick={() => { void copyPath() }}
          className="grid size-5 shrink-0 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          title="复制引用路径"
        >
          <Copy className="size-3" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="artifact-preview-body">
        {busy ? (
          <div className="flex items-center gap-2 text-[11px] text-pop-dim"><Spinner className="size-3" /> 现读中…</div>
        ) : error ? (
          <p className="text-[11px] text-pop-red">读取失败（{error}）</p>
        ) : (
          <>
            {truncated && (
              <p className="mb-1 font-mono text-[10px] text-pop-amber">… 超 {PREVIEW_MAX} 字符已截断（复制路径看全文）</p>
            )}
            {isMarkdown ? (
              <MarkdownPreview content={text} className={MD_CLASS} />
            ) : isJson ? (
              <JsonPreview text={text} />
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-pop-ink/85">{text}</pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function ArtifactsTab({ taskId, body, loading }: { taskId: string; body: ArtifactManifestBody | null; loading: boolean }) {
  const [preview, setPreview] = useState<ArtifactManifestItem | null>(null)
  const [leftPct, setLeftPct] = useState(LEFT_DEFAULT_PCT)
  const [dragging, setDragging] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // 左右分栏拖拽（2026-10-29 用户：3:7 默认，中间的分隔条可左右拉）。
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const dragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const rect = splitRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    setLeftPct(Math.min(LEFT_MAX_PCT, Math.max(LEFT_MIN_PCT, Math.round(pct))))
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // 清单刷新后，已选中的件若消失（被删/换任务）→ 收回预览。
  useEffect(() => {
    if (!preview || !body) return
    const paths = new Set<string>([
      ...body.phases.flatMap((p) => [...p.items, ...p.rounds.flatMap((r) => r.items)]).map((i) => i.path),
      ...body.unassigned.map((i) => i.path),
      ...body.prototype.map((i) => i.path),
    ])
    if (!paths.has(preview.path)) setPreview(null)
  }, [body, preview])

  if (loading && !body) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground" data-testid="artifacts-loading">
        <Spinner className="size-3" /> 产物清单读取中…
      </div>
    )
  }

  const total = body ? manifestTotalCount(body) : 0
  const phaseCount = body?.phases.length ?? 0

  return (
    <div ref={splitRef} className={`flex h-full min-h-0${dragging ? " select-none" : ""}`} data-testid="artifacts-tab">
      <div
        className="min-w-0 shrink-0 overflow-y-auto border-r border-border p-3"
        style={{ width: `${leftPct}%` }}
        data-testid="artifacts-list-pane"
      >
        <div className="mb-2 flex items-baseline gap-2 px-0.5 text-[10px] text-pop-dim">
          <span>共 <b className="font-mono text-pop-ink">{total}</b> 件 · <b className="font-mono text-pop-ink">{phaseCount}</b> 个 phase</span>
          <span className="ml-auto">代码改动看「变更」</span>
        </div>

        {total === 0 ? (
          <p className="py-2 text-[11px] text-pop-dim" data-testid="artifacts-empty">
            暂无可列产物 —— 批次目录还没落盘（spec / 票 / 报告 / 证据写出来即出现）。
          </p>
        ) : (
          <>
            {body?.phases.map((phase) => (
              <PhaseCard key={phase.index} phase={phase} selected={preview} onSelect={setPreview} />
            ))}
            <ExtraSection title="未归属产物" items={body?.unassigned ?? []} selected={preview} onSelect={setPreview} />
            <ExtraSection title="原型（工作区）" items={body?.prototype ?? []} selected={preview} onSelect={setPreview} />
          </>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={LEFT_MIN_PCT}
        aria-valuemax={LEFT_MAX_PCT}
        aria-valuenow={leftPct}
        data-testid="artifacts-split-handle"
        title="拖动调整左右宽度"
        onPointerDown={startDrag}
        onPointerMove={dragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-pop-purple/30"
      />
      <div className="min-w-0 flex-1">
        <PreviewPane taskId={taskId} item={preview} />
      </div>
    </div>
  )
}
