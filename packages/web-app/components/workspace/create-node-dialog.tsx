"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Check, ChevronsUpDown, Package, FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { fetchWorkflows } from "@/lib/api-client"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import type { CreateNodeFormData, WorkflowOption, WorkflowInputDef } from "@/lib/types"
import { usePersistedState } from "@/hooks/use-persisted-state"

interface CreateNodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "next" | "fork"
  parentId: string
  workspaceId: string
  workflowOptions: WorkflowOption[]
  onConfirm: (parentId: string, formData: CreateNodeFormData) => void
}

const defaultFormData = (): CreateNodeFormData => ({
  workflowRef: "",
  name: "",
  rollbackOnError: false,
  inputValues: {},
})

export function CreateNodeDialog({
  open,
  onOpenChange,
  mode,
  parentId,
  workspaceId,
  workflowOptions,
  onConfirm,
}: CreateNodeDialogProps) {
  const [formData, setFormData, clearFormData] = usePersistedState<CreateNodeFormData>(
    `octopus:ws:${workspaceId}:create-node:${mode}:${parentId}`,
    defaultFormData()
  )
  const [comboboxOpen, setComboboxOpen] = useState(false)
  const [freshOptions, setFreshOptions] = useState<WorkflowOption[] | null>(null)

  // Re-fetch workflows when dialog opens to pick up newly created ones
  useEffect(() => {
    if (!open) { setFreshOptions(null); return }
    fetchWorkflows(workspaceId).then((data) => {
      const arr = Array.isArray(data) ? data : data.workflows ?? []
      setFreshOptions(arr.map((w: Record<string, unknown>) => ({
        value: (w.ref as string) || (w.name as string),
        label: (w.ref as string) || (w.name as string),
        name: (w.name as string),
        group: (w.group as string) || "project",
        path: (w.group as string) === "project" ? `workflows/${(w.ref as string) || (w.name as string)}` : undefined,
        inputs: w.inputs as Record<string, { description: string; required: boolean; default: string }> | undefined,
      })))
    }).catch(() => {})
  }, [open, workspaceId])

  const effectiveOptions = freshOptions ?? workflowOptions

  // Group workflow options by their group field
  const GROUP_LABELS: Record<string, string> = { project: "项目工作流", "built-in": "系统内置" }
  const groupedOptions = effectiveOptions.reduce<Record<string, WorkflowOption[]>>((acc, w) => {
    (acc[w.group] ??= []).push(w)
    return acc
  }, {})

  const selectedOption = effectiveOptions.find((o) => o.value === formData.workflowRef)
  const workflowInputs = selectedOption?.inputs
  const inputKeys = workflowInputs ? Object.keys(workflowInputs) : []

  // Validate: workflow + name required, plus all required inputs must be non-empty
  const requiredInputsFilled = !workflowInputs || Object.entries(workflowInputs).every(
    ([key, def]) => !def.required || (formData.inputValues[key] && formData.inputValues[key].trim() !== "")
  )
  const isFormValid = formData.workflowRef !== "" && formData.name !== "" && requiredInputsFilled

  const handleWorkflowSelect = (option: WorkflowOption) => {
    // Initialize input values from workflow definition defaults
    const inputValues: Record<string, string> = {}
    if (option.inputs) {
      for (const [key, def] of Object.entries(option.inputs)) {
        inputValues[key] = def.default ?? ""
      }
    }
    setFormData((prev) => ({
      ...prev,
      workflowRef: option.value,
      name: prev.name || option.name,
      inputValues,
    }))
    setComboboxOpen(false)
  }

  const handleConfirm = () => {
    if (!isFormValid) return
    onConfirm(parentId, formData)
    clearFormData() // Clear persisted state after successful submission
    onOpenChange(false)
  }

  const handleCancel = () => {
    // Don't clear formData - preserve draft for next time
    onOpenChange(false)
  }

  const resetForm = () => {
    clearFormData()
  }

  const title = mode === "next" ? "添加后续节点" : "添加分支节点"
  const description =
    mode === "next"
      ? "创建一个顺序执行的后续工作流节点"
      : "创建一个并行分支的工作流节点"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={handleCancel}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
          <div className="grid gap-2">
            <Label htmlFor="workflow-combobox">工作流</Label>
            <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={comboboxOpen}
                  className="w-full justify-between"
                >
                  {selectedOption
                    ? selectedOption.label
                    : "选择工作流..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0" align="start">
                <Command>
                  <CommandInput placeholder="搜索工作流..." />
                  <CommandList>
                    <CommandEmpty>未找到工作流</CommandEmpty>
                    {Object.entries(groupedOptions).map(([group, items]) => (
                      <CommandGroup key={group} heading={GROUP_LABELS[group] ?? group}>
                        {items.map((option) => (
                          <CommandItem
                            key={option.value}
                            value={option.value + " " + option.label}
                            onSelect={() => handleWorkflowSelect(option)}
                          >
                            {group === "built-in"
                              ? <Package className="mr-2 h-4 w-4 shrink-0" />
                              : <FolderOpen className="mr-2 h-4 w-4 shrink-0" />}
                            {option.label}
                            {option.description && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                — {option.description}
                              </span>
                            )}
                            <Check
                              className={cn(
                                "ml-auto h-4 w-4",
                                formData.workflowRef === option.value
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="node-name">节点名称</Label>
            <Input
              id="node-name"
              value={formData.name}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="输入节点名称"
            />
          </div>
          {inputKeys.length > 0 && (
            <div className="grid gap-3 rounded-lg border p-3">
              <Label className="text-sm font-medium">预输入参数</Label>
              <p className="text-xs text-muted-foreground">
                自动执行时使用的输入参数，留空则使用工作流默认值
              </p>
              {inputKeys.map((key) => {
                const def = workflowInputs![key]
                return (
                  <div key={key} className="grid gap-1.5">
                    <Label htmlFor={`input-${key}`} className="text-xs">
                      {key}
                      {def.required && <span className="text-destructive ml-0.5">*</span>}
                    </Label>
                    {def.description && (
                      <p className="text-xs text-muted-foreground">{def.description}</p>
                    )}
                    <AutoResizeTextarea
                      id={`input-${key}`}
                      value={formData.inputValues[key] ?? ""}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          inputValues: { ...prev.inputValues, [key]: e.target.value },
                        }))
                      }
                      placeholder={def.default || `输入 ${key}...`}
                      maxRows={4}
                    />
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="rollback-switch">回滚</Label>
              <p className="text-xs text-muted-foreground">
                开启后，节点出错或取消时执行 git reset --hard + git clean -fd 回滚
              </p>
            </div>
            <Switch
              id="rollback-switch"
              checked={formData.rollbackOnError}
              onCheckedChange={(checked) =>
                setFormData((prev) => ({ ...prev, rollbackOnError: checked }))
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!isFormValid}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}