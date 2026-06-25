'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RotateCcw, GitCompare } from 'lucide-react'
import type { SkillInfo } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { DiffViewer } from './DiffViewer'

interface SkillListProps {
  skills: SkillInfo[]
  loading: boolean
  onRevertBuiltin: (name: string) => Promise<boolean>
}

const sourceLabels: Record<string, { label: string; className: string }> = {
  local_evolved: { label: '进化版', className: 'bg-agent-accent-light text-agent-accent border-agent-accent/20' },
  builtin: { label: '内置版', className: 'bg-muted text-muted-foreground' },
  prod: { label: '生产版', className: 'bg-agent-success-light text-agent-success-foreground border-agent-success/20' },
}

export function SkillList({ skills, loading, onRevertBuiltin }: SkillListProps) {
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const [diffTarget, setDiffTarget] = useState<string | null>(null)

  const handleRevert = async () => {
    if (!revertTarget) return
    setReverting(true)
    await onRevertBuiltin(revertTarget)
    setReverting(false)
    setRevertTarget(null)
  }

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  return (
    <>
      <ScrollArea className="h-full">
        <div className="p-4 space-y-2">
          {skills.map((skill) => {
            const sourceInfo = sourceLabels[skill.source] ?? sourceLabels.builtin
            return (
              <div
                key={skill.name}
                className="flex items-center gap-3 rounded-lg border border-agent-divider bg-agent-surface-raised p-4 hover:shadow-sm transition-shadow"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium font-mono">{skill.name}</h4>
                    <Badge variant="outline" className={cn('text-xs', sourceInfo.className)}>
                      {sourceInfo.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{skill.token_count} tokens</span>
                    {skill.last_modified && (
                      <span>修改: {new Date(skill.last_modified).toLocaleDateString('zh-CN')}</span>
                    )}
                    {skill.has_local_backup && (
                      <span className="text-agent-info">有备份</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {skill.source === 'local_evolved' && (
                    <>
                      <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setDiffTarget(skill.name)}>
                        <GitCompare className="h-3.5 w-3.5" />
                        对比内置
                      </Button>
                      <Button variant="ghost" size="sm" className="gap-1 text-xs text-agent-warn" onClick={() => setRevertTarget(skill.name)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        回退内置
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={!!revertTarget}
        onOpenChange={(open) => { if (!open) setRevertTarget(null) }}
        title="回退到内置版本"
        description={`将删除本地进化版本 "${revertTarget}"，回退到内置基线。确认？`}
        confirmLabel="确认回退"
        variant="destructive"
        loading={reverting}
        onConfirm={handleRevert}
      />

      {diffTarget && (
        <DiffViewer
          skillName={diffTarget}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </>
  )
}
