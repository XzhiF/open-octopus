'use client'

import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { ProjectSelector, type SelectedProject } from '@/components/scheduler/project-selector'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getTask, updateTask, type TaskView } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'

interface TaskProjectChipProps {
  org: string
  projectIds: string[]
  /** Draft task id; absent before the first message creates the task. */
  taskId?: string
  disabled?: boolean
  onSaved: (projectIds: string[], task?: TaskView) => void
}

/** Project binding lives in the conversation, not in a creation form. */
export function TaskProjectChip({
  org,
  projectIds,
  taskId,
  disabled,
  onSaved,
}: TaskProjectChipProps) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<SelectedProject[]>(
    () => projectIds.map((name) => ({ name, source_path: '', group: '' })),
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setProjects(projectIds.map((name) => ({ name, source_path: '', group: '' })))
    }
  }, [projectIds, open])

  const save = async () => {
    const names = projects.map((project) => project.name)
    setBusy(true)
    try {
      if (taskId) {
        // Re-read for the current version (optimistic lock), then write.
        const fresh = await getTask(taskId)
        const updated = await updateTask(taskId, { project_ids: names }, fresh.version)
        onSaved(names, updated)
      } else {
        onSaved(names)
      }
      setOpen(false)
      toast.success(names.length > 0 ? '项目已绑定' : '项目已清空')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存项目失败')
    } finally {
      setBusy(false)
    }
  }

  const label = projectIds.length > 0 ? `项目 · ${projectIds.length}` : '绑定项目'

  return (
    <>
      <button
        type="button"
        data-testid="task-project-chip"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={projectIds.length > 0 ? projectIds.join(' / ') : '为任务绑定项目'}
        className={cn(
          'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] px-1.5 text-[10.5px] transition-colors',
          projectIds.length > 0 ? 'text-pop-ink/85' : 'text-pop-dim',
          disabled ? 'cursor-default opacity-60' : 'hover:bg-white/[0.06] hover:text-pop-ink',
        )}
      >
        <FolderGit2 className="size-3" strokeWidth={1.7} />
        {label}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="ui-font max-w-[460px] gap-0 overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg p-0 sm:max-w-[460px]"
        >
          <DialogTitle className="sr-only">绑定项目</DialogTitle>
          <div className="flex h-12 items-center gap-3 border-b border-white/[0.06] px-3">
            <button
              type="button"
              aria-label="关闭项目选择"
              onClick={() => setOpen(false)}
              className="grid size-6 shrink-0 place-items-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-pop-yellow"
            >
              <CloseLightGlyph />
            </button>
            <div>
              <div className="text-[13px] font-semibold text-pop-ink">项目</div>
              <div className="text-[10.5px] text-pop-dim">任务要改哪些仓库；入队后锁定</div>
            </div>
          </div>
          <div className="max-h-[50vh] overflow-y-auto px-4 py-4">
            {projectIds.length === 0 && (
              <p className="mb-3 rounded-[8px] border border-pop-amber/25 bg-pop-amber-soft/40 px-2.5 py-2 text-[11px] leading-relaxed text-pop-amber">
                未绑定项目：任务可以继续规划，但入队执行前需要至少选择一个项目（执行环境要挂 worktree）。
              </p>
            )}
            <ProjectSelector
              org={org}
              value={projects}
              onChange={setProjects}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" variant="pop" onClick={() => void save()} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
