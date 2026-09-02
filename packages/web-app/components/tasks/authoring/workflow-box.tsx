// packages/web-app/components/tasks/authoring/workflow-box.tsx
//
// 票 12 重写：工作流绑定卡。task-phase-redesign v4 = per-phase 绑定卡列表
// （数据源 GET /api/workflows/built-in — 票 10 缓存端点；写回走 PUT
// task_spec.phases 整数组 + If-Match）；v3/legacy = 单卡（task.workflow_ref +
// task_spec.input_values）。
//
// 调研卡顿修复（本票一并落地）：
//   S2 — 旧版 useEffect deps 带 `task.task_spec.skill_groups ?? []`（每次渲染
//        新数组引用 → 开窗后重渲染即重取 → spinner 闪、列表清）。现在取数
//        effect 只依赖 [open]（稳定），preset 目录链整体退役（K13）。
//   S5 — 旧版 If-Match 用开窗快照 task.version（agent spec-field 并发 bump 后
//        必 409）。现在保存前 getTask 重取最新 version（票 07 AC5 的 phases
//        整数组 PUT 语义同样吃这个 version）。
//   S6 — preset 推荐/搜索段退役：弹窗内不再有 data-preset-item；列表只有
//        built-in 目录 + 客户端搜索。
//   AC-20（票 10 移交）— 弹窗打开期间 list fetch 计数=1：inputs 表单直接吃
//        summary 里已带的 inputs（list 端点返回），YAML 预览按需才拉 detail。

"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Link2, Search, ChevronRight, Eye } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getTask, updateTask } from "@/lib/tasks-api"
import { WorkflowViewerDialog } from "@/components/tasks/authoring/workflow-viewer-dialog"
import {
  getBuiltInWorkflowDetail,
  listBuiltInWorkflows,
  type BuiltInWorkflowSummary,
} from "@/lib/workflow-presets-api"

export interface WorkflowBoxProps {
  task: Task
  onMutated: () => void
}

