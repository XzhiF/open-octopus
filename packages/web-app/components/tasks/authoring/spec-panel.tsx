// packages/web-app/components/tasks/authoring/spec-panel.tsx
//
// 草稿工作台右栏 = 原型 chat-tui.html #outcol 的 1:1 落地（2026-09-24
// 「spec panel 完全按原型」拍板）：
//
//   h4 phases ＋添加          ← 卡片 .ph（badge + 名称 + · spec 目录 · 绑定），
//                               点击 = 缩放弹窗编辑（无留空占位、无内联表单）
//   h4 入队清单               ← .chk ✓/✗ 行（server gateV4Phases 同源数据）
//   h4 输出区                 ← 虚线框：逐 phase spec.md fn 行 + 正文摘要，
//                               点击开 PhaseSpecDialog；批次/运行产物收进
//                               底部一行「▸ 更多」缩放弹窗（能力不丢）。
//
// phases 写回仍走 withPhases（S5 纪律：fresh version + 整数组 PUT）。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { ZoomDialog } from "@/components/ui/zoom-dialog"
import { toast } from "sonner"
import type { Task, TaskPhase } from "@octopus/shared"
import { getHomeFile } from "@/lib/tasks-api"
import { listWorkflowPresets, type WorkflowPreset } from "@/lib/workflow-presets-api"
import { PhaseSpecDialog, normalizeRel } from "./phase-spec-dialog"
import { WorkflowBindingDialog } from "./phase-binding-dialog"
import { findSpecEntry, isRelativeScratchSpec, type BatchTreeState } from "./use-batch-tree"
import { DraftBatches } from "./draft-batches"
import { OutputViewer } from "./output-viewer"
import {
  DEFAULT_NEW_WORKFLOW,
  SLUG_RE,
  defaultSpecPath,
  mainSlugOf,
  withPhases,
} from "./phases-mutation"

/** 入队清单四态（与 server gateV4Phases 同源，父级计算后传入）。 */
export interface SpecPanelRows {
  rowPhases: boolean
  rowSpec: boolean
  rowBind: boolean
  rowInputs: boolean
  rowRepos: boolean
  inputsUnknown: boolean
  specTreeReady: boolean
}

export interface SpecPanelProps {
  task: Task
  onMutated: () => void
  batchTree: BatchTreeState
  rows: SpecPanelRows
  gateHits: Record<"phases" | "spec" | "bind" | "inputs" | "repos", string[]>
  /** 专家咨询辅助工作流 run ids（输出区「更多」弹窗里的运行产物）。 */
  runIds: string[]
  /** autoAdvance 开关行（父级持有写回逻辑，按原型 dim 风格传入）。 */
  autoRow?: ReactNode
}

const baseName = (p: string): string => normalizeRel(p).split("/").pop() ?? p
const dirOf = (p: string): string => normalizeRel(p).replace(/\/[^/]*$/, "/")

