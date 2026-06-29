"use client"

import { useState, useMemo } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { WorkspaceCard } from "./workspace-card"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"
import { ImportWorkspaceDialog } from "./import-workspace-dialog"
import { ArchiveStatusBadge } from "@/components/archive/archive-status-badge"
import { deleteWorkspace } from "@/lib/api-client"
import { toast } from "sonner"
import type { Workspace, WorkspaceStatus } from "@/lib/types"
import { Search, Plus, FolderInput, LayoutGrid, List, Trash2, Loader2 } from "lucide-react"
import Link from "next/link"

interface WorkspaceListProps {
  workspaces: Workspace[]
  onRefresh?: () => void
}

export function WorkspaceList({ workspaces, onRefresh }: WorkspaceListProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<WorkspaceStatus | "all">("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("list")
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      toast.info("正在归档执行数据...")
      await deleteWorkspace(deleteTarget.id)
      toast.success(`"${deleteTarget.name}" 已归档并删除`)
      setDeleteTarget(null)
      onRefresh?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  const filteredWorkspaces = useMemo(() => {
    return workspaces.filter((ws) => {
      const matchesSearch =
        ws.name.toLowerCase().includes(search.toLowerCase()) ||
        ws.description.toLowerCase().includes(search.toLowerCase())
      const matchesStatus = statusFilter === "all" || ws.status === statusFilter
      return matchesSearch && matchesStatus
    })
  }, [workspaces, search, statusFilter])

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索工作空间..."
              aria-label="搜索工作空间"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as WorkspaceStatus | "all")}
          >
            <SelectTrigger className="w-[120px]" aria-label="按状态筛选">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">活跃</SelectItem>
              <SelectItem value="inactive">未激活</SelectItem>
              <SelectItem value="error">异常</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-input" role="group" aria-label="视图模式">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-r-none"
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
              <span className="sr-only">网格视图</span>
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-l-none border-l"
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
              <span className="sr-only">列表视图</span>
            </Button>
          </div>
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <FolderInput className="mr-2 h-4 w-4" />
            导入
          </Button>
          <Button onClick={() => setIsCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            新建工作空间
          </Button>
        </div>
      </div>

      {/* Results Info */}
      <div className="text-sm text-muted-foreground">
        共 {filteredWorkspaces.length} 个工作空间
        {search && ` · 搜索 "${search}"`}
      </div>

      {/* Results */}
      {filteredWorkspaces.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Search className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-lg font-medium">未找到工作空间</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {search ? "尝试调整搜索条件" : "创建您的第一个工作空间"}
          </p>
          {!search && (
            <Button className="mt-4" onClick={() => setIsCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              新建工作空间
            </Button>
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredWorkspaces.map((workspace) => (
            <WorkspaceCard key={workspace.id} workspace={workspace} onDelete={(id) => setDeleteTarget(workspaces.find(w => w.id === id) ?? null)} />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>归档状态</TableHead>
              <TableHead>组织</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredWorkspaces.map((workspace) => {
              const isArchiving = workspace.archive_status === "archiving"
              return (
                <TableRow key={workspace.id}>
                  <TableCell>
                    <Link
                      href={`/workspaces/${workspace.id}`}
                      className="font-medium hover:underline"
                    >
                      {workspace.name}
                    </Link>
                    {workspace.description && (
                      <p className="text-xs text-muted-foreground line-clamp-1">{workspace.description}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs">{workspace.status === "active" ? "活跃" : workspace.status === "inactive" ? "未激活" : "异常"}</span>
                  </TableCell>
                  <TableCell>
                    <ArchiveStatusBadge
                      status={workspace.archive_status}
                      error={workspace.archive_error}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{workspace.org}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => !isArchiving && setDeleteTarget(workspace)}
                      disabled={isArchiving}
                    >
                      {isArchiving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {/* Create Dialog */}
      <CreateWorkspaceDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} onCreated={onRefresh} />

      {/* Import Dialog */}
      <ImportWorkspaceDialog open={isImportOpen} onOpenChange={setIsImportOpen} onImported={() => { onRefresh?.() }} />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除工作空间</AlertDialogTitle>
            <AlertDialogDescription>
              系统将自动归档所有执行数据后再删除工作空间，归档失败时不会删除。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? "删除中..." : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
