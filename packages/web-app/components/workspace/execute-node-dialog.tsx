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
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { fetchWorkflows } from "@/lib/api-client"
import { usePersistedState } from "@/hooks/use-persisted-state"
import type { ExecuteNodeFormData, WorkflowInputDef, WorkflowOption } from "@/lib/types"

interface ExecuteNodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "execute" | "retry"
  nodeId: string
  workspaceId: string
  workflowName: string
  workflowRef: string
  workflowOptions: WorkflowOption[]
  initialInputValues: Record<string, string>
  initialRollbackOnError: boolean
  onConfirm: (nodeId: string, formData: ExecuteNodeFormData) => void
}

export function ExecuteNodeDialog({
  open,
  onOpenChange,
  mode,
  nodeId,
  workspaceId,
  workflowName,
  workflowRef,
  workflowOptions,
  initialInputValues,
  initialRollbackOnError,
  onConfirm,
}: ExecuteNodeDialogProps) {
  // Persist form state so it survives tab switches and screen navigation
  const inputKey = `octopus:ws:${workspaceId}:execute:${nodeId}:${mode}:inputs`
  const rollbackKey = `octopus:ws:${workspaceId}:execute:${nodeId}:${mode}:rollback`
  const syncMainBranchKey = `octopus:ws:${workspaceId}:execute:${nodeId}:${mode}:syncMainBranch`

  const [inputValues, setInputValues, clearInputs] = usePersistedState<Record<string, string>>(
    inputKey,
    initialInputValues,
  )
  const [rollbackOnError, setRollbackOnError, clearRollback] = usePersistedState<boolean>(
    rollbackKey,
    initialRollbackOnError,
  )
  const [syncMainBranch, setSyncMainBranch, clearSyncMainBranch] = usePersistedState<boolean>(
    syncMainBranchKey,
    true, // default checked
  )
  const [localWorkflowInputs, setLocalWorkflowInputs] = useState<Record<string, WorkflowInputDef> | undefined>(undefined)

  // Independently fetch workflows to get latest inputs (like CreateNodeDialog does)
  // This ensures inputs are available even if workflow was created after page load
  useEffect(() => {
    if (!open) return
    fetchWorkflows(workspaceId).then((data) => {
      const arr = Array.isArray(data) ? data : data.workflows ?? []
      const match = arr.find((w: Record<string, unknown>) =>
        (w.ref as string) === workflowRef || (w.name as string) === workflowRef
      )
      const fetchedInputs = match?.inputs as Record<string, WorkflowInputDef> | undefined
      if (fetchedInputs) {
        setLocalWorkflowInputs(fetchedInputs)
        // Initialize defaults for any input keys not already set
        const defaults: Record<string, string> = {}
        for (const [key, def] of Object.entries(fetchedInputs)) {
          if (!inputValues[key] && def.default) {
            defaults[key] = def.default
          }
        }
        if (Object.keys(defaults).length > 0) {
          setInputValues((prev) => ({ ...defaults, ...prev }))
        }
      } else {
        setLocalWorkflowInputs(undefined)
      }
    }).catch(() => {})
  }, [open, workspaceId, workflowRef])

  // Resolve inputs: prefer freshly fetched, fall back to workflowOptions
  const inputs = localWorkflowInputs ?? workflowOptions.find((o) => o.value === workflowRef)?.inputs

  const requiredKeys = inputs
    ? Object.entries(inputs)
        .filter(([, def]) => def.required)
        .map(([key]) => key)
    : []

  const isFormValid = requiredKeys.every((key) => (inputValues[key] ?? "").trim() !== "")

  const handleInputChange = (key: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleConfirm = () => {
    if (!isFormValid) return
    onConfirm(nodeId, { inputValues, rollbackOnError, syncMainBranch })
    // Clear persisted draft after successful submission
    clearInputs()
    clearRollback()
    clearSyncMainBranch()
  }

  const handleCancel = () => {
    // Don't reset — preserve the draft so user can return to it
    onOpenChange(false)
  }

  const title = mode === "execute" ? "执行工作流" : "重试工作流"
  const description = mode === "execute" ? "启动此节点的工作流执行" : "重新执行此节点的工作流"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col max-h-[90vh] overflow-hidden"
        onPointerDownOutside={handleCancel}
        onEscapeKeyDown={handleCancel}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto grid gap-4 py-4">
          <div className="flex items-center gap-2">
            <Label>工作流</Label>
            <Badge variant="secondary">{workflowName}</Badge>
          </div>
          {inputs && Object.keys(inputs).length > 0 && (
            <div className="grid gap-3">
              {Object.entries(inputs).map(([key, def]: [string, WorkflowInputDef]) => {
                  const val = inputValues[key] ?? ""
                  const defaultVal = def.default ?? ""
                  return (
                    <div className="grid gap-2" key={key}>
                      <Label htmlFor={`input-${key}`}>
                        {def.description || key}
                        {def.required && <span className="ml-1 text-red-500">*</span>}
                      </Label>
                      <AutoResizeTextarea
                        id={`input-${key}`}
                        value={val}
                        onChange={(e) => handleInputChange(key, e.target.value)}
                        placeholder={defaultVal}
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
              checked={rollbackOnError}
              onCheckedChange={(checked) => setRollbackOnError(checked)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="sync-main-branch">同步主分支</Label>
              <p className="text-xs text-muted-foreground">
                执行前拉取所有项目的最新主分支代码
              </p>
            </div>
            <Switch
              id="sync-main-branch"
              checked={syncMainBranch}
              onCheckedChange={(checked) => setSyncMainBranch(checked)}
            />
          </div>
        </div>
        <DialogFooter className="shrink-0">
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