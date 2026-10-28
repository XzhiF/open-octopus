'use client'

import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { ProjectSelector, type SelectedProject } from '@/components/scheduler/project-selector'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { getTask, updateTask, type TaskView } from '@/lib/tasks-api'
import { useDockLabelsVisible } from '@/hooks/use-dock-labels'
import { cn } from '@/lib/utils'

interface TaskProjectChipProps {
  org: string
  projectIds: string[]
  /** Draft task id; absent before the first message creates the task. */
  taskId?: string
  disabled?: boolean
  /** hero 形态（新建开发任务空态第二行，2026-10-28 向新建对话看齐）：
   *  与 CwdPicker hero 同尺寸的虚线/实线大 chip。 */
  hero?: boolean
  /** 作业坞形态（2026-10-28：项目是任务维度资产，落盘后入口挪到 dock）：
   *  竖排图标钮，与 dock 其他入口同尺寸，带项目数角标。 */
  dock?: boolean
  /** Registered org names. Repos are read from the selected org's manifest,
   *  so the org itself must be pickable here — otherwise a task created in
   *  the wrong org can never reach another org's repos (bug 2026-10-27). */
  orgs?: string[]
  /** Switch org while the task is still draft (before POST /api/tasks). */
  onOrgChange?: (org: string) => void
  onSaved: (projectIds: string[], task?: TaskView) => void
}

/** Project binding lives in the conversation, not in a creation form. */
export function TaskProjectChip({
  org,
  projectIds,
  taskId,
  disabled,
  hero,
  dock,
  orgs,
  onOrgChange,
  onSaved,
}: TaskProjectChipProps) {
  const [open, setOpen] = useState(false)
  const showLabels = useDockLabelsVisible()
  const [projects, setProjects] = useState<SelectedProject[]>(
    () => projectIds.map((name) => ({ name, source_path: '', group: '' })),
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setProjects(projectIds.map((name) => ({ name, source_path: '', group: '' })))
    }
  }, [projectIds, open])

  // Org is fixed once the task row exists (task.org drives workspace paths);
  // only a still-draft task can switch where its repos come from.
  const orgSwitchable = !taskId && !!onOrgChange && (orgs?.length ?? 0) > 1

  const handleOrgChange = (next: string) => {
    if (next === org) return
    // Selections are `${group}/${name}` ids from the previous org's manifest.
    setProjects([])
    onOrgChange?.(next)
  }

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
      {dock ? (
        <button
          type="button"
          data-testid="task-project-chip"
          data-dock-project
          disabled={disabled}
          onClick={() => setOpen(true)}
          title={projectIds.length > 0 ? projectIds.join(' / ') : '为任务绑定项目'}
          aria-label="项目"
          className={cn(
            'relative flex shrink-0 flex-col items-center justify-center rounded-[11px] transition-all duration-150',
            showLabels ? 'w-11 gap-[3px] px-0.5 py-1' : 'size-9 hover:scale-105',
            projectIds.length > 0
              ? 'bg-white/[0.07] text-pop-ink hover:bg-white/[0.12]'
              : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
            disabled && 'cursor-default opacity-60',
          )}
        >
          <FolderGit2 className={showLabels ? 'size-[17px]' : 'size-[18px]'} strokeWidth={1.8} />
          {showLabels && (
            <span className="max-w-full truncate text-[9px] font-medium leading-none tracking-tight">项目</span>
          )}
          {projectIds.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-pop-cyan px-0.5 font-mono text-[8px] font-bold text-pop-bg">
              {projectIds.length}
            </span>
          )}
        </button>
      ) : (
      <button
        type="button"
        data-testid="task-project-chip"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={projectIds.length > 0 ? projectIds.join(' / ') : '为任务绑定项目'}
        className={cn(
          'flex shrink-0 items-center gap-1 border transition-colors',
          hero
            ? cn(
                'h-[27px] rounded-[8px] px-2.5 text-[11.5px]',
                projectIds.length > 0
                  ? 'border-solid border-pop-bd bg-white/[0.03] text-pop-ink'
                  : 'border-dashed border-pop-bd text-pop-dim',
                !disabled && 'hover:border-pop-dim hover:text-pop-ink',
              )
            : cn(
                'h-[22px] rounded-[7px] border-transparent px-1.5 text-[10.5px]',
                projectIds.length > 0 ? 'text-pop-ink/85' : 'text-pop-dim',
                !disabled && 'hover:bg-white/[0.06] hover:text-pop-ink',
              ),
          disabled && 'cursor-default opacity-60',
        )}
      >
        <FolderGit2 className="size-3" strokeWidth={1.7} />
        {label}
      </button>
      )}

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
          {orgSwitchable && (
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
              <span className="shrink-0 text-[10.5px] text-pop-dim">组织</span>
              <select
                data-testid="task-project-org"
                aria-label="组织"
                value={org}
                onChange={(e) => handleOrgChange(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-[7px] border border-white/[0.10] bg-pop-paper px-2 text-[12px] text-pop-ink outline-none focus:border-pop-yellow"
              >
                {orgs!.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <span className="shrink-0 text-[10px] text-pop-dim">决定可选的仓库</span>
            </div>
          )}
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
