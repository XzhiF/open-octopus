'use client'

// S5 工作树窗（原型 wbWorktree）：per-repo 工作树行（branch/任务/路径/状态）+
// ASCII 分支图。跑工作流 = 触发映射任务（ready）；cwd = 复制路径。

import { useCallback, useEffect, useState } from 'react'
import { GitBranch, Play, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { listCabinWorktrees, type CabinWorktreeGroup } from '@/lib/cabin-api'
import { triggerTask } from '@/lib/tasks-api'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, TaskStatusBadge, WBtn, WbH, WbNote, WbSec, Empty, openTaskInChat } from './ui'

export function CabinWorktrees() {
  const { cabinId } = useCabinContext()
  const [groups, setGroups] = useState<CabinWorktreeGroup[]>([])
  const [loading, setLoading] = useState(true)
  const { tasks } = useCabinTasks(cabinId)

  const refresh = useCallback(async () => {
    try {
      setGroups(await listCabinWorktrees(cabinId))
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [cabinId])

  useEffect(() => { void refresh() }, [refresh])

  const taskForBranch = (branch: string | null) =>
    tasks.find((t) => t.workflow_ref === branch) ??
    tasks.find((t) => branch?.includes(t.id.slice(0, 8)))

  const runWt = async (branch: string | null) => {
    const t = taskForBranch(branch)
    if (!t) {
      toast('该工作树没有映射任务 · 在主对话吩咐调度者派发')
      return
    }
    const status = taskDisplayStatus(t)
    if (status === 'ready') {
      try {
        await triggerTask(t.id)
        toast.success(`已触发 ${t.name}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '触发失败')
      }
    } else {
      openTaskInChat(t.id)
    }
  }

  return (
    <div data-testid="cabin-worktree-body">
      <WbH icon={GitBranch} title="工作树" cap="并行 · 从主线切出" />
      {loading ? (
        <Empty>读取工作树…</Empty>
      ) : groups.length === 0 ? (
        <Empty>暂无仓库 · 先 clone 再切树</Empty>
      ) : groups.map((g) => (
        <div key={g.repo}>
          <WbSec cap={`主线 ${g.worktrees[0]?.branch ?? '—'}`}>{g.repo}</WbSec>
          {g.worktrees.length === 0 ? (
            <WbNote>暂无工作树</WbNote>
          ) : g.worktrees.map((w) => {
            const t = taskForBranch(w.branch)
            const status = t ? taskDisplayStatus(t) : null
            return (
              <div key={w.path} className="mt-2 flex items-center gap-3 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-paper px-3 py-2" data-worktree-row={w.path}>
                <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-pop-cyan">
                  <GitBranch className="size-3" />{w.branch ?? w.head.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-pop-dim">
                  {t ? `${t.name} · ` : ''}{w.path}
                </span>
                {status && <TaskStatusBadge status={status} />}
                <span className="flex shrink-0 gap-1.5">
                  {status === 'running' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-pop-purple px-2 py-px text-[10px] font-semibold text-pop-bg">⚡ 运行中</span>
                  ) : (
                    <WBtn onClick={() => { void runWt(w.branch) }} title="跑工作流" testId={`cabin-wt-run-${w.branch}`}>
                      <Play className="size-3" />跑工作流
                    </WBtn>
                  )}
                  <WBtn
                    title="cwd"
                    onClick={() => {
                      void navigator.clipboard?.writeText(w.path).then(
                        () => toast.success('cwd 已复制到剪贴板'),
                        () => toast(w.path),
                      )
                    }}
                  >
                    <Terminal className="size-3" />cwd
                  </WBtn>
                </span>
              </div>
            )
          })}
          <div className="mt-2 rounded-b-xl border-t-[1.5px] border-pop-bd bg-pop-bg px-3.5 py-2.5 font-mono text-[11px] leading-[1.9] text-pop-dim">
            <span className="text-pop-pink">●───●───● {g.worktrees[0]?.branch ?? 'main'}（主线）</span>
            {g.worktrees.slice(1).map((w) => (
              <div key={w.path}>
                &nbsp;&nbsp;└─<span className="text-pop-cyan">●───● {w.branch ?? w.head.slice(0, 8)}</span>{' '}
                <span className="text-pop-green">↺ {taskForBranch(w.branch) ? taskDisplayStatus(taskForBranch(w.branch)!) : 'idle'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
