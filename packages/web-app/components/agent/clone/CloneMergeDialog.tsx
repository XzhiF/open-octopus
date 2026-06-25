'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { CloneInfo } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { ConfirmDialog } from '../shared/ConfirmDialog'

interface CloneMergeDialogProps {
  clone: CloneInfo | null
  onClose: () => void
  onMerged: () => void
}

export function CloneMergeDialog({ clone, onClose, onMerged }: CloneMergeDialogProps) {
  const [loading, setLoading] = useState(false)

  const handleMerge = async () => {
    if (!clone) return
    setLoading(true)
    try {
      const res = await api.mergeClone(clone.name)
      toast.success(`已合并 "${clone.name}"，归档 ${res.archived_lessons} 条经验`)
      onMerged()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '合并失败，分身未改动')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ConfirmDialog
      open={!!clone}
      onOpenChange={(open) => { if (!open) onClose() }}
      title="合并分身"
      description={clone ? `将归档 "${clone.name}" 的经验到主 Agent 长期记忆，分身将被移除。确认？` : ''}
      confirmLabel="确认合并"
      variant="destructive"
      loading={loading}
      onConfirm={handleMerge}
    />
  )
}