export function SpecPanel({ task, onMutated, batchTree, rows, gateHits, runIds, autoRow }: SpecPanelProps) {
  const spec = task.task_spec
  const phases = spec.phases ?? []
  const isDraft = task.status === "draft"

  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; phase: TaskPhase } | null>(null)
  const [formAnchor, setFormAnchor] = useState<Element | null>(null)
  const [specTarget, setSpecTarget] = useState<TaskPhase | null>(null)
  const [bindIdx, setBindIdx] = useState<number | null>(null)
  const [auxOpen, setAuxOpen] = useState(false)
  const [auxAnchor, setAuxAnchor] = useState<Element | null>(null)
  const [busy, setBusy] = useState(false)

  // 结构动作串行闸（连点不叠 PUT）。
  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy) return
      setBusy(true)
      try {
        await fn()
        toast.success(label)
        onMutated()
      } catch (err) {
        toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [busy, onMutated],
  )

  const handleAdd = (row: {
    name: string
    slug: string
    workflowRef: string
    inputValues: Record<string, string>
  }) => {
    setForm(null)
    void guard(`Phase ${row.name} 已添加`, async () => {
      await withPhases(task, (base) => {
        if (base.some((p) => p.slug === row.slug)) {
          throw new Error(`slug「${row.slug}」已存在——换个目录名`)
        }
        return [
          ...base,
          {
            index: 9999, // renumber 统一位次
            name: row.name,
            slug: row.slug,
            specPath: defaultSpecPath(row.slug, mainSlugOf(task)),
            workflowRef: row.workflowRef as TaskPhase["workflowRef"],
            inputValues: { ...row.inputValues },
          },
        ]
      })
    })
  }

  const handleEditSave = (
    index: number,
    row: { name: string; slug: string; specPath: string; workflowRef: string; inputValues: Record<string, string> },
  ) => {
    setForm(null)
    void guard("已保存", async () => {
      await withPhases(task, (base) =>
        base.map((p) =>
          p.index === index
            ? {
                ...p,
                name: row.name,
                slug: row.slug,
                specPath: row.specPath,
                workflowRef: row.workflowRef as TaskPhase["workflowRef"],
                inputValues: row.inputValues,
              }
            : p,
        ),
      )
    })
  }

  const diskTreeReady = !batchTree.loading && !batchTree.error
  const specOnDisk = (p: TaskPhase) =>
    rows.specTreeReady && isRelativeScratchSpec(p.specPath) && findSpecEntry(batchTree.batches, p.specPath) !== null

  const checklist = [
    { id: "phases", ok: rows.rowPhases, hits: gateHits.phases, label: "phases 完备", value: `×${phases.length}` },
    {
      id: "spec",
      ok: rows.rowSpec,
      hits: gateHits.spec,
      label: rows.specTreeReady ? "spec 产物（磁盘已核）" : "spec 产物",
      value: phases[0] ? `${dirOf(phases[0].specPath)}spec.md${phases.length > 1 ? ` 等 ${phases.length} 份` : ""}` : "—",
    },
    {
      id: "bind",
      ok: rows.rowBind,
      hits: gateHits.bind,
      label: "工作流绑定",
      value: phases[0]?.workflowRef ? `${phases[0].workflowRef}${phases.length > 1 ? " 等" : ""}` : "—",
    },
    { id: "inputs", ok: rows.rowInputs, hits: gateHits.inputs, label: "inputs 齐", value: "必填非空/占位符" },
    { id: "repos", ok: rows.rowRepos, hits: gateHits.repos, label: "项目仓库", value: `${task.org || "—"} · ${(task.project_ids ?? []).length} 项目` },
  ] as const

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto bg-pop-bg" data-spec-panel data-phase-binding-list>
      {/* ── phases ── */}
      <h4 className="flex items-center px-3.5 pb-1.5 pt-3 text-[10px] uppercase tracking-[.08em] font-normal text-pop-dim">
        phases
        {isDraft && (
          <button
            type="button"
            data-phase-add-open
            onClick={(e) => { setFormAnchor(e.currentTarget); setForm({ mode: "add" }) }}
            className="ml-auto rounded border border-pop-bd px-2 text-[12px] normal-case tracking-normal text-pop-pink transition-colors hover:border-pop-pink"
          >
            ＋ 添加
          </button>
        )}
      </h4>
      {phases.length === 0 && (
        <p className="px-3.5 pb-1 text-[11.5px] text-pop-dim" data-phase-bind-empty>
          尚无 phase —— 对话里让 agent 拆分（落盘先在「输出区 ▸ 更多」的草稿批次出现），或「＋ 添加」手动建骨架。
        </p>
      )}
      {phases.map((p) => {
        const ready = specOnDisk(p)
        return (
          <div
            key={p.index}
            data-phase-bind-card={p.index}
            role="button"
            tabIndex={0}
            onClick={async (e) => {
              if (isDraft) { setFormAnchor(e.currentTarget); setForm({ mode: "edit", phase: p }) }
              else setSpecTarget(p)
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLElement).click() }}
            className="mx-3.5 mb-2 cursor-pointer rounded-md border border-pop-bd bg-pop-paper p-2.5 transition-colors hover:border-pop-pink"
          >
            <span
              className={
                "float-right rounded-full border px-2 text-[10px] leading-4 " +
                (ready ? "border-pop-green text-pop-green" : "border-pop-amber text-pop-amber")
              }
            >
              {ready ? "ready" : "draft"}
            </span>
            <span className="font-semibold text-pop-ink">Phase {p.index} · {p.name}</span>
            <ul className="mt-1 list-none text-[11.5px] text-pop-dim">
              <li>· spec.md {dirOf(p.specPath)}</li>
              <li>
                <button
                  type="button"
                  data-phase-bind-button={p.index}
                  className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11.5px] text-pop-dim hover:text-pop-pink"
                  title="更换绑定 / 编辑 inputs"
                  onClick={(e) => { e.stopPropagation(); setBindIdx(p.index) }}
                >
                  · {p.workflowRef ? `绑定 ${p.workflowRef}` : "未绑定工作流"} <span aria-hidden>▸</span>
                </button>
              </li>
            </ul>
          </div>
        )
      })}

      {/* ── 入队清单 ── */}
      <h4 className="px-3.5 pb-1.5 pt-3 text-[10px] uppercase tracking-[.08em] font-normal text-pop-dim">入队清单</h4>
      <div data-enqueue-checklist data-testid="enqueue-checklist-v4">
        {checklist.map((row) => {
          const failed = row.hits.length > 0
          const good = row.ok && !failed
          return (
            <div key={row.id} className="mx-3.5 my-1 flex gap-2 text-[11.5px] text-pop-dim" data-checklist-v4={row.id}>
              <span className={good ? "text-pop-green" : failed ? "text-pop-red" : "text-pop-amber"}>
                {good ? "✓" : failed ? "✗" : "⏳"}
              </span>
              <span className="min-w-0">
                {row.label} <code className="text-pop-ink">{row.value}</code>
                {failed && (
                  <ul className="ml-4 list-disc text-[10px] text-pop-red">
                    {row.hits.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                )}
              </span>
            </div>
          )
        })}
        {rows.inputsUnknown && (
          <p className="px-3.5 pb-1 pl-10 text-[10px] text-pop-dim">
            存在非内置 workflow —— inputs 解析以服务端入队门禁为最终权威。
          </p>
        )}
        {autoRow && <div className="mx-3.5 my-1 text-[11px] text-pop-dim" data-autoadvance-row>{autoRow}</div>}
      </div>

      {/* ── 输出区 ── */}
      <h4 className="px-3.5 pb-1.5 pt-3 text-[10px] uppercase tracking-[.08em] font-normal text-pop-dim">输出区</h4>
      <div
        className="mx-3.5 mb-3 min-h-[90px] rounded-md border border-dashed border-pop-bd p-2.5 text-[11.5px] text-pop-dim"
        data-spec-outview
      >
        {phases.length === 0 && <span>对话产出落盘后在此预览（spec / 票 / 产物）。</span>}
        {phases.map((p) => (
          <SpecOutRow
            key={p.index}
            task={task}
            phase={p}
            onOpen={(ph) => setSpecTarget(ph)}
          />
        ))}
        <button
          type="button"
          data-spec-aux-open
          onClick={(e) => { setAuxAnchor(e.currentTarget); setAuxOpen(true) }}
          className="mt-1.5 border-0 bg-transparent p-0 text-[10.5px] text-pop-dim transition-colors hover:text-pop-ink"
        >
          ▸ 草稿批次 · 运行产物 · 工作上下文 · 规格快照
        </button>
      </div>

      {form && (
        <PhaseFormDialog
          open
          anchor={formAnchor}
          mode={form.mode}
          phase={form.mode === "edit" ? form.phase : null}
          busy={busy}
          main={mainSlugOf(task)}
          onClose={() => setForm(null)}
          onAdd={handleAdd}
          onEditSave={handleEditSave}
        />
      )}

      {bindIdx !== null && (
        <WorkflowBindingDialog
          task={task}
          phaseIndex={bindIdx}
          open
          onOpenChange={(o) => { if (!o) setBindIdx(null) }}
          onMutated={onMutated}
        />
      )}

      {specTarget && (
        <PhaseSpecDialog
          task={task}
          phase={specTarget}
          open
          onOpenChange={(o) => { if (!o) setSpecTarget(null) }}
        />
      )}

      <ZoomDialog open={auxOpen} onClose={() => setAuxOpen(false)} anchor={auxAnchor} width={680} title="批次 · 产物 · 语境">
        <div className="max-h-[65vh] space-y-2 overflow-y-auto">
          {isDraft && <DraftBatches task={task} phases={phases} isDraft tree={batchTree} onMutated={onMutated} />}
          <OutputViewer task={task} runIds={runIds} onAdopted={onMutated} />
        </div>
      </ZoomDialog>
    </div>
  )
}

