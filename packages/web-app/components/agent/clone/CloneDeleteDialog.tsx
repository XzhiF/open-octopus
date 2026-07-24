'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { CloneInfo } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'

interface CloneDeleteDialogProps {
  clone: CloneInfo | null
  onClose: () => void
  onDeleted: () => void
}

export function CloneDeleteDialog({ clone, onClose, onDeleted }: CloneDeleteDialogProps) {
  const [loading, setLoading] = useState(false)

  // Guard: built-in clones cannot be deleted
  if (clone?.type === 'built-in') {
    return null
  }

  const handleDelete = async () => {
    if (!clone) return
    setLoading(true)
    try {
      await api.deleteClone(clone.name)
      toast.success(`已删除分身 "${clone.display_name}"`)
      onDeleted()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AlertDialog open={!!clone} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除分身 {clone?.display_name}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-3">
                确认删除分身 <strong>{clone?.display_name}</strong> ({clone?.name})？
                分身的文件和记忆将被永久删除。
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? '删除中...' : '确认删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
