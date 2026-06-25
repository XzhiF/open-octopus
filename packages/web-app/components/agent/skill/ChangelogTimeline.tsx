'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RotateCcw, GitCompare, ArrowUpRight } from 'lucide-react'
import type { EvolutionLogEntry } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../shared/ConfirmDialog'

interface ChangelogTimelineProps {
  entries: EvolutionLogEntry[]
  loading: boolean
  onRollback: (id: number) => Promise<boolean>
  onReclassify?: (id: number) => Promise<boolean>
}

const changeTypeStyles: Record<string, string> = {
  minor: 'bg-agent-info-light text-agent-info border-agent-info/20',
  major: 'bg-agent-accent-light text-agent-accent border-agent-accent/20',
  rollback: 'bg-agent-warn-light text-agent-warn-foreground border-agent-warn/20',
  revert_builtin: 'bg-agent-error-light text-agent-error border-agent-error/20',
}

const changeTypeLabels: Record<string, string> = {
  minor: '小幅',
  major: '重大',
  rollback: '回滚',
  revert_builtin: '回退内置',
}

export function ChangelogTimeline({ entries, loading, onRollback, onReclassify }: ChangelogTimelineProps) {
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null)
  const [reclassifyTarget, setReclassifyTarget] = useState<number | null>(null)
  const [rolling, setRolling] = useState(false)

  const handleRollback = async () => {
    if (rollbackTarget === null) return
    setRolling(true)
    await onRollback(rollbackTarget)
    setRolling(false)
    setRollbackTarget(null)
  }

  const handleReclassify = async () => {
    if (reclassifyTarget === null || !onReclassify) return
    setRolling(true)
    await onReclassify(reclassifyTarget)
    setRolling(false)
    setReclassifyTarget(null)
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        暂无进化日志
      </div>
    )
  }

  return (
    <>
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[18px] top-2 bottom-2 w-px bg-agent-divider" />

            <div className="space-y-4">
              {entries.map((entry) => (
                <div key={entry.id} className="relative flex gap-4">
                  {/* Timeline dot */}
                  <div className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-agent-surface-raised border-2 border-agent-divider">
                    <GitCompare className="h-4 w-4 text-agent-primary" />
                  </div>

                  {/* Content */}
                  <div className={cn(
                    'flex-1 rounded-lg border bg-agent-surface-raised p-4',
                    entry.rolled_back ? 'border-agent-warn/30 opacity-60' : 'border-agent-divider'
                  )}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={cn('text-xs', changeTypeStyles[entry.change_type] ?? '')}>
                        {changeTypeLabels[entry.change_type] ?? entry.change_type}
                      </Badge>
                      <span className="text-xs font-mono text-muted-foreground">{entry.skill_name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {new Date(entry.timestamp).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    <p className="text-sm mt-2">{entry.summary}</p>
                    <div className="flex items-center gap-2 mt-3">
                      {entry.diff_path && (
                        <Button variant="ghost" size="sm" className="text-xs gap-1">
                          <GitCompare className="h-3.5 w-3.5" />
                          查看 Diff
                        </Button>
                      )}
                      {!entry.rolled_back && !entry.diff_path?.includes('revert') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs gap-1 text-agent-warn"
                          onClick={() => setRollbackTarget(entry.id)}
                          disabled={!entry.diff_path}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          回滚
                        </Button>
                      )}
                      {entry.change_type === 'minor' && !entry.rolled_back && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs gap-1 text-agent-accent"
                          onClick={() => setReclassifyTarget(entry.id)}
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" />
                          误判，应重大
                        </Button>
                      )}
                      {entry.rolled_back && (
                        <Badge variant="outline" className="text-xs text-agent-warn">已回滚</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => { if (!open) setRollbackTarget(null) }}
        title="回滚进化变更"
        description="将恢复到变更前的 SKILL 版本。确认回滚？"
        confirmLabel="确认回滚"
        variant="destructive"
        loading={rolling}
        onConfirm={handleRollback}
      />

      <ConfirmDialog
        open={reclassifyTarget !== null}
        onOpenChange={(open) => { if (!open) setReclassifyTarget(null) }}
        title="重分类为重大变更"
        description="将回滚当前变更并以重大级别重新记录。确认操作？"
        confirmLabel="确认重分类"
        variant="default"
        loading={rolling}
        onConfirm={handleReclassify}
      />
    </>
  )
}
