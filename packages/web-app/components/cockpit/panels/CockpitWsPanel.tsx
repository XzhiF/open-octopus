'use client'

// v20（design 29 §6 ws）：作战舱文件面板 —— 舱籍项目的工作树只读查阅。
// 真数据 = GET /api/cabins/:id/repos/:name/tree|file（ff-only：只读不写）。
// 项目 chips + 筛选 + 默认全展开树 + 只读预览；被改文件徽标 = 作战名
// （changes 汇总里 commits>0 的任务 → round-diff(scope=task) 实物文件列表，
// 上限 6 个任务，拿不到就不画徽标 —— 不猜）。预览头「▦ 看作战变更」跳详情变更页签。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCabinChanges, getRepoFile, getRepoTree, type RepoTreeEntry } from '@/lib/cabin-api'
import { getRoundDiff } from '@/lib/tasks-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects } from '../projects/use-cabin-projects'
import { ancestorsOf, buildTree, TreeRows } from '../face/CockpitJobFiles'
import { CockpitPanelShell } from './CockpitPanelShell'

const BADGE_TASK_CAP = 6

export function CockpitWsPanel() {
  const { entryCabinId, select, closePanel, panelArg } = useCockpitState()
  const { projects, loading: projLoading, error: projError } = useCabinProjects(entryCabinId)
  const [proj, setProj] = useState<string | null>(panelArg)
  const active = proj ?? projects[0]?.name ?? null

  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null)
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [badges, setBadges] = useState<Map<string, string>>(new Map())
  const [badgeTask, setBadgeTask] = useState<Map<string, string>>(new Map())

  const load = useCallback(() => {
    if (!active) return
    setLoading(true)
    getRepoTree(entryCabinId, active)
      .then((res) => {
        setEntries(res.entries)
        setDir(res.dir)
        // v20：工作树默认全展开。
        setOpen(new Set(res.entries.filter((e) => e.type === 'dir').map((e) => e.path.replace(/\/$/, ''))))
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '读取工作树失败'))
      .finally(() => setLoading(false))
  }, [entryCabinId, active])

  useEffect(() => {
    setEntries(null)
    setSel(null)
    setContent(null)
    setContentErr(null)
    setQ('')
    load()
  }, [load])

  // 被改文件徽标：changes 汇总 → 有 commits 的任务 → round-diff 实物文件。
  useEffect(() => {
    let cancelled = false
    setBadges(new Map())
    setBadgeTask(new Map())
    if (!active) return
    getCabinChanges(entryCabinId)
      .then(async (summary) => {
        const tasks = summary.tasks.filter((t) => t.commits > 0).slice(0, BADGE_TASK_CAP)
        const next = new Map<string, string>()
        const owners = new Map<string, string>()
        for (const task of tasks) {
          try {
            const diff = await getRoundDiff(task.id, 'task')
            for (const repo of diff.repos ?? []) {
              for (const group of repo.groups ?? []) {
                for (const file of group.files ?? []) {
                  if (!next.has(file.path)) {
                    next.set(file.path, task.name)
                    owners.set(file.path, task.id)
                  }
                }
              }
            }
          } catch {
            // 拿不到实物 diff 的任务不画徽标（不猜）。
          }
        }
        if (!cancelled) {
          setBadges(next)
          setBadgeTask(owners)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [entryCabinId, active])

  const tree = useMemo(() => buildTree(entries ?? []), [entries])

  const keep = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query || !entries) return null
    const set = new Set<string>()
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.path.toLowerCase().includes(query)) continue
      set.add(entry.path)
      for (const ancestor of ancestorsOf(entry.path)) set.add(ancestor)
    }
    return set
  }, [q, entries])

  const selectFile = useCallback((path: string) => {
    if (!active) return
    setSel(path)
    setContent(null)
    setContentErr(null)
    getRepoFile(entryCabinId, active, path)
      .then((res) => setContent(res.content))
      .catch((err: unknown) => setContentErr(err instanceof Error ? err.message : '读取失败'))
  }, [entryCabinId, active])

  const selTask = sel ? badgeTask.get(sel) : null

  return (
    <CockpitPanelShell kind="ws" title="作战舱文件" en="WORKTREE · READ-ONLY" wide>
      <div className="ck12-ws-note">只读 · ff-only：查阅不改工作树；写操作走作战本身</div>
      <div className="ck12-ws-chips" data-testid="cockpit-ws-chips">
        {projLoading && projects.length === 0 && <span className="ck12-ledger-none">读舱籍…</span>}
        {projError && <span className="ck12-ledger-none is-err">{projError}</span>}
        {projects.map((repo) => (
          <button
            key={repo.key}
            type="button"
            className={`ck12-ws-chip${repo.name === active ? ' is-on' : ''}`}
            data-testid={`cockpit-ws-chip-${repo.name}`}
            title={repo.worktree_path ?? repo.main_path ?? undefined}
            onClick={() => setProj(repo.name)}
          >
            {repo.name}
            {repo.git?.branch && <i>{repo.git.branch}</i>}
          </button>
        ))}
        {!projLoading && projects.length === 0 && !projError && (
          <span className="ck12-ledger-none">舱籍还空着 · 先去绑项目</span>
        )}
      </div>
      <div className="ck12-files-h">
        <span className="ck12-files-dir" title={dir}>{dir || 'worktree'}</span>
        <input
          className="ck12-files-q"
          value={q}
          placeholder="筛文件（自动展开匹配链）"
          aria-label="筛选工作树文件"
          onChange={(event) => setQ(event.target.value)}
        />
        <button type="button" className="ck12-files-re" title="重扫磁盘" onClick={load}>↻</button>
      </div>
      <div className="ck12-files-b ck12-ws-b">
        <div className="ck12-files-tree" role="tree" aria-label="工作树目录树">
          {loading && <div className="ck12-files-empty">扫磁盘…</div>}
          {error && <div className="ck12-files-empty is-err">{error}</div>}
          {!loading && !error && entries && entries.length === 0 && (
            <div className="ck12-files-empty">工作树空着</div>
          )}
          {!loading && !error && keep && keep.size === 0 && (
            <div className="ck12-files-empty">没有匹配「{q}」的文件</div>
          )}
          {!loading && !error && (
            <TreeRows
              nodes={tree}
              depth={0}
              open={open}
              onToggle={(path) => setOpen((prev) => {
                const next = new Set(prev)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })}
              sel={sel}
              onSelect={selectFile}
              keep={keep}
              badges={badges}
            />
          )}
        </div>
        <div className="ck12-files-preview">
          {sel ? (
            <>
              <div className="ck12-files-ph">
                <b>{sel}</b>
                {selTask && (
                  <button
                    type="button"
                    className="ck12-ws-jump"
                    data-testid="cockpit-ws-jump-changes"
                    onClick={() => {
                      closePanel()
                      select({ kind: 'task', cabinId: entryCabinId, id: selTask }, 'changes')
                    }}
                  >
                    ▦ 看作战变更
                  </button>
                )}
                <span>只读 · repo file</span>
              </div>
              {contentErr && <div className="ck12-files-empty is-err">{contentErr}</div>}
              {!contentErr && content == null && <div className="ck12-files-empty">读文件…</div>}
              {!contentErr && content != null && <pre className="ck12-files-pre">{content}</pre>}
            </>
          ) : (
            <div className="ck12-files-empty">点一个文件看内容 · 带徽标的是被作战改过的</div>
          )}
        </div>
      </div>
    </CockpitPanelShell>
  )
}
