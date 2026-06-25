'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
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
  const [keepWorkspace, setKeepWorkspace] = useState(true)
  const [loading, setLoading] = useState(false)

  const handleDelete = async () => {
    if (!clone) return
    setLoading(true)
    try {
      await api.deleteClone(clone.name, keepWorkspace)
      toast.success(`已删除分身 "${clone.name}"`)
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
          <AlertDialogTitle>删除分身 {clone?.name}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p className="mb-3">删除分身<strong>不会归档记忆</strong>（区别于合并操作），分身的经验将丢失。确认？</p>
              <div className="space-y-2 mt-4">
                <Label>Workspace 处理:</Label>
                <RadioGroup value={keepWorkspace ? 'keep' : 'delete'} onValueChange={(v) => setKeepWorkspace(v === 'keep')}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="keep" id="keep" />
                    <Label htmlFor="keep" className="text-sm font-normal">保留 Workspace</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="delete" id="delete" />
                    <Label htmlFor="delete" className="text-sm font-normal">同时删除 Workspace</Label>
                  </div>
                </RadioGroup>
              </div>
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
