'use client'

// classic-v3 工程窗：仓库行（主线 / 最近提交 / 工作树数 / 拉取）可展开为工作树
// （分支 / 任务 / 状态 / 跑 / cwd）。合并原「仓库」与「工作树」两扇窗，去掉 ASCII 分支图。
// 数据 = GET /:id/repos（config.json.repos[] + git 富化）+ GET /:id/worktrees + 舱内任务。

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Folder, GitBranch, Play, Plus, RefreshCw, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import {
  listCabinRepos, listCabinWorktrees, pullCabinRepo,
  type CabinRepoEntry, type CabinWorktreeGroup,
} from '@/lib/cabin-api'
import { triggerTask } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'
import { useCabinContext } from '../cabin-provider'
import { CabinCloneDialog } from './CabinCloneDialog'
import {
  Empty, SBadge, TaskStatusBadge, WBtn, WbH, WbNote,
  openTaskInChat, taskDisplayStatus, useCabinTasks,
} from './ui'

export function CabinEngineering() {
  const { cabinId } = useCabinContext()
  const [repos, setRepos] = useState<CabinRepoEntry[]>([])
  const [groups, setGroups] = useState<CabinWorktreeGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [cloneOpen, setCloneOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const { tasks } = useCabinTasks(cabinId)

  const refresh = useCallback(async () => {
    try {
      const [repoList, groupList] = await Promise.all([
        listCabinRepos(cabinId),
        listCabinWorktrees(cabinId),
      ])
      setRepos(Array.isArray(repoList) ? repoList : [])
      setGroups(Array.isArray(groupList) ? groupList : [])
    } catch {
      setRepos([])
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [cabinId])

  useEffect(() => { void refresh() }, [refresh])

  const worktreesOf = (name: string) => groups.find((g) => g.repo === name)?.worktrees ?? []
  const totalTrees = groups.reduce((n, g) => n + g.worktrees.length, 0)

  const taskForBranch = (branch: string | null) =>
    tasks.find((t) => t.workflow_ref === branch) ??
    tasks.find((t) => branch?.includes(t.id.slice(0, 8)))

  const doPull = async (name: string) => {
    setBusy(name)
    try {
      const res = await pullCabinRepo(cabinId, name)
      toast.success(`已拉取 ${name} 主线 · ${res.branch} @ ${res.commit.slice(0, 8)}`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取失败')
    } finally {
      setBusy(null)
    }
  }

  const runWt = async (branch: string | null) => {
    const task = taskForBranch(branch)
    if (!task) {
      toast('该工作树没有映射任务 · 在主对话吩咐调度者派发')
      return
    }
    if (taskDisplayStatus(task) === 'ready') {
      try {
        await triggerTask(task.id)
        toast.success(`已触发 ${task.name}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '触发失败')
      }
    } else {
      openTaskInChat(task.id)
    }
  }

  return (
    <div data-testid="cabin-engineering-body">
      <WbH icon={GitBranch} title="工程" cap={`${repos.length} 仓库 · ${totalTrees} 工作树`}>
        <WBtn pri testId="cabin-eng-clone" onClick={() => setCloneOpen((v) => !v)}>
          <Plus className="size-3" />clone 新仓
        </WBtn>
      </WbH>
      <WbNote className="mb-3">点仓库展开工作树 · 并行任务从主线切出</WbNote>

      {cloneOpen && <CabinCloneDialog onCloned={() => { setCloneOpen(false); void refresh() }} />}

      {loading ? (
        <Empty>读取工程…</Empty>
      ) : repos.length === 0 ? (
        <Empty>暂无仓库 · 点「clone 新仓」或在主对话吩咐调度者</Empty>
      ) : repos.map((repo) => {
        const trees = worktreesOf(repo.name)
        const expanded = !!open[repo.name]
        return (
          <div
            key={repo.name}
            data-repo-card={repo.name}
            className="mb-2.5 overflow-hidden rounded-xl border-[1.5px] border-pop-bd bg-pop-idle"
          >
            <div
              role="button"
              tabIndex={0}
              data-testid={`cabin-eng-repo-${repo.name}`}
              aria-expanded={expanded}
              onClick={() => setOpen((prev) => ({ ...prev, [repo.name]: !prev[repo.name] }))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((prev) => ({ ...prev, [repo.name]: !prev[repo.name] })) } }}
              className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-pop-paper"
            >
              <ChevronRight className={cn('size-3 shrink-0 text-pop-dim transition-transform', expanded && 'rotate-90')} />
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-pop-navy/15 text-pop-navy">
                <Folder className="size-[14px]" />
              </span>
              <span className="min-w-0 flex-1">
                <b className="block text-[12.5px] text-pop-ink">{repo.name}</b>
                <span className="mt-0.5 flex flex-wrap gap-2.5 font-mono text-[10px] text-pop-dim">
                  <span className="text-pop-pink">⎇ {repo.git?.branch ?? repo.branch ?? '—'}</span>
                  {repo.git && <span>{repo.git.commit}{repo.git.msg ? ` · ${repo.git.msg}` : ''}</span>}
                  {repo.git?.at && <span>{repo.git.at}</span>}
                </span>
              </span>
              <SBadge color="dim">{trees.length} 工作树</SBadge>
              <span onClick={(e) => e.stopPropagation()}>
                <WBtn
                  onClick={() => { void doPull(repo.name) }}
                  disabled={busy === repo.name}
                  testId={`cabin-eng-pull-${repo.name}`}
                >
                  <RefreshCw className={cn('size-3', busy === repo.name && 'animate-spin')} />拉取
                </WBtn>
              </span>
            </div>
            {expanded && (
              <div className="border-t-[1.5px] border-dashed border-pop-bd bg-pop-bg/40 px-3 pb-2 pt-1.5" data-testid={`cabin-eng-worktrees-${repo.name}`}>
                {trees.length === 0 ? (
                  <WbNote className="py-1.5">暂无工作树</WbNote>
                ) : trees.map((wt) => {
                  const task = taskForBranch(wt.branch)
                  const status = task ? taskDisplayStatus(task) : null
                  const label = wt.branch ?? wt.head.slice(0, 8)
                  return (
                    <div
                      key={wt.path}
                      data-worktree-row={wt.path}
                      className="mt-1.5 flex items-center gap-2.5 rounded-[9px] border border-pop-bd bg-pop-paper px-2.5 py-1.5"
                    >
                      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-pop-cyan">
                        <GitBranch className="size-3" />{label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-pop-dim">
                        {task ? `${task.name} · ` : ''}{wt.path}
                      </span>
                      {status && <TaskStatusBadge status={status} />}
                      <span className="flex shrink-0 gap-1.5">
                        {status === 'running' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-pop-purple px-2 py-px text-[10px] font-semibold text-pop-bg">⚡ 运行中</span>
                        ) : (
                          <WBtn onClick={() => { void runWt(wt.branch) }} title="跑工作流" testId={`cabin-eng-wt-run-${label}`}>
                            <Play className="size-3" />跑
                          </WBtn>
                        )}
                        <WBtn
                          title="cwd"
                          testId={`cabin-eng-wt-cwd-${label}`}
                          onClick={() => {
                            void navigator.clipboard?.writeText(wt.path).then(
                              () => toast.success('cwd 已复制到剪贴板'),
                              () => toast(wt.path),
                            )
                          }}
                        >
                          <Terminal className="size-3" />cwd
                        </WBtn>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
