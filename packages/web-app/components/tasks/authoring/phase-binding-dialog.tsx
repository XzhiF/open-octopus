// packages/web-app/components/tasks/authoring/phase-binding-dialog.tsx
//
// 绑定工作流弹窗（v4-phase 专用；2026-09-24 原型改版后从 workflow-box.tsx
// 原样迁出）。可选项 = workflow-presets.yaml 绑定目录；inputs 定义镜像来自
// built-in 域（GET /api/workflows/built-in）。S2/S5/AC-20 纪律保持：
// 取数 effect 只依赖 [open]、每次开窗恰一次 fetch、保存前重取 version。

"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Search, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getTask, updateTask } from "@/lib/tasks-api"
import {
  getBuiltInWorkflowDetail,
  listBuiltInWorkflows,
  listWorkflowPresets,
  type BuiltInWorkflowSummary,
  type WorkflowPreset,
} from "@/lib/workflow-presets-api"

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

export function WorkflowBindingDialog({ task, phaseIndex, open, onOpenChange, onMutated }: WorkflowBindingDialogProps) {
  // 当前绑定（开窗快照，仅用于初始选中/预填；写回吃 S5 的重取结果）。
  const phase = (task.task_spec.phases ?? []).find((p) => p.index === phaseIndex) ?? null
  const initialRef = phase?.workflowRef ?? ""
  const initialInputs = phase?.inputValues ?? {}

  // ── 绑定目录 + 输入定义镜像（S2 修：effect 只依赖 [open]） ──
  // presets = 可选项（workflow-presets.yaml）；defs = built-in 工作流的
  // inputs 定义镜像（required/默认值渲染），**不**作可选项列表出现。
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [defs, setDefs] = useState<BuiltInWorkflowSummary[]>([])
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
    // AC-20：每次开窗恰一次 catalog fetch + 一次 defs fetch（票 10 缓存端点，
    // 热路径零 parse）。无 cancelled 清理：StrictMode 双跑下若首次 fetch 被判死，
    // ref 守卫会让第二次跳过 → 列表永远为空。setState-after-unmount 在 React 18 是 no-op。
    Promise.all([listWorkflowPresets(), listBuiltInWorkflows()])
      .then(([cat, wfDefs]) => {
        setPresets(cat.presets)
        setDefs(wfDefs)
      })
      .catch(() => {
        setPresets([])
        setDefs([])
      })
      .finally(() => setCatalogLoading(false))
  }, [open])

  const [search, setSearch] = useState("")
  const filteredPresets = useMemo(() => {
    if (!search.trim()) return presets
    const q = search.toLowerCase()
    return presets.filter(
      (w) => w.workflow.toLowerCase().includes(q) || w.name.toLowerCase().includes(q),
    )
  }, [presets, search])

  // ── 选中 + inputs 表单（定义来自 defs，初值来自目录骨架） ──
  const [selectedRef, setSelectedRef] = useState<string | null>(initialRef || null)
  const [formInputs, setFormInputs] = useState<Record<string, string>>({ ...initialInputs })

  const handleSelectWorkflow = useCallback((ref: string) => {
    setSelectedRef(ref)
    // 目录骨架预填（goal-task-dev T06 (N) 语义演进：换选不再清空，而是换上
    // 新条目自己的骨架 —— 不跨条目泄漏）。
    setFormInputs({ ...(presets.find((w) => w.workflow === ref)?.inputs ?? {}) })
  }, [presets])

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

  const selectedPreset = useMemo(
    () => presets.find((w) => w.workflow === selectedRef) ?? null,
    [presets, selectedRef],
  )
  const selectedDef = useMemo(
    () => defs.find((w) => w.ref === selectedRef) ?? null,
    [defs, selectedRef],
  )
  const inputDefs: InputDefs = selectedDef?.inputs ?? {}

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
        // 人工在弹窗保存 = 该 phase 的绑定确认闸（bindingConfirmed）；
        // agent 之后整数组改写 phases 会丢掉此字段 → 回到待确认（入队 gate ⑤）。
        i === pos
          ? { ...p, workflowRef: selectedRef as TaskPhase["workflowRef"], inputValues: cleaned, bindingConfirmed: true }
          : p,
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
            <>可选项来自绑定目录（workflow-presets.yaml）。支持 {"${phase.slug}"} / {"${phase.spec_dir}"} / {"${phase.batch_rel}"} / {"${task.home}"} / {"${task_artifacts_dir}"} 占位符。</>
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
              {catalogLoading && presets.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner className="size-4" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground px-1 mb-1">
                    {search ? `搜索结果 (${filteredPresets.length})` : `绑定目录 (${filteredPresets.length})`}
                  </div>
                  {filteredPresets.map((w) => (
                    <button
                      key={w.workflow}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors ${
                        selectedRef === w.workflow ? "bg-accent" : ""
                      }`}
                      onClick={() => handleSelectWorkflow(w.workflow)}
                      data-workflow-item={w.workflow}
                    >
                      <div className="font-medium">{w.name}</div>
                      <div className="text-[10px] text-muted-foreground">{w.workflow}</div>
                      {w.desc && (
                        <div className="text-[9px] text-muted-foreground line-clamp-2">{w.desc}</div>
                      )}
                    </button>
                  ))}
                  {filteredPresets.length === 0 && (
                    <div className="px-2 py-4 text-[11px] text-muted-foreground">
                      绑定目录为空——编辑 task-author 的 workflow-presets.yaml 放行工作流
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* 右：详情（inputs 来自目录 summary）+ 折叠 YAML 预览 */}
          <div className="flex flex-col min-h-0 flex-1 border-l pl-3">
            {selectedRef ? (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">{selectedPreset?.name ?? selectedDef?.name ?? selectedRef}</div>
                    <div className="text-[10px] text-muted-foreground">{selectedRef}</div>
                    {selectedPreset?.desc && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{selectedPreset.desc}</div>
                    )}
                  </div>

                  {(() => {
                    // 字段三源并集：YAML 定义（required/描述）∪ 目录骨架 ∪ 该
                    // phase 现值 —— task-home 自建流没有定义镜像也可编可见。
                    const names = Array.from(new Set([
                      ...Object.keys(inputDefs),
                      ...Object.keys(selectedPreset?.inputs ?? {}),
                      ...Object.keys(formInputs),
                    ]))
                    if (names.length === 0) return null
                    return (
                      <div className="space-y-2">
                        <div className="text-[10px] font-medium">输入</div>
                        {names.map((name) => {
                          const def = inputDefs[name]
                          return (
                            <div key={name} className="space-y-0.5">
                              <Label className="text-[10px] flex items-center gap-1">
                                {name}
                                {def?.required && <span className="text-pop-red">*</span>}
                              </Label>
                              <Input
                                className="h-6 text-xs font-mono"
                                placeholder={def?.description || (def?.required ? "必填" : "可选")}
                                value={formInputs[name] ?? def?.default ?? ""}
                                onChange={(e) =>
                                  setFormInputs((prev) => ({ ...prev, [name]: e.target.value }))
                                }
                                data-input-field={name}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}

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