/** 输出区单行：fn 名 + 正文摘要（懒取一次，失败静默），点击开 spec 编辑器。 */
function SpecOutRow({ task, phase, onOpen }: {
  task: Task
  phase: TaskPhase
  onOpen: (p: TaskPhase) => void
}) {
  const [excerpt, setExcerpt] = useState<string | null>(null)
  const rel = normalizeRel(phase.specPath)
  const previewable = isRelativeScratchSpec(phase.specPath)

  useEffect(() => {
    if (!previewable) return
    let cancelled = false
    getHomeFile(task.id, rel)
      .then((r) => {
        if (cancelled) return
        const lines = r.content.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2)
        setExcerpt(lines.join(" "))
      })
      .catch(() => { if (!cancelled) setExcerpt("") })
    return () => { cancelled = true }
  }, [task.id, rel, previewable])

  return (
    <div className="mb-1.5" data-spec-out-row={phase.index}>
      <button
        type="button"
        onClick={() => onOpen(phase)}
        className="border-0 bg-transparent p-0 text-left text-[11.5px]"
      >
        <span className="text-pop-green hover:underline">spec.md</span>
        <span className="text-pop-dim"> — Phase {phase.index} · {baseName(dirOf(phase.specPath))}</span>
      </button>
      {previewable && excerpt !== null && (
        <div className="line-clamp-2 pl-[3.2rem] text-pop-dim">{excerpt || "（空文件）"}</div>
      )}
      {!previewable && phase.specPath && (
        <div className="pl-[3.2rem] text-pop-dim">绝对路径直写：{phase.specPath}</div>
      )}
    </div>
  )
}

