// packages/web-app/components/tasks/authoring/spec-panel.tsx
//
// 草稿工作台「规格」窗口（2026-10-29 方案2）：
//
//   h4 phases ＋添加          ← 卡片 .ph（badge + 名称 + · spec 目录 · 绑定），
//                               点击 = 缩放弹窗编辑（无留空占位、无内联表单）
//   h4 入队清单               ← .chk ✓/✗ 行（server gateV4Phases 同源数据）
//   h4 产出摘要 [打开产物 →]  ← 每个 phase 一行：spec / 票数 / 最新轮 / 验收态
//
// 「输出区」已退役：规格是写配置的面，结果面统一归「产物」窗口（phase × 轮次）。
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
import { listWorkflowPresets, type WorkflowPreset } from "@/lib/workflow-presets-api"
import { PhaseSpecDialog, normalizeRel } from "./phase-spec-dialog"
import { WorkflowBindingDialog } from "./phase-binding-dialog"
import { findSpecEntry, isRelativeScratchSpec, type BatchTreeState } from "./use-batch-tree"
import { expertLabel } from "@/lib/expert-roles"
import type { ArtifactManifestBody, ArtifactManifestPhase } from "@/lib/types"
import {
  DEFAULT_NEW_WORKFLOW,
  SLUG_RE,
  defaultSpecPath,
  mainSlugOf,
  withPhases,
} from "./phases-mutation"

/** 入队清单六态（与 server gateV4Phases 同源，父级计算后传入）。
 *  「绑定确认」行已删（2026-10-10 ADR-0028：绑定可解析即视为确认）。 */
export interface SpecPanelRows {
  rowPhases: boolean
  rowSpec: boolean
  /** batch-tree 未就绪：spec 行「⏳ 未核」，不显示假绿 ✓（原型 v4.3 拍板）。 */
  specUnknown: boolean
  /** 磁盘核验缺失 spec 的 phase index（1-based），✗ 行按此点名。 */
  specMissingIdx: number[]
  /** specPath 为扫描域外（绝对路径等）的 phase 数 —— server 权威核验。 */
  absSpecCount: number
  rowBind: boolean
  rowInputs: boolean
  rowRunbook: boolean
  rowRepos: boolean
  inputsUnknown: boolean
  specTreeReady: boolean
}

export interface SpecPanelProps {
  task: Task
  onMutated: () => void
  batchTree: BatchTreeState
  rows: SpecPanelRows
  gateHits: Record<"phases" | "spec" | "bind" | "inputs" | "repos" | "runbook", string[]>
  /** 产物清单（父级拉取；只用于「产出摘要」的件数/轮次/验收态）。 */
  artifacts?: ArtifactManifestBody | null
  /** 「打开产物 →」= 由窗口层切到产物模块（外部窗口没有该入口时留空）。 */
  onOpenArtifacts?: () => void
  /** autoAdvance 开关行（父级持有写回逻辑，按原型 dim 风格传入）。 */
  autoRow?: ReactNode
  /** 票09 单源换装（原型⓬ readySpecHtml「草稿期 SpecPanel 只读镜像」）：
   *  true = 全部写动作**不渲染** —— ＋添加 / 点卡编辑 / spec·绑定入口 /
   *  auto_advance 开关行（autoRow 传入也隐）；onMutated 在场但无处可触发。
   *  只读查看面照常：清单 ✓/✗ 如实渲染、产出摘要与「打开产物」可用。
   *  缺省 false = 草稿工作台逐字不变。 */
  readOnly?: boolean
}

const PHASE_SUMMARY_STATUS: Record<ArtifactManifestPhase["status"], { label: string; cls: string }> = {
  pending: { label: "待执行", cls: "text-pop-dim" },
  running: { label: "运行中", cls: "text-pop-cyan" },
  awaiting_review: { label: "待验收", cls: "text-pop-amber" },
  accepted: { label: "已验收", cls: "text-pop-green" },
}

