// packages/web-app/components/tasks/authoring/workflow-box.tsx
//
// PhaseListEditor（契约修复改版，原票 12 PhaseBindingList 升级）：v4 draft 右栏
// 的 phase 结构化编辑面。数据源 GET /api/workflows/built-in（票 10 缓存端点）；
// 一切 phases 变更走 PUT task_spec.phases 整数组 + If-Match（S5 纪律：写回前
// getTask 重取 version；409 不自动重试 — 拿旧数组盖回 agent 的并发意图是危险
// 的，提示用户重试即可）。
//
// 能力（v4-only UI，generic/任务级 v3 单卡已随 goal/ac 旧路径退役）：
//   • 增删 phase、改 name/slug/specPath、上移/下移 —— 仅 draft 态开放。
//     裁定依据：index=数组位次是验收查询（/:id/acceptance）与信封定位
//     （dispatchPhaseRound）的键，gate 按位次报 phase:<i>；ready 起信封已物化
//     冻结（K16 隔离即冻结），看板上的结构重排会造成派生/账本/信封三方错位。
//     ready 后退化为只读 + 换绑定；跨轮传播走 task-author 对话（agent 车道）。
//   • 逐行「spec.md」→ PhaseSpecDialog（home-file GET/PUT，契约修复新端点）。
//   • taskPhaseSchema.workflowRef 非空（shared min(1)）→ 新 phase 表单必须带
//     workflow 初选；inputValues 留空 {}，行上「绑定工作流」补 required 值。
//
// 写回链保留票 12 的修复：S2 取数 effect 只依赖 [open]；AC-20 开窗期间 list
// fetch 计数=1；S5 保存前重取 version。

"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Link2, Search, ChevronRight, Plus, Trash2, ArrowUp, ArrowDown, FileText, Pencil,
} from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getTask, updateTask } from "@/lib/tasks-api"
import {
  getBuiltInWorkflowDetail,
  listBuiltInWorkflows,
  type BuiltInWorkflowSummary,
} from "@/lib/workflow-presets-api"
import { PhaseSpecDialog } from "./phase-spec-dialog"

export interface WorkflowBoxProps {
  task: Task
  onMutated: () => void
}

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const DEFAULT_NEW_WORKFLOW = "built-in/matt-dev-pipeline"

export function WorkflowBox({ task, onMutated }: WorkflowBoxProps) {
  return <PhaseListEditor task={task} onMutated={onMutated} />
}

/** Classify an input value's placeholder SHAPE for the chip label — pure
 *  ${...} template shows verbatim; anything else truncates at 20 chars. */
function describeInputShape(value: string): string {
  if (/^\$\{[^}]+\}$/.test(value)) return value
  return value.length > 20 ? value.slice(0, 17) + "…" : value
}

function InputChips({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1" data-input-chips>
      {entries.map(([key, value]) => (
        <Badge key={key} variant="outline" className="text-[9px] py-0 h-4">
          {key}: {describeInputShape(value)}
        </Badge>
      ))}
    </div>
  )
}

/** index = 数组位次 +1 重排（SKILL 契约「index=数组序」；仅 draft 期发生，
 *  ready 后结构编辑关闭，位次不再漂移）。 */
function renumber(phases: TaskPhase[]): TaskPhase[] {
  return phases.map((p, i) => (p.index === i + 1 ? p : { ...p, index: i + 1 }))
}

/** 默认 specPath：home 相对批次约定 ./.scratch/<YYYYMMDD>/<slug>/spec.md */
function defaultSpecPath(slug: string): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  return `./.scratch/${ymd}/${slug}/spec.md`
}

/** S5 写回样板：重取 fresh → 在 fresh.phases 上做 transform → 整数组 PUT +
 *  If-Match。fresh.phases 缺失（异常态）回退开窗快照。 */
async function withPhases(
  task: Task,
  transform: (base: TaskPhase[]) => TaskPhase[],
): Promise<void> {
  const fresh = await getTask(task.id)
  const base = fresh.task_spec.phases ?? task.task_spec.phases ?? []
  const next = renumber(transform(base))
  await updateTask(
    task.id,
    { task_spec: { ...fresh.task_spec, phases: next } as TaskSpec },
    fresh.version,
  )
}

