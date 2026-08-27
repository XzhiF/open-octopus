// packages/web-app/components/tasks/authoring/workflow-box.tsx
//
// task-workflow-presets (T6): WorkflowBox — shared component for workflow
// binding. Displays current workflow_ref + input_values status, opens a
// binding dialog for search/detail/inputs form.
//
// Used in:
//   - v3 AuthoringWorkspace: between GoalAcCard and OutputViewer
//   - v2 SpecPanel: bottom area (alongside spec editing)
//
// The binding dialog fetches presets from GET /api/workflow-presets (filtered
// by task.skill_groups + general fallback), shows details from
// GET /api/workflows/built-in/:ref, and saves via PUT /api/tasks/:id with
// workflow_ref + task_spec.input_values atomically.

"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Link2, Search, ChevronRight, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec } from "@octopus/shared"
import { updateTask } from "@/lib/tasks-api"
import {
  listWorkflowPresets,
  getBuiltInWorkflowDetail,
  listBuiltInWorkflows,
  type WorkflowPreset,
  type BuiltInWorkflowDetail,
  type BuiltInWorkflowSummary,
} from "@/lib/workflow-presets-api"

export interface WorkflowBoxProps {
  task: Task
  onMutated: () => void
}

export function WorkflowBox({ task, onMutated }: WorkflowBoxProps) {
  const spec = task.task_spec
  const workflowRef = task.workflow_ref
  const inputValues = spec.input_values ?? {}
  const isBound = !!workflowRef

  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div className="rounded-lg border bg-background px-3 py-2.5 space-y-1.5" data-workflow-box>
      <div className="flex items-center gap-2">
        <Link2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">工作流</span>
        {isBound ? (
          <Badge variant="secondary" className="text-[10px] ml-auto" data-workflow-ref-badge>
            {workflowRef}
          </Badge>
        ) : (
          <span className="text-[10px] text-muted-foreground ml-auto" data-workflow-unbound>
            未绑定
          </span>
        )}
      </div>

      {/* Input values summary chips */}
      {isBound && Object.keys(inputValues).length > 0 && (
        <div className="flex flex-wrap gap-1" data-input-chips>
          {Object.entries(inputValues).map(([key, value]) => {
            const source = describeInputShape(value)
            return (
              <Badge key={key} variant="outline" className="text-[9px] py-0 h-4">
                {key}: {source}
              </Badge>
            )
          })}
        </div>
      )}

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
    </div>
  )
}

/** Classify an input value's placeholder SHAPE for the chip label — whether it
 *  is a pure ${goal} / ${ac} template, a mixed template, or a literal value
 *  (truncated). Distinguishes "came from WHAT" vs "hand-typed" at a glance. */
function describeInputShape(value: string): string {
  if (value === "${goal}") return "${goal}"
  if (value === "${ac}") return "${ac}"
  if (value.includes("${goal}")) return "goal+…"
  if (value.includes("${ac}")) return "ac+…"
  // Truncate long literal values
  return value.length > 20 ? value.slice(0, 17) + "…" : value
}

// ── Binding Dialog ─────────────────────────────────────────────────

interface WorkflowBindingDialogProps {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  onMutated: () => void
}

function WorkflowBindingDialog({ task, open, onOpenChange, onMutated }: WorkflowBindingDialogProps) {
  const skillGroups = task.task_spec.skill_groups ?? []

  // Data loading
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [allWorkflows, setAllWorkflows] = useState<BuiltInWorkflowSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")

  useEffect(() => {
    if (!open) return
    setLoading(true)
    Promise.all([
      listWorkflowPresets(skillGroups.length > 0 ? skillGroups : undefined),
      listBuiltInWorkflows(),
    ])
      .then(([presetResult, wfList]) => {
        setPresets(presetResult.presets)
        setAllWorkflows(wfList)
      })
      .catch(() => {
        setPresets([])
        setAllWorkflows([])
      })
      .finally(() => setLoading(false))
  }, [open, skillGroups])

  // Filter workflows by search
  const filteredWorkflows = useMemo(() => {
    if (!search.trim()) return allWorkflows
    const q = search.toLowerCase()
    return allWorkflows.filter(
      (w) => w.ref.toLowerCase().includes(q) || w.name.toLowerCase().includes(q),
    )
  }, [allWorkflows, search])

  // Selected workflow detail
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<BuiltInWorkflowDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const handleSelectWorkflow = useCallback((ref: string) => {
    setSelectedRef(ref)
    setDetailLoading(true)
    getBuiltInWorkflowDetail(ref)
      .then(setSelectedDetail)
      .catch(() => setSelectedDetail(null))
      .finally(() => setDetailLoading(false))
  }, [])

  // Input values form state
  const [formInputs, setFormInputs] = useState<Record<string, string>>({})

  // When a preset is clicked, pre-fill form inputs from its skeleton
  const handleSelectPreset = useCallback((preset: WorkflowPreset) => {
    setSelectedRef(preset.workflow)
    setFormInputs({ ...preset.inputs })
    // Load detail for the preset's workflow
    setDetailLoading(true)
    getBuiltInWorkflowDetail(preset.workflow)
      .then(setSelectedDetail)
      .catch(() => setSelectedDetail(null))
      .finally(() => setDetailLoading(false))
  }, [])

  // Save: PUT /api/tasks/:id with workflow_ref + input_values
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!selectedRef || saving) return
    setSaving(true)
    try {
      const updatedSpec: Partial<TaskSpec> = {
        ...task.task_spec,
        input_values: Object.keys(formInputs).length > 0 ? formInputs : undefined,
      }
      // Remove undefined keys from input_values to keep it clean
      if (updatedSpec.input_values) {
        const cleaned: Record<string, string> = {}
        for (const [k, v] of Object.entries(updatedSpec.input_values)) {
          if (v && v.trim()) cleaned[k] = v
        }
        updatedSpec.input_values = Object.keys(cleaned).length > 0 ? cleaned : undefined
      }
      await updateTask(
        task.id,
        {
          workflow_ref: selectedRef,
          task_spec: updatedSpec as TaskSpec,
        },
        task.version,
      )
      toast.success(`已绑定工作流: ${selectedRef}`)
      onMutated()
      onOpenChange(false)
    } catch (err) {
      toast.error(`绑定失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [selectedRef, formInputs, task, saving, onMutated, onOpenChange])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedRef(null)
      setSelectedDetail(null)
      setFormInputs({})
      setSearch("")
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">绑定工作流</DialogTitle>
          <DialogDescription className="text-xs">
            选择工作流并配置输入。支持 ${"${goal}"} / ${"${ac}"} 占位符。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 gap-3">
          {/* Left: preset list + search + all workflows */}
          <div className="flex flex-col min-h-0 w-[45%]">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1.5 size-3 text-muted-foreground" />
              <Input
                placeholder="搜索工作流…"
                className="h-7 pl-7 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <ScrollArea className="flex-1 min-h-0">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner className="size-4" />
                </div>
              ) : (
                <div className="space-y-1">
                  {/* Recommended presets */}
                  {presets.length > 0 && !search && (
                    <div className="mb-2">
                      <div className="text-[10px] text-muted-foreground px-1 mb-1">推荐</div>
                      {presets.map((p) => (
                        <button
                          key={p.name}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors ${
                            selectedRef === p.workflow ? "bg-accent" : ""
                          }`}
                          onClick={() => handleSelectPreset(p)}
                          data-preset-item={p.name}
                        >
                          <div className="font-medium">{p.name}</div>
                          <div className="text-[10px] text-muted-foreground">{p.workflow}</div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* All workflows */}
                  <div className="text-[10px] text-muted-foreground px-1 mb-1">
                    {search ? `搜索结果 (${filteredWorkflows.length})` : "全部内置"}
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
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Right: detail + inputs form */}
          <div className="flex flex-col min-h-0 flex-1 border-l pl-3">
            {detailLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="size-4" />
              </div>
            ) : selectedDetail ? (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">{selectedDetail.parsed.name}</div>
                    <div className="text-[10px] text-muted-foreground">{selectedRef}</div>
                  </div>

                  {selectedDetail.parsed.description && (
                    <p className="text-[11px] text-muted-foreground">
                      {selectedDetail.parsed.description}
                    </p>
                  )}

                  {/* Inputs form */}
                  {selectedDetail.parsed.inputs && Object.keys(selectedDetail.parsed.inputs).length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-medium">输入</div>
                      {Object.entries(selectedDetail.parsed.inputs).map(([name, def]) => (
                        <div key={name} className="space-y-0.5">
                          <Label className="text-[10px] flex items-center gap-1">
                            {name}
                            {def.required && <span className="text-red-500">*</span>}
                          </Label>
                          <Input
                            className="h-6 text-xs"
                            placeholder={def.description || (def.required ? "必填" : "可选")}
                            value={formInputs[name] ?? ""}
                            onChange={(e) =>
                              setFormInputs((prev) => ({ ...prev, [name]: e.target.value }))
                            }
                            data-input-field={name}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* YAML preview (collapsed) */}
                  <details className="text-[10px]">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      YAML 预览
                    </summary>
                    <pre className="mt-1 p-2 rounded bg-muted text-[9px] overflow-x-auto max-h-40">
                      {selectedDetail.content.slice(0, 1000)}
                      {selectedDetail.content.length > 1000 && "\n…(truncated)"}
                    </pre>
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

        {/* Footer: save button */}
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