/** 一个 phase 的产出摘要（spec ✓ / 票数 / 最新轮 / 验收态）。 */
function phaseSummary(phase: ArtifactManifestPhase): Array<{ text: string; cls?: string }> {
  const all = [...phase.items, ...phase.rounds.flatMap((r) => r.items)]
  const hasSpec = all.some((i) => i.kind === "spec")
  const tickets = all.filter((i) => i.kind === "ticket").length
  const reports = all.filter((i) => i.kind === "report" || i.kind === "fix").length
  const evidence = all.filter((i) => i.kind === "evidence").length
  const latest = phase.rounds.length > 0 ? `r${phase.rounds[phase.rounds.length - 1].round}` : null
  const status = PHASE_SUMMARY_STATUS[phase.status] ?? PHASE_SUMMARY_STATUS.pending
  return [
    { text: hasSpec ? "spec ✓" : "spec —", cls: hasSpec ? "text-pop-green" : "text-pop-dim" },
    { text: `票 ${tickets}` },
    { text: `报告 ${reports}` },
    { text: `证据 ${evidence}` },
    { text: latest ?? "未开轮" },
    { text: status.label, cls: status.cls },
  ]
}

const dirOf = (p: string): string => normalizeRel(p).replace(/\/[^/]*$/, "/")