export function WorkflowBox({ task, onMutated }: WorkflowBoxProps) {
  if (task.task_spec.format === "v4") {
    return <PhaseBindingList task={task} onMutated={onMutated} />
  }
  return <V3WorkflowBox task={task} onMutated={onMutated} />
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

// ── v4：per-phase 绑定卡列表 ─────────────────────────────────────────

function PhaseBindingList({ task, onMutated }: WorkflowBoxProps) {
  const phases = task.task_spec.phases ?? []
  const [openPhaseIdx, setOpenPhaseIdx] = useState<number | null>(null)

  return (
    <div className="rounded-lg border bg-background px-3 py-2.5 space-y-2" data-workflow-box data-phase-binding-list>
      <div className="flex items-center gap-2">
        <Link2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">逐 Phase 工作流绑定</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{phases.length} 个 phase</span>
      </div>

      {phases.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-phase-bind-empty>
          尚无 phase —— 拆分确认后（对话出口）逐 phase 出现绑定卡。
        </p>
      ) : (
        phases.map((p) => (
          <div
            key={p.index}
            className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1"
            data-phase-bind-card={p.index}
          >
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium truncate">
                Phase {p.index} · {p.name}
              </span>
              {p.workflowRef ? (
                <Badge variant="secondary" className="text-[10px] max-w-[180px] truncate ml-auto" data-phase-workflow-ref={p.index}>
                  {p.workflowRef}
                </Badge>
              ) : (
                <span className="text-[10px] text-amber-500 ml-auto" data-phase-unbound={p.index}>
                  未绑定
                </span>
              )}
            </div>
            <InputChips values={p.inputValues ?? {}} />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] w-full justify-start"
              onClick={() => setOpenPhaseIdx(p.index)}
              data-phase-bind-button={p.index}
            >
              {p.workflowRef ? "更换工作流" : "绑定工作流"}
              <ChevronRight className="size-3 ml-auto" />
            </Button>
          </div>
        ))
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
    </div>
  )
}

// ── v3/legacy：任务级单卡（行为保持，数据源/S2/S5 已修） ─────────────

function V3WorkflowBox({ task, onMutated }: WorkflowBoxProps) {
  const workflowRef = task.workflow_ref
  const isBound = !!workflowRef
  const [dialogOpen, setDialogOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)

  return (
    <div className="rounded-lg border bg-background px-3 py-2.5 space-y-1.5" data-workflow-box>
      <div className="flex items-center gap-2">
        <Link2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">工作流</span>
        {isBound ? (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-md pl-1.5 pr-1 py-0.5 hover:bg-accent transition-colors"
            title="点击查看完整内容"
            onClick={() => setViewerOpen(true)}
            data-workflow-view-button
          >
            <Badge variant="secondary" className="text-[10px] max-w-[180px] truncate" data-workflow-ref-badge>
              {workflowRef}
            </Badge>
            <Eye className="size-3 text-muted-foreground shrink-0" />
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground ml-auto" data-workflow-unbound>
            未绑定
          </span>
        )}
      </div>

      {isBound && <InputChips values={task.task_spec.input_values ?? {}} />}

      <Button
        variant="ghost"
        size="sm"
        className="h-6 text-[10px] w-full justify-start"
        onClick={() => setDialogOpen(true)}
        data-workflow-bind-button
      >
        {isBound ? "更换工作流" : "绑定工作流"}
        <ChevronRight className="size-3 ml-auto" />
      </Button>

      <WorkflowBindingDialog
        task={task}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onMutated={onMutated}
      />

      <WorkflowViewerDialog
        taskId={task.id}
        workflowRef={workflowRef ?? null}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
      />
    </div>
  )
}

// ── 绑定弹窗（v3 / v4-phase 共用） ──────────────────────────────────

interface WorkflowBindingDialogProps {
  task: Task
  /** v4：绑定的目标 phase（1-based index）。缺省 = v3 任务级绑定。 */
  phaseIndex?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onMutated: () => void
}

type InputDefs = NonNullable<BuiltInWorkflowSummary["inputs"]>

function WorkflowBindingDialog({ task, phaseIndex, open, onOpenChange, onMutated }: WorkflowBindingDialogProps) {
  const isV4 = task.task_spec.format === "v4" && phaseIndex != null

  // 当前绑定（开窗快照，仅用于初始选中/预填；写回吃 S5 的重取结果）。
  const phase = isV4
    ? (task.task_spec.phases ?? []).find((p) => p.index === phaseIndex) ?? null
    : null
  const initialRef = isV4 ? (phase?.workflowRef ?? "") : (task.workflow_ref ?? "")
  const initialInputs = isV4 ? (phase?.inputValues ?? {}) : (task.task_spec.input_values ?? {})

  // ── 目录（S2 修：effect 只依赖 [open]，无 skillGroups 之类的引用型 dep） ──
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  // StrictMode dev 下 setup→cleanup→setup 会双跑；ref 守卫保证「每次开窗恰
  // 一次 fetch」（AC4 网络计数），关窗复位（v3 弹窗常驻挂载）。
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
    // 无 cancelled 清理：StrictMode 的 setup→cleanup→setup 双跑下，若首次
    // fetch 被 cleanup 判死，ref 守卫会让第二次跳过 → 列表永远为空。
    // setState-after-unmount 在 React 18 是 no-op，安全。
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

  // 开窗时从最新绑定预填（v3 弹窗常驻挂载，useState 初值只在首挂载生效；
  // v4 每次开窗重新挂载，语义一致）。
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

  // YAML 预览 = 可选深读（默认折叠，展开时才 fetch，展开结果缓存）——保证
  // 「打开期间 list/detail fetch 不失控」。
  const [yaml, setYaml] = useState<string | null>(null)
  const [yamlLoading, setYamlLoading] = useState(false)

  useEffect(() => {
    setYaml(null)
  }, [selectedRef])

  // 非受控 <details>（受控 open 与浏览器原生 toggle 会互相打架）；onToggle
  // 仅在展开且未缓存时拉 detail。
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
      // bump / 10s 轮询换 prop 都不再 409）。
      const fresh = await getTask(task.id)
      const freshSpec = fresh.task_spec
      if (isV4 && phaseIndex != null) {
        const basePhases: TaskPhase[] = freshSpec.phases ?? task.task_spec.phases ?? []
        const pos = basePhases.findIndex((p) => p.index === phaseIndex)
        if (pos < 0) {
          throw new Error("phase 计划已被改写（编号不存在），请关闭后重开绑定弹窗")
        }
        const nextPhases = basePhases.map((p, i) =>
          i === pos ? { ...p, workflowRef: selectedRef as TaskPhase["workflowRef"], inputValues: cleaned } : p,
        )
        // 票面契约：整数组 PUT（task-workflow-presets 的 task_spec 合并语义）。
        await updateTask(
          task.id,
          { task_spec: { ...freshSpec, phases: nextPhases } as TaskSpec },
          fresh.version,
        )
        toast.success(`Phase ${phaseIndex} 已绑定工作流: ${selectedRef}`)
      } else {
        await updateTask(
          task.id,
          {
            workflow_ref: selectedRef,
            task_spec: {
              ...freshSpec,
              input_values: Object.keys(cleaned).length > 0 ? cleaned : undefined,
            } as TaskSpec,
          },
          fresh.version,
        )
        toast.success(`已绑定工作流: ${selectedRef}`)
      }
      onMutated()
      onOpenChange(false)
    } catch (err) {
      toast.error(`绑定失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [selectedRef, formInputs, task, isV4, phaseIndex, saving, onMutated, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            {isV4 ? `绑定工作流 — Phase ${phaseIndex}` : "绑定工作流"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isV4
              ? <>选择内置工作流并配置输入。支持 {"${goal}"} / {"${ac}"} / {"${phase.slug}"} / {"${phase.spec_dir}"} / {"${task.home}"} / {"${task_artifacts_dir}"} 占位符。</>
              : <>选择工作流并配置输入。支持 {"${goal}"} / {"${ac}"} 占位符。</>}
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
