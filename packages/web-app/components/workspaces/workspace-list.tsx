"use client"

import { useState } from "react"
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
import { CreateWorkspaceDialog } from "./create-workspace-dialog"
import { ArchivePreviewDialog } from "./archive-preview-dialog"
import { ArchiveViewDialog } from "./archive-view-dialog"
import { WorkspaceBands } from "./workspace-bands"
import { deleteWorkspace } from "@/lib/api-client"
import { toast } from "sonner"
import type { Workspace } from "@/lib/types"

interface WorkspaceListProps {
  workspaces: Workspace[]
  onRefresh?: () => void
}

export function WorkspaceList({ workspaces, onRefresh }: WorkspaceListProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<Workspace | null>(null)
  const [viewArchiveTarget, setViewArchiveTarget] = useState<Workspace | null>(null)

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteWorkspace(deleteTarget.id)
      toast.success(`"${deleteTarget.name}" 已删除`)
      setDeleteTarget(null)
      onRefresh?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  const find = (id: string) => workspaces.find((w) => w.id === id) ?? null

  return (
    <div>
      <WorkspaceBands
        workspaces={workspaces}
        onNew={() => setIsCreateOpen(true)}
        onDelete={(id) => setDeleteTarget(find(id))}
        onArchive={(id) => setArchiveTarget(find(id))}
        onViewArchive={(id) => setViewArchiveTarget(find(id))}
      />

      {/* Create Dialog */}
      <CreateWorkspaceDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} onCreated={onRefresh} />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除工作空间</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 &ldquo;{deleteTarget?.name}&rdquo; 吗？此操作不可撤销，相关执行记录也会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} data-testid="btn-delete-cancel">取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="btn-delete-confirm">
              {deleting ? "删除中..." : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive Confirmation */}
      <ArchivePreviewDialog
        workspace={archiveTarget}
        open={!!archiveTarget}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
        onArchived={() => {
          setArchiveTarget(null)
          onRefresh?.()
        }}
      />

      {/* Archive View */}
      <ArchiveViewDialog
        workspaceId={viewArchiveTarget?.id ?? null}
        workspaceName={viewArchiveTarget?.name ?? ""}
        open={!!viewArchiveTarget}
        onOpenChange={(open) => { if (!open) setViewArchiveTarget(null) }}
      />
    </div>
  )
}
