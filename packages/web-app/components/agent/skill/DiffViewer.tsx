'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import * as api from '@/lib/agent/api'

interface DiffViewerProps {
  skillName: string
  onClose: () => void
}

export function DiffViewer({ skillName, onClose }: DiffViewerProps) {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getSkillDiff(skillName).then((res) => {
      setDiff(res.diff)
      setLoading(false)
    }).catch(() => {
      setDiff(null)
      setLoading(false)
    })
  }, [skillName])

  return (
    <Dialog open={true} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>SKILL Diff: {skillName}</span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : diff ? (
          <div className="flex-1 overflow-auto rounded-lg bg-agent-surface-inset border border-agent-divider p-4 font-mono text-xs leading-relaxed">
            {diff.split('\n').map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith('+') ? 'text-agent-success bg-agent-success-light/30' :
                  line.startsWith('-') ? 'text-agent-error bg-agent-error-light/30' :
                  line.startsWith('@@') ? 'text-agent-info' :
                  'text-muted-foreground'
                }
              >
                <span className="inline-block w-8 text-right mr-3 text-muted-foreground/50 select-none">{i + 1}</span>
                {line}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">
            本地版本与内置版本一致，无差异
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
