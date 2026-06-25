"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { listOrgs, fetchImportableWorkspaces, importWorkspace } from "@/lib/api-client"
import { toast } from "sonner"
import { FolderInput } from "lucide-react"

interface ImportableWorkspace {
  name: string
  path: string
  repoCount: number
  branch: string | null
}

interface ImportWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

export function ImportWorkspaceDialog({ open, onOpenChange, onImported }: ImportWorkspaceDialogProps) {
  const [org, setOrg] = useState("")
  const [orgs, setOrgs] = useState<{ id: number; name: string; path: string }[]>([])
  const [loadingOrgs, setLoadingOrgs] = useState(true)
  const [workspaces, setWorkspaces] = useState<ImportableWorkspace[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    listOrgs().then(data => {
      setOrgs(data)
      if (data.length > 0) setOrg(data[0].name)
      setLoadingOrgs(false)
    })
  }, [])

  useEffect(() => {
    if (!org) return
    setSelected([])
    setWorkspaces([])
    setWorkspaceError(null)
    setLoadingWorkspaces(true)

    fetchImportableWorkspaces(org)
      .then(data => {
        setWorkspaces(data.workspaces ?? [])
      })
      .catch(() => setWorkspaceError("加载失败"))
      .finally(() => setLoadingWorkspaces(false))
  }, [org])

  const toggleItem = useCallback((name: string) => {
    setSelected(prev =>
      prev.includes(name)
        ? prev.filter(n => n !== name)
        : [...prev, name]
    )
  }, [])

  const toggleAll = useCallback(() => {
    if (selected.length === workspaces.length) {
      setSelected([])
    } else {
      setSelected(workspaces.map(ws => ws.name))
    }
  }, [selected, workspaces])

  const handleImport = async () => {
    if (selected.length === 0) return
    setImporting(true)

    let successCount = 0
    let failCount = 0

    for (const name of selected) {
      try {
        await importWorkspace(name, org)
        successCount++
      } catch {
        failCount++
      }
    }

    setImporting(false)

    if (successCount > 0) {
      toast.success(`已导入 ${successCount} 个工作空间`)
      setSelected([])
      onImported()
      onOpenChange(false)
    }

    if (failCount > 0) {
      toast.error(`${failCount} 个工作空间导入失败`)
    }
  }

  const allSelected = workspaces.length > 0 && selected.length === workspaces.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-5 w-5" />
            导入工作空间
          </DialogTitle>
          <DialogDescription>
            发现并导入 CLI 已创建但尚未入库的工作空间。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col overflow-hidden gap-4 py-2">
          {/* Org selector */}
          <div className="grid gap-2">
            <label className="text-sm font-medium">组织</label>
            <select
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={loadingOrgs || importing}
            >
              {loadingOrgs && <option>加载中...</option>}
              {orgs.map(o => (
                <option key={o.id} value={o.name}>{o.name}</option>
              ))}
            </select>
          </div>

          {/* Loading state */}
          {loadingWorkspaces && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              加载中...
            </div>
          )}

          {/* Error state */}
          {workspaceError && !loadingWorkspaces && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-destructive">
              {workspaceError}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setWorkspaceError(null)
                  setLoadingWorkspaces(true)
                  fetchImportableWorkspaces(org)
                    .then(data => setWorkspaces(data.workspaces ?? []))
                    .catch(() => setWorkspaceError("加载失败"))
                    .finally(() => setLoadingWorkspaces(false))
                }}
                disabled={importing}
              >
                重试
              </Button>
            </div>
          )}

          {/* Empty state */}
          {!loadingWorkspaces && !workspaceError && workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
              <FolderInput className="h-8 w-8 mb-2 opacity-50" />
              没有发现未入库的工作空间
            </div>
          )}

          {/* Workspace list */}
          {!loadingWorkspaces && !workspaceError && workspaces.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  发现 {workspaces.length} 个未入库的工作空间:
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleAll}
                  disabled={importing}
                  className="text-xs"
                >
                  {allSelected ? "取消全选" : "全选"}
                </Button>
              </div>
              <ScrollArea className="h-[300px] rounded-md border">
                <div className="p-3 space-y-2">
                  {workspaces.map(ws => {
                    const isSelected = selected.includes(ws.name)
                    return (
                      <label
                        key={ws.name}
                        className="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-accent cursor-pointer"
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleItem(ws.name)}
                          disabled={importing}
                          className="mt-0.5"
                        />
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{ws.name}</span>
                            <Badge variant="secondary" className="text-xs">
                              {ws.repoCount} 个项目
                            </Badge>
                            {ws.branch && (
                              <Badge variant="outline" className="text-xs">
                                {ws.branch}
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground truncate">
                            {ws.path}
                          </span>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            取消
          </Button>
          <Button
            onClick={handleImport}
            disabled={importing || selected.length === 0}
          >
            {importing ? (
              <span className="flex items-center gap-2">
                <Spinner className="h-4 w-4" />
                导入中...
              </span>
            ) : (
              `导入选中${selected.length > 0 ? ` (${selected.length})` : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}