"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Check,
  ChevronsUpDown,
  FolderOpen,
  Plus,
  Settings,
  Trash2,
  X,
  Loader2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { cn } from "@/lib/utils"
import { fetchBuiltInWorkflows } from "@/lib/api-client"

// ── Types ──────────────────────────────────────────────────────────

interface WorkflowInputDef {
  description: string
  required: boolean
  default: string
}

interface WorkflowOption {
  value: string
  label: string
  name: string
  group: "built-in" | "local"
  inputs?: Record<string, WorkflowInputDef>
}

export interface ChainStep {
  workflow_ref: string
  input_values: Record<string, string>
  // Populated for display
  _label?: string
  _inputs?: Record<string, WorkflowInputDef>
}

interface WorkflowChainDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: ChainStep[]
  onChange: (chain: ChainStep[]) => void
}

// ── Main Dialog ────────────────────────────────────────────────────

export function WorkflowChainDialog({
  open,
  onOpenChange,
  value,
  onChange,
}: WorkflowChainDialogProps) {
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([])
  const [loading, setLoading] = useState(true)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<ChainStep[]>(value)

  // Load built-in workflows
  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetchBuiltInWorkflows()
      .then((items: Array<{ ref: string; name: string; inputs?: Record<string, WorkflowInputDef> }>) => {
        const options: WorkflowOption[] = items.map((w) => ({
          value: w.ref,
          label: w.ref || w.name,
          name: w.name,
          group: "built-in" as const,
          inputs: w.inputs,
        }))
        setWorkflowOptions(options)
      })
      .catch(() => setWorkflowOptions([]))
      .finally(() => setLoading(false))
  }, [open])

  // Sync draft when dialog opens
  useEffect(() => {
    if (open) {
      setDraft(
        value.map((step) => ({
          ...step,
          _label:
            step._label ??
            workflowOptions.find((o) => o.value === step.workflow_ref)?.label ??
            step.workflow_ref,
          _inputs:
            step._inputs ??
            workflowOptions.find((o) => o.value === step.workflow_ref)?.inputs,
        }))
      )
    }
  }, [open, value, workflowOptions])

  const addStep = (option: WorkflowOption) => {
    const inputValues: Record<string, string> = {}
    if (option.inputs) {
      for (const [key, def] of Object.entries(option.inputs)) {
        inputValues[key] = def.default ?? ""
      }
    }
    setDraft([
      ...draft,
      {
        workflow_ref: option.value,
        input_values: inputValues,
        _label: option.label,
        _inputs: option.inputs,
      },
    ])
  }

  const removeStep = (index: number) => {
    setDraft(draft.filter((_, i) => i !== index))
    if (editingIndex === index) setEditingIndex(null)
    else if (editingIndex !== null && editingIndex > index)
      setEditingIndex(editingIndex - 1)
  }

  const moveStep = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1
    if (target < 0 || target >= draft.length) return
    const next = [...draft]
    ;[next[index], next[target]] = [next[target], next[index]]
    setDraft(next)
    if (editingIndex === index) setEditingIndex(target)
  }

  const updateStepInputs = (index: number, key: string, val: string) => {
    const next = [...draft]
    next[index] = {
      ...next[index],
      input_values: { ...next[index].input_values, [key]: val },
    }
    setDraft(next)
  }

  const handleConfirm = () => {
    onChange(draft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[720px] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>配置工作流链</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          {/* Left: Workflow Picker */}
          <div className="w-[220px] shrink-0 flex flex-col">
            <Label className="text-xs text-muted-foreground mb-1.5">
              选择工作流
            </Label>
            <div className="flex-1 overflow-hidden rounded border">
              {loading ? (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  加载中...
                </div>
              ) : (
                <Command className="h-full">
                  <CommandInput
                    placeholder="搜索..."
                    className="h-8 text-xs"
                  />
                  <CommandList className="max-h-[300px]">
                    <CommandEmpty className="text-xs py-2">
                      未找到工作流
                    </CommandEmpty>
                    <CommandGroup heading="内置工作流" className="text-xs">
                      {workflowOptions.map((option) => (
                        <CommandItem
                          key={option.value}
                          value={option.value + " " + option.label}
                          onSelect={() => addStep(option)}
                          className="text-xs"
                        >
                          <FolderOpen className="mr-1.5 h-3 w-3 text-muted-foreground" />
                          <span className="truncate">{option.label}</span>
                          <Plus className="ml-auto h-3 w-3 text-muted-foreground" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              )}
            </div>
          </div>

          {/* Right: Chain Editor */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <Label className="text-xs text-muted-foreground mb-1.5">
              执行链 ({draft.length} 步)
            </Label>
            <div className="flex-1 overflow-y-auto space-y-1">
              {draft.length === 0 ? (
                <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
                  从左侧选择工作流添加到链中
                </div>
              ) : (
                draft.map((step, i) => (
                  <div key={i}>
                    {/* Step row */}
                    <div
                      className={cn(
                        "flex items-center gap-1.5 rounded border p-2 text-xs cursor-pointer transition-colors",
                        editingIndex === i
                          ? "border-primary bg-primary/5"
                          : "hover:bg-accent/50"
                      )}
                      onClick={() =>
                        setEditingIndex(editingIndex === i ? null : i)
                      }
                    >
                      <span className="w-5 text-center font-mono text-muted-foreground">
                        {i + 1}
                      </span>
                      <span className="flex-1 truncate font-medium">
                        {step._label ?? step.workflow_ref}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingIndex(editingIndex === i ? null : i)
                        }}
                      >
                        {editingIndex === i ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <Settings className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation()
                          moveStep(i, "up")
                        }}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={i === draft.length - 1}
                        onClick={(e) => {
                          e.stopPropagation()
                          moveStep(i, "down")
                        }}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeStep(i)
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Step config panel (expanded) */}
                    {editingIndex === i && step._inputs && (
                      <div className="border border-t-0 rounded-b p-3 space-y-2.5 bg-muted/30">
                        {Object.entries(step._inputs).map(([key, def]) => (
                          <div key={key} className="space-y-1">
                            <Label className="text-xs">
                              {key}
                              {def.required && (
                                <span className="text-destructive ml-0.5">
                                  *
                                </span>
                              )}
                            </Label>
                            {def.description && (
                              <p className="text-xs text-muted-foreground">
                                {def.description}
                              </p>
                            )}
                            <AutoResizeTextarea
                              className="text-xs"
                              value={step.input_values[key] ?? ""}
                              onChange={(e) =>
                                updateStepInputs(i, key, e.target.value)
                              }
                              placeholder={def.default || `输入 ${key}...`}
                              maxRows={3}
                            />
                          </div>
                        ))}
                        {Object.keys(step._inputs).length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            此工作流无输入参数
                          </p>
                        )}
                      </div>
                    )}

                    {/* Arrow between steps */}
                    {i < draft.length - 1 && (
                      <div className="flex justify-center py-0.5">
                        <ArrowDown className="h-3 w-3 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={draft.length === 0}>
            确认 ({draft.length} 步)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Chain Summary (displayed on main form) ─────────────────────────

interface ChainSummaryProps {
  chain: ChainStep[]
  onOpen: () => void
}

export function ChainSummary({ chain, onOpen }: ChainSummaryProps) {
  return (
    <div className="rounded-lg border p-3 space-y-2">
      {chain.length === 0 ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">未配置工作流链</span>
          <Button variant="outline" size="sm" onClick={onOpen}>
            配置 →
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {chain.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                {i > 0 && (
                  <ArrowDown className="h-3 w-3 text-muted-foreground rotate-[-90deg]" />
                )}
                <Badge variant="secondary" className="text-xs">
                  {i + 1}. {step._label ?? step.workflow_ref}
                </Badge>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              共 {chain.length} 步
            </span>
            <Button variant="outline" size="sm" onClick={onOpen}>
              配置 →
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