// ── PhaseListEditor（v4 唯一面） ─────────────────────────────────────

function PhaseListEditor({ task, onMutated }: WorkflowBoxProps) {
  const phases = task.task_spec.phases ?? []
  const isDraft = task.status === "draft"
  const [openPhaseIdx, setOpenPhaseIdx] = useState<number | null>(null)
  const [specPhase, setSpecPhase] = useState<TaskPhase | null>(null)
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 所有结构动作共用的串行闸：一次只有一个在飞（连点重排会连 bump version）。
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

  const handleMove = (index: number, dir: -1 | 1) =>
    void guard("已重排", async () => {
      await withPhases(task, (base) => {
        const pos = base.findIndex((p) => p.index === index)
        const to = pos + dir
        if (pos < 0 || to < 0 || to >= base.length) return base
        const next = [...base]
        const [row] = next.splice(pos, 1)
        next.splice(to, 0, row)
        return next
      })
    })

  const handleDelete = (index: number) =>
    void guard(`Phase ${index} 已删除`, async () => {
      await withPhases(task, (base) => base.filter((p) => p.index !== index))
    })

  const handleAdd = (row: { name: string; slug: string; workflowRef: string }) =>
    void guard(`Phase ${row.name} 已添加`, async () => {
      await withPhases(task, (base) => {
        if (base.some((p) => p.slug === row.slug)) {
          throw new Error(`slug「${row.slug}」已存在——换个目录名`)
        }
        return [
          ...base,
          {
            // index 由 renumber 统一位次重排（占位 9999 防与既有撞键）
            index: 9999,
            name: row.name,
            slug: row.slug,
            specPath: defaultSpecPath(row.slug),
            workflowRef: row.workflowRef as TaskPhase["workflowRef"],
            inputValues: {},
          },
        ]
      })
    })

  return (
    <div className="rounded-lg border bg-background px-3 py-2.5 space-y-2" data-workflow-box data-phase-binding-list>
      <div className="flex items-center gap-2">
        <Link2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">Phase 计划</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{phases.length} 个 phase</span>
      </div>

      {phases.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-phase-bind-empty>
          尚无 phase —— 对话里让 agent 拆分，或用下方「添加 Phase」手动建骨架。
        </p>
      ) : (
        phases.map((p, i) => (
          <PhaseRow
            key={p.index}
            task={task}
            phase={p}
            editable={isDraft}
            busy={busy}
            first={i === 0}
            last={i === phases.length - 1}
            canDelete={phases.length > 1}
            onMove={handleMove}
            onRequestDelete={setDeletingIdx}
            onOpenBind={setOpenPhaseIdx}
            onOpenSpec={setSpecPhase}
            onEdited={onMutated}
            busyGate={guard}
          />
        ))
      )}

      {isDraft && <AddPhaseRow busy={busy} onAdd={handleAdd} />}

      {!isDraft && (
        <p className="text-[10px] text-muted-foreground">
          结构编辑仅 draft 开放（入队后信封已物化冻结）；换绑定仍可用，跨轮传播走对话。
        </p>
      )}

      {openPhaseIdx !== null && (
        <WorkflowBindingDialog
          task={task}
          phaseIndex={openPhaseIdx}
          open
          onOpenChange={(o) => { if (!o) setOpenPhaseIdx(null) }}
          onMutated={onMutated}
        />
      )}

      {specPhase && (
        <PhaseSpecDialog
          task={task}
          phase={specPhase}
          open
          onOpenChange={(o) => { if (!o) setSpecPhase(null) }}
        />
      )}

      {/* 删除二次确认（不可撤销 —— 批次文件保留但脱离任务） */}
      <AlertDialog open={deletingIdx !== null} onOpenChange={(o) => { if (!o) setDeletingIdx(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Phase {deletingIdx}</AlertDialogTitle>
            <AlertDialogDescription>
              删除后其后 phase 自动重排编号。若该 phase 已有批次产物（spec/issues），文件不会被删除，但将脱离任务。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (deletingIdx != null) handleDelete(deletingIdx) }}
              className="bg-red-600 hover:bg-red-700"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── 单行（查看态 + draft 内联编辑 name/slug/specPath） ────────────────

interface PhaseRowProps {
  task: Task
  phase: TaskPhase
  editable: boolean
  busy: boolean
  first: boolean
  last: boolean
  canDelete: boolean
  onMove: (index: number, dir: -1 | 1) => void
  onRequestDelete: (index: number) => void
  onOpenBind: (index: number) => void
  onOpenSpec: (phase: TaskPhase) => void
  onEdited: () => void
  busyGate: (label: string, fn: () => Promise<void>) => Promise<void>
}

function PhaseRow({
  task, phase, editable, busy, first, last, canDelete,
  onMove, onRequestDelete, onOpenBind, onOpenSpec, onEdited, busyGate,
}: PhaseRowProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(phase.name)
  const [slug, setSlug] = useState(phase.slug)
  const [specPath, setSpecPath] = useState(phase.specPath)

  // 退出编辑态/外部刷新（SSE onMutated）→ 回到服务端事实
  useEffect(() => {
    if (!editing) {
      setName(phase.name)
      setSlug(phase.slug)
      setSpecPath(phase.specPath)
    }
  }, [phase, editing])

  const invalid =
    !name.trim() || name.trim().length > 100 ||
    !SLUG_RE.test(slug) || slug.length > 100 ||
    !specPath.trim()

  const handleSaveRow = () =>
    busyGate("已保存", async () => {
      await withPhases(task, (base) =>
        base.map((p) =>
          p.index === phase.index
            ? { ...p, name: name.trim(), slug, specPath: specPath.trim() }
            : p,
        ),
      )
      setEditing(false)
      onEdited()
    })

  return (
    <div
      className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1"
      data-phase-bind-card={phase.index}
    >
      {editing ? (
        <div className="space-y-1.5" data-phase-row-edit-form={phase.index}>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">name</Label>
            <Input
              className="h-6 text-xs"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              data-phase-name-input={phase.index}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">slug</Label>
            <Input
              className={`h-6 text-xs ${slug && !SLUG_RE.test(slug) ? "border-red-500" : ""}`}
              value={slug}
              maxLength={100}
              title="path-safe：字母/数字开头，可含 . _ -"
              onChange={(e) => setSlug(e.target.value)}
              data-phase-slug-input={phase.index}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">spec</Label>
            <Input
              className="h-6 text-xs font-mono"
              value={specPath}
              onChange={(e) => setSpecPath(e.target.value)}
              data-phase-specpath-input={phase.index}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setEditing(false)} disabled={busy} data-phase-edit-cancel={phase.index}>
              取消
            </Button>
            <Button size="sm" className="h-6 text-[10px]" onClick={() => void handleSaveRow()} disabled={invalid || busy} data-phase-edit-save={phase.index}>
              {busy ? <Spinner className="size-3 mr-1" /> : null}保存
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium truncate" data-phase-name={phase.index}>
              Phase {phase.index} · {phase.name}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground truncate" data-phase-slug={phase.index}>
              {phase.slug}
            </span>
            {phase.workflowRef ? (
              <Badge variant="secondary" className="text-[10px] max-w-[160px] truncate ml-auto" data-phase-workflow-ref={phase.index}>
                {phase.workflowRef}
              </Badge>
            ) : (
              <span className="text-[10px] text-amber-500 ml-auto" data-phase-unbound={phase.index}>
                未绑定
              </span>
            )}
          </div>
          <InputChips values={phase.inputValues ?? {}} />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] flex-1 justify-start"
              onClick={() => onOpenBind(phase.index)}
              data-phase-bind-button={phase.index}
            >
              {phase.workflowRef ? "更换工作流" : "绑定工作流"}
              <ChevronRight className="size-3 ml-auto" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              title={`编辑 spec.md：${phase.specPath}`}
              onClick={() => onOpenSpec(phase)}
              data-phase-spec-button={phase.index}
            >
              <FileText className="size-3" />
            </Button>
            {editable && (
              <>
                <Button
                  variant="ghost" size="sm" className="h-6 text-[10px] px-1.5" title="编辑名称/slug/spec 路径"
                  onClick={() => setEditing(true)}
                  data-phase-edit-button={phase.index}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 text-[10px] px-1" title="上移" disabled={first || busy}
                  onClick={() => onMove(phase.index, -1)}
                  data-phase-move-up={phase.index}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 text-[10px] px-1" title="下移" disabled={last || busy}
                  onClick={() => onMove(phase.index, 1)}
                  data-phase-move-down={phase.index}
                >
                  <ArrowDown className="size-3" />
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 text-[10px] px-1.5 text-red-500 hover:text-red-600"
                  title={canDelete ? "删除 phase" : "至少保留一个 phase"} disabled={!canDelete || busy}
                  onClick={() => onRequestDelete(phase.index)}
                  data-phase-delete-button={phase.index}
                >
                  <Trash2 className="size-3" />
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── 添加 Phase（仅 draft） ───────────────────────────────────────────

function AddPhaseRow({
  busy, onAdd,
}: {
  busy: boolean
  onAdd: (row: { name: string; slug: string; workflowRef: string }) => void
}) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [workflowRef, setWorkflowRef] = useState(DEFAULT_NEW_WORKFLOW)
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  const fetchedRef = useRef(false)

  // 目录一次拉取（票 10 缓存端点）；失败退化为「只有默认推荐项」的自由文本 ref。
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    listBuiltInWorkflows()
      .then((list) => {
        if (list.length > 0) setCatalog(list)
        if (!list.some((w) => w.ref === DEFAULT_NEW_WORKFLOW) && list[0]) {
          setWorkflowRef(list[0].ref)
        }
      })
      .catch(() => setCatalog([]))
  }, [])

  // slug 未手打过 → 跟随 name 简版 slugify
  const [slugTouched, setSlugTouched] = useState(false)
  const suggestedSlug = name
    .trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `phase-${catalog.length + 1}`
  const effectiveSlug = slugTouched ? slug : suggestedSlug
  const valid =
    name.trim().length > 0 && name.trim().length <= 100 &&
    SLUG_RE.test(effectiveSlug) && effectiveSlug.length <= 100

  const handleAdd = () => {
    if (!valid || busy) return
    onAdd({ name: name.trim(), slug: effectiveSlug, workflowRef })
    setName("")
    setSlug("")
    setSlugTouched(false)
  }

  return (
    <div className="rounded-md border border-dashed px-2.5 py-2 space-y-1.5" data-phase-add-form>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          <Plus className="inline size-3 mr-0.5" />添加 Phase
        </span>
        <span className="text-[9px] text-muted-foreground ml-auto font-mono">
          {defaultSpecPath(effectiveSlug || "…")}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-6 text-xs flex-1" placeholder="名称（≤100 字）" value={name} maxLength={100}
          onChange={(e) => setName(e.target.value)}
          data-phase-add-name
        />
        <Input
          className={`h-6 text-xs w-32 font-mono ${slugTouched && effectiveSlug && !SLUG_RE.test(effectiveSlug) ? "border-red-500" : ""}`}
          placeholder={`slug=${suggestedSlug}`} value={effectiveSlug} maxLength={100}
          onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }}
          data-phase-add-slug
        />
      </div>
      <div className="flex items-center gap-1.5">
        <select
          className="h-6 flex-1 min-w-0 rounded-md border border-border bg-background px-1.5 text-[11px]"
          value={workflowRef}
          onChange={(e) => setWorkflowRef(e.target.value)}
          data-phase-add-workflow
        >
          {(catalog.length > 0 ? catalog.map((w) => w.ref) : [workflowRef]).map((ref) => (
            <option key={ref} value={ref}>{ref}</option>
          ))}
        </select>
        <Button size="sm" className="h-6 text-[10px]" onClick={handleAdd} disabled={!valid || busy} data-phase-add-submit>
          {busy ? <Spinner className="size-3 mr-1" /> : null}添加
        </Button>
      </div>
      <p className="text-[9px] text-muted-foreground">
        新 phase 的必填 inputs 请随后点「绑定工作流」补（或留占位符由 server 解析）。
      </p>
    </div>
  )
}

// ── 绑定弹窗（v4-phase 专用） ────────────────────────────────────────

interface WorkflowBindingDialogProps {
  task: Task
  /** 绑定的目标 phase（1-based index）。 */
  phaseIndex: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onMutated: () => void
}

type InputDefs = NonNullable<BuiltInWorkflowSummary["inputs"]>

function WorkflowBindingDialog({ task, phaseIndex, open, onOpenChange, onMutated }: WorkflowBindingDialogProps) {
  // 当前绑定（开窗快照，仅用于初始选中/预填；写回吃 S5 的重取结果）。
  const phase = (task.task_spec.phases ?? []).find((p) => p.index === phaseIndex) ?? null
  const initialRef = phase?.workflowRef ?? ""
  const initialInputs = phase?.inputValues ?? {}

  // ── 目录（S2 修：effect 只依赖 [open]） ──
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  // StrictMode dev 下 setup→cleanup→setup 会双跑；ref 守卫保证「每次开窗恰
  // 一次 fetch」（AC4 网络计数），关窗复位。
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      fetchedRef.current = false
      return
    }
    if (fetchedRef.current) return
    fetchedRef.current = true
    setCatalogLoading(true)
    // AC-20：每次开窗恰一次 list fetch（票 10 缓存端点，热路径零 parse）。
    // 无 cancelled 清理：StrictMode 双跑下若首次 fetch 被判死，ref 守卫会让
    // 第二次跳过 → 列表永远为空。setState-after-unmount 在 React 18 是 no-op。
    listBuiltInWorkflows()
      .then((list) => setCatalog(list))
      .catch(() => setCatalog([]))
      .finally(() => setCatalogLoading(false))
  }, [open])

  const [search, setSearch] = useState("")
  const filteredWorkflows = useMemo(() => {
    if (!search.trim()) return catalog
    const q = search.toLowerCase()
    return catalog.filter(
      (w) => w.ref.toLowerCase().includes(q) || w.name.toLowerCase().includes(q),
    )
  }, [catalog, search])

  // ── 选中 + inputs 表单（inputs 直接吃 summary，无 detail fetch） ──
  const [selectedRef, setSelectedRef] = useState<string | null>(initialRef || null)
  const [formInputs, setFormInputs] = useState<Record<string, string>>({ ...initialInputs })

  const handleSelectWorkflow = useCallback((ref: string) => {
    setSelectedRef(ref)
    // goal-task-dev T06 (N) 语义保持：手工换选清空旧值（不跨选择泄漏）。
    setFormInputs({})
  }, [])

  useEffect(() => {
    if (!open) {
      setSelectedRef(null)
      setFormInputs({})
      setSearch("")
      return
    }
    setSelectedRef(initialRef || null)
    setFormInputs({ ...initialInputs })
    setSearch("")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on open only
  }, [open])

  const selectedEntry = useMemo(
    () => catalog.find((w) => w.ref === selectedRef) ?? null,
    [catalog, selectedRef],
  )
  const inputDefs: InputDefs = selectedEntry?.inputs ?? {}

  // YAML 预览 = 可选深读（默认折叠，展开时才 fetch，展开结果缓存）。
  const [yaml, setYaml] = useState<string | null>(null)
  const [yamlLoading, setYamlLoading] = useState(false)

  useEffect(() => {
    setYaml(null)
  }, [selectedRef])

  const handleYamlToggle = useCallback((el: HTMLDetailsElement) => {
    if (el.open && selectedRef && yaml === null && !yamlLoading) {
      setYamlLoading(true)
      getBuiltInWorkflowDetail(selectedRef)
        .then((d) => setYaml(d.content))
        .catch(() => setYaml(""))
        .finally(() => setYamlLoading(false))
    }
  }, [selectedRef, yaml, yamlLoading])

  // ── 保存（S5 修：写回前重取 version；phases 整数组 PUT） ──────────
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!selectedRef || saving) return
    setSaving(true)
    try {
      // 只持久被编辑/预填的非空值；未动的 YAML default 不落库（default 赢）。
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(formInputs)) {
        if (v && v.trim()) cleaned[k] = v
      }
      // S5：If-Match 用重取的 version，不用开窗快照（agent spec-field 并发
      // bump / 10s 轮询换 prop 都不再 409）。fresh.phases 里没有该 index =
      // agent 改写了拆分表 → 拒绝盖写，让用户重开弹窗。
      const fresh = await getTask(task.id)
      const freshSpec = fresh.task_spec
      const basePhases: TaskPhase[] = freshSpec.phases ?? task.task_spec.phases ?? []
      const pos = basePhases.findIndex((p) => p.index === phaseIndex)
      if (pos < 0) {
        throw new Error("phase 计划已被改写（编号不存在），请关闭后重开绑定弹窗")
      }
      const nextPhases = basePhases.map((p, i) =>
        i === pos ? { ...p, workflowRef: selectedRef as TaskPhase["workflowRef"], inputValues: cleaned } : p,
      )
      await updateTask(
        task.id,
        { task_spec: { ...freshSpec, phases: nextPhases } as TaskSpec },
        fresh.version,
      )
      toast.success(`Phase ${phaseIndex} 已绑定工作流: ${selectedRef}`)
      onMutated()
      onOpenChange(false)
    } catch (err) {
      toast.error(`绑定失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [selectedRef, formInputs, task, phaseIndex, saving, onMutated, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">绑定工作流 — Phase {phaseIndex}</DialogTitle>
          <DialogDescription className="text-xs">
            <>选择内置工作流并配置输入。支持 {"${phase.slug}"} / {"${phase.spec_dir}"} / {"${task.home}"} / {"${task_artifacts_dir}"} 占位符。</>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 gap-3">
          {/* 左：目录列表（选中/搜索期间永不整列重取——S2 修复后不再有 spinner 闪） */}
          <div className="flex flex-col min-h-0 w-[45%]">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1.5 size-3 text-muted-foreground" />
              <Input
                placeholder="搜索工作流…"
                className="h-7 pl-7 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-binding-search
              />
            </div>

            <ScrollArea className="flex-1 min-h-0" data-binding-list-scroll>
              {catalogLoading && catalog.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner className="size-4" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground px-1 mb-1">
                    {search ? `搜索结果 (${filteredWorkflows.length})` : `全部内置 (${filteredWorkflows.length})`}
                  </div>
                  {filteredWorkflows.map((w) => (
                    <button
                      key={w.ref}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors ${
                        selectedRef === w.ref ? "bg-accent" : ""
                      }`}
                      onClick={() => handleSelectWorkflow(w.ref)}
                      data-workflow-item={w.ref}
                    >
                      <div className="font-medium">{w.name}</div>
                      <div className="text-[10px] text-muted-foreground">{w.ref}</div>
                    </button>
                  ))}
                  {filteredWorkflows.length === 0 && (
                    <div className="px-2 py-4 text-[11px] text-muted-foreground">无匹配工作流</div>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* 右：详情（inputs 来自目录 summary）+ 折叠 YAML 预览 */}
          <div className="flex flex-col min-h-0 flex-1 border-l pl-3">
            {selectedEntry ? (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">{selectedEntry.name}</div>
                    <div className="text-[10px] text-muted-foreground">{selectedEntry.ref}</div>
                  </div>

                  {Object.keys(inputDefs).length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-medium">输入</div>
                      {Object.entries(inputDefs).map(([name, def]) => (
                        <div key={name} className="space-y-0.5">
                          <Label className="text-[10px] flex items-center gap-1">
                            {name}
                            {def.required && <span className="text-red-500">*</span>}
                          </Label>
                          <Input
                            className="h-6 text-xs"
                            placeholder={def.description || (def.required ? "必填" : "可选")}
                            value={formInputs[name] ?? def.default ?? ""}
                            onChange={(e) =>
                              setFormInputs((prev) => ({ ...prev, [name]: e.target.value }))
                            }
                            data-input-field={name}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <details
                    className="text-[10px]"
                    onToggle={(e) => handleYamlToggle(e.currentTarget)}
                  >
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      YAML 预览
                    </summary>
                    {yamlLoading ? (
                      <div className="mt-1 flex items-center gap-2 text-muted-foreground"><Spinner className="size-3" /> 读取…</div>
                    ) : (
                      <pre className="mt-1 p-2 rounded bg-muted text-[9px] overflow-x-auto max-h-40">
                        {yaml ? yaml.slice(0, 1000) + (yaml.length > 1000 ? "\n…(truncated)" : "") : ""}
                      </pre>
                    )}
                  </details>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
                选择左侧工作流查看详情
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!selectedRef || saving}
            onClick={() => void handleSave()}
            data-bind-save-button
          >
            {saving ? <Spinner className="size-3 mr-1" /> : null}
            {saving ? "保存中…" : "绑定"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