export function SpecPanel({ task, onMutated, batchTree, rows, gateHits, artifacts, onOpenArtifacts, autoRow, readOnly }: SpecPanelProps) {
  const spec = task.task_spec
  const phases = spec.phases ?? []
  const isDraft = task.status === "draft"

  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; phase: TaskPhase } | null>(null)
  const [formAnchor, setFormAnchor] = useState<Element | null>(null)
  const [specTarget, setSpecTarget] = useState<TaskPhase | null>(null)
  const [bindIdx, setBindIdx] = useState<number | null>(null)
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
      label: rows.specUnknown ? "spec 产物（未核 · 磁盘树未就绪）" : "spec 产物（磁盘已核）",
      value: rows.rowSpec
        ? `${phases.length}/${phases.length} 落盘${rows.absSpecCount > 0 ? ` · ${rows.absSpecCount} 份域外路径 server 核验` : ""}`
        : rows.specUnknown
          ? "待核验"
          : `${phases.length - rows.specMissingIdx.length}/${phases.length} 落盘 · ${rows.specMissingIdx.map((i) => `P${i}`).join("、")} 缺`,
    },
    {
      id: "bind",
      ok: rows.rowBind,
      hits: gateHits.bind,
      label: "工作流绑定",
      value: phases[0]?.workflowRef ? `${phases[0].workflowRef}${phases.length > 1 ? ` · ${phases.length}/${phases.length} 可解析` : ""}` : "—",
    },
    { id: "inputs", ok: rows.rowInputs, hits: gateHits.inputs, label: "inputs 齐", value: "必填非空/占位符" },
    { id: "runbook", ok: rows.rowRunbook, hits: gateHits.runbook, label: "runbook 内容", value: "起停 up∧ready ∨ preview ∨ verify" },
    {
      id: "repos",
      ok: rows.rowRepos,
      hits: gateHits.repos.length > 0
        ? gateHits.repos
        : rows.rowRepos
          ? []
          : ["未绑定项目：执行前需要至少选择一个项目（执行环境要挂 worktree）"],
      label: "项目仓库",
      value: `${task.repo_group || "—"} · ${(task.project_ids ?? []).length} 项目`,
    },
  ] as const

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto bg-pop-bg" data-spec-panel data-phase-binding-list>
      {/* ── phases ── */}
      <h4 className="flex items-center px-3.5 pb-1.5 pt-3 text-[10px] uppercase tracking-[.08em] font-normal text-pop-dim">
        phases
        {isDraft && !readOnly && (
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
          {readOnly
            ? "尚无 phase —— 要改规格请走右栏「↩ 回草稿」。"
            : "尚无 phase —— 对话里让 agent 拆分（spec 落盘后此处出卡），或「＋ 添加」手动建骨架。"}
        </p>
      )}
      {phases.map((p) => {
        const ready = specOnDisk(p)
        // 卡内核两态共用；外层容器与 ul 行按 readOnly 换装。
        const cardBody = (
          <>
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
              {readOnly ? (
                <>
                  {/* 原型 readySpecHtml phase-tile：spec/绑定为纯文本行，无 ▸ 编辑入口。 */}
                  <li>· spec.md {dirOf(p.specPath)}</li>
                  <li>· {p.workflowRef ? `绑定 ${p.workflowRef}` : "未绑定工作流"}</li>
                </>
              ) : (
                <>
                  <li>
                    <button
                      type="button"
                      data-phase-spec-button={p.index}
                      className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11.5px] text-pop-dim hover:text-pop-pink"
                      title="查看/编辑 spec.md（404 空态可建骨架）"
                      onClick={(e) => { e.stopPropagation(); setSpecTarget(p) }}
                    >
                      · spec.md {dirOf(p.specPath)} <span aria-hidden>▸</span>
                    </button>
                  </li>
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
                </>
              )}
              {(p.experts?.length ?? 0) > 0 && (
                <li className="text-pop-purple">
                  · 专家 {p.experts!.map((id) => expertLabel(id)).join(" / ")}
                </li>
              )}
            </ul>
          </>
        )
        if (readOnly) {
          return (
            <div key={p.index} data-phase-bind-card={p.index} className="mx-3.5 mb-2 rounded-md border border-pop-bd bg-pop-paper p-2.5">
              {cardBody}
            </div>
          )
        }
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
            {cardBody}
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
        {/* auto_advance 开关 = 写动作：readOnly 态连父级传入的 autoRow 一并隐去。 */}
        {!readOnly && autoRow && <div className="mx-3.5 my-1 text-[11px] text-pop-dim" data-autoadvance-row>{autoRow}</div>}
      </div>

      {/* ── 产出摘要 = 每 phase 一行（2026-10-29 方案2）──
          规格是写配置的面；文件树、轮次细节统一归「产物」窗口。 */}
      <h4 className="flex items-center px-3.5 pb-1.5 pt-3 text-[10px] uppercase tracking-[.08em] font-normal text-pop-dim">
        产出摘要
        {onOpenArtifacts && (
          <button
            type="button"
            data-artifacts-open
            onClick={onOpenArtifacts}
            className="ml-auto rounded border border-pop-bd px-2 text-[12px] normal-case tracking-normal text-pop-dim transition-colors hover:border-pop-pink hover:text-pop-pink"
            title="打开产物窗口（按 phase × 轮次）"
          >
            打开产物 →
          </button>
        )}
      </h4>
      <div className="mx-3.5 mb-3 rounded-md border border-pop-bd bg-pop-paper px-2.5 py-2" data-spec-output-summary>
        {phases.length === 0 ? (
          <p className="text-[11px] text-pop-dim">尚无 phase —— 产出摘要随 phase 出现。</p>
        ) : (
          phases.map((p) => {
            const summary = artifacts?.phases.find((a) => a.index === p.index) ?? null
            const cells = summary ? phaseSummary(summary) : null
            return (
              <div key={p.index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5 text-[11px]" data-phase-summary={p.index}>
                <span className="shrink-0 font-semibold text-pop-ink">P{p.index} {p.name}</span>
                {cells ? (
                  cells.map((cell, i) => (
                    <span key={i} className={cell.cls ?? "text-pop-dim"}>{cell.text}</span>
                  ))
                ) : (
                  <span className="text-pop-dim">{artifacts ? "暂无产物" : "产物读取中…"}</span>
                )}
              </div>
            )
          })
        )}
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

  // slug 未手打过 → 跟随 name 生成。只保留 SLUG_RE 允许的 ASCII 安全字符
  // （CJK/符号折叠成 -），纯中文名 → 空（诚实的「待手填」，不再造 phase-N
  // 假默认、也不给必红的非法 slug）。2026-09-24 用户定稿。
  const suggestedSlug = name
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z0-9]+|[-.]+$/g, "")
    .slice(0, 40)
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
            placeholder={mode === "add" ? "随名称自动生成（可手改）" : ""} value={effectiveSlug} maxLength={100}
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
            className="rounded border border-pop-bd bg-pop-pink px-3 py-1 font-mono text-[10.5px] font-bold text-pop-bg transition-opacity disabled:opacity-40"
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