// ── Phase 添加/编辑弹窗（mac 缩放） ───────────────────────────────────

export function PhaseFormDialog({
  open, anchor, mode, phase, busy, main, onClose, onAdd, onEditSave,
}: {
  open: boolean
  anchor: Element | null
  mode: "add" | "edit"
  phase: TaskPhase | null
  busy: boolean
  main?: string
  onClose: () => void
  onAdd: (row: { name: string; slug: string; workflowRef: string; inputValues: Record<string, string> }) => void
  onEditSave: (index: number, row: { name: string; slug: string; specPath: string; workflowRef: string; inputValues: Record<string, string> }) => void
}) {
  const [name, setName] = useState(phase?.name ?? "")
  const [slug, setSlug] = useState(phase?.slug ?? "")
  const [specPath, setSpecPath] = useState(phase?.specPath ?? "")
  const [workflowRef, setWorkflowRef] = useState(phase?.workflowRef || DEFAULT_NEW_WORKFLOW)
  const [slugTouched, setSlugTouched] = useState(mode === "edit")
  const [catalog, setCatalog] = useState<WorkflowPreset[]>([])
  const fetchedRef = useRef(false)

  // 绑定目录一次拉取（可选项）；失败退化为自由文本 ref。
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    listWorkflowPresets()
      .then(({ presets }) => {
        if (presets.length > 0) setCatalog(presets)
        if (!presets.some((w) => w.workflow === DEFAULT_NEW_WORKFLOW) && presets[0]) {
          setWorkflowRef((cur) => (cur === DEFAULT_NEW_WORKFLOW ? presets[0].workflow : cur))
        }
      })
      .catch(() => setCatalog([]))
  }, [])

  // slug 未手打过 → 跟随 name 简版 slugify
  const suggestedSlug = name
    .trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `phase-${catalog.length + 1}`
  const effectiveSlug = slugTouched ? slug : suggestedSlug

  const invalid =
    !name.trim() || name.trim().length > 100 ||
    !SLUG_RE.test(effectiveSlug) || effectiveSlug.length > 100 ||
    (mode === "edit" && !specPath.trim())

  // 换绑 = 目录骨架整体换上（不跨条目泄漏，同 WorkflowBindingDialog 语义）。
  const [refTouched, setRefTouched] = useState(false)
  const initialSkeleton = useMemo(() => ({ ...(phase?.inputValues ?? {}) }), [phase])
  const skeletonFor = (ref: string): Record<string, string> => {
    if (mode === "edit" && !refTouched) return initialSkeleton
    return { ...catalog.find((w) => w.workflow === ref)?.inputs }
  }

  const handleSubmit = () => {
    if (invalid || busy) return
    if (mode === "add") {
      onAdd({
        name: name.trim(),
        slug: effectiveSlug,
        workflowRef,
        inputValues: { ...catalog.find((w) => w.workflow === workflowRef)?.inputs },
      })
    } else if (phase) {
      onEditSave(phase.index, {
        name: name.trim(),
        slug: effectiveSlug,
        specPath: specPath.trim(),
        workflowRef,
        inputValues: skeletonFor(workflowRef),
      })
    }
  }

  const row = "flex items-center gap-2"
  const lbl = "w-16 shrink-0 font-mono text-[10px] text-pop-dim"
  const field = "h-7 flex-1 min-w-0 rounded border border-pop-bd bg-pop-bg px-2 font-mono text-[11px] text-pop-ink outline-none transition-colors focus:border-pop-pink"

  return (
    <ZoomDialog open={open} onClose={onClose} anchor={anchor} width={430}
      title={mode === "add" ? "添加 Phase" : `编辑 Phase ${phase?.index ?? ""}`}>
      <div data-phase-add-form={mode === "add" ? "" : undefined} className="space-y-2">
        <div className={row}>
          <Label className={lbl}>名称</Label>
          <Input className={field} placeholder="例：契约与落库" value={name} maxLength={100}
            onChange={(e) => setName(e.target.value)}
            data-phase-add-name={mode === "add" ? "" : undefined}
            data-phase-name-input={mode === "edit" && phase ? phase.index : undefined} />
        </div>
        <div className={row}>
          <Label className={lbl}>slug</Label>
          <Input className={`${field} ${effectiveSlug && !SLUG_RE.test(effectiveSlug) ? "border-pop-red" : ""}`}
            placeholder={mode === "add" ? `slug=${suggestedSlug}` : ""} value={effectiveSlug} maxLength={100}
            title="path-safe：字母/数字开头，可含 . _ -"
            onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }}
            data-phase-add-slug={mode === "add" ? "" : undefined}
            data-phase-slug-input={mode === "edit" && phase ? phase.index : undefined} />
        </div>
        {mode === "edit" && (
          <div className={row}>
            <Label className={lbl}>spec 路径</Label>
            <Input className={field} value={specPath}
              onChange={(e) => setSpecPath(e.target.value)}
              data-phase-specpath-input={phase ? phase.index : undefined} />
          </div>
        )}
        <div className={row}>
          <Label className={lbl}>绑定工作流</Label>
          <select
            className={field}
            value={workflowRef}
            onChange={(e) => { setRefTouched(true); setWorkflowRef(e.target.value) }}
            data-phase-add-workflow
          >
            {Array.from(new Set([...(catalog.length > 0 ? catalog.map((w) => w.workflow) : []), workflowRef])).map((ref) => (
              <option key={ref} value={ref}>{ref}</option>
            ))}
          </select>
        </div>
        <p className="pl-[4.5rem] font-mono text-[9.5px] text-pop-dim">
          {mode === "add"
            ? <>spec 预落 <span className="text-pop-green">{defaultSpecPath(effectiveSlug || "…", main)}</span>；inputs 以目录骨架预填</>
            : refTouched ? "换绑 = 新目录骨架预填 inputs（原值不跨条目泄漏）" : "改 slug 不会搬动已落盘批次目录 —— 同步 specPath 或让 agent 改写"}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded border border-pop-bd px-3 py-1 font-mono text-[10.5px] text-pop-dim transition-colors hover:text-pop-ink"
            data-phase-edit-cancel={mode === "edit" && phase ? phase.index : undefined}>
            取消
          </button>
          <button type="button" onClick={handleSubmit} disabled={invalid || busy}
            className="rounded border border-pop-bd bg-pop-pink px-3 py-1 font-mono text-[10.5px] font-bold text-[#151413] transition-opacity disabled:opacity-40"
            data-phase-add-submit={mode === "add" ? "" : undefined}
            data-phase-edit-save={mode === "edit" && phase ? phase.index : undefined}>
            {busy ? <Spinner className="mr-1 inline size-3" /> : null}
            {mode === "add" ? "添加" : "保存"}
          </button>
        </div>
      </div>
    </ZoomDialog>
  )
}
