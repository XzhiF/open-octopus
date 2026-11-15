'use client'

// 项目面：点项目看到的是**仓库**，不是作业详情（design 21 §1.6 ④）。
// 左 pane = 仓库（来源 / 门槛 / 路径 / 远端 / 分支·HEAD / 工作树 / 改动占位），
// 右 pane = 这个项目上的作业。动作：回舱籍 / 只看它的作业 / 拉主线 / 开工作树 / 复制路径。
//
// 门槛（§1.6 ⑤）：ORG / 本地 / 外部主仓一律只读；唯一写向动作是「拉取主线」
// （服务端 ff-only / 镜像同步）；任何编辑都发生在工作树里。

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  createRepoWorktree, pullCabinRepo, removeCabinRepo, getCabinUsage,
  type CabinRepoEntry, type CabinUsagePayload,
} from '@/lib/cabin-api'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects, invalidateCabinProjects } from './use-cabin-projects'
import { projectStats, rowProjectKeys, rosterRef } from './project-model'
import { CockpitRepoBinder } from './CockpitRepoBinder'

export interface CockpitProjectFaceProps {
  cabinId: string
  projectKey: string
  onClose: () => void
}

export function CockpitProjectFace({ cabinId, projectKey, onClose }: CockpitProjectFaceProps) {
  const { select, setProjectFilter, projectFilter } = useCockpitState()
  const { rows, refetch: refetchFleet } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  const { projects, loading, error, refetch } = useCabinProjects(cabinId)
  const [binderOpen, setBinderOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [usage, setUsage] = useState<CabinUsagePayload | null>(null)

  // 项目消耗：byJob 已带 project_keys；拿不到就整段省略（不写 0 / --）。
  useEffect(() => {
    let alive = true
    getCabinUsage(cabinId).then(
      (payload) => { if (alive) setUsage(payload) },
      () => { if (alive) setUsage(null) },
    )
    return () => { alive = false }
  }, [cabinId])

  const project = projects.find((p) => p.key === projectKey)
  const cabinPath = cabinId === cabinCtx?.cabin?.id
    ? cabinCtx?.cabin?.path ?? null
    : null

  if (!project) {
    return (
      <>
        <div className="ck12-jh">
          <div className="ck12-jh-h1">
            <button type="button" className="ck12-jh-x" aria-label="收起" onClick={onClose}>✕</button>
            <span className="ck12-pj-kind">项目</span>
            <h2 className="ck12-jh-title">{projectKey}</h2>
            <span className="ck12-jh-spacer" />
            <button
              type="button"
              className="ck12-pj-act"
              onClick={() => select(rosterRef(cabinId))}
            >
              ← 舱籍
            </button>
          </div>
        </div>
        <div className="ck12-face-body">
          <div className="ck12-face-empty" data-testid="cockpit-project-missing">
            {loading
              ? '载入项目…'
              : error
                ? `项目数据加载失败 · ${error}`
                : '这个项目不在当前舱的关联里（可能刚解绑）。'}
          </div>
        </div>
      </>
    )
  }

  const stats = projectStats(cabinId, project, rows)
  const cost = projectCost(usage, project.key)
  const jobRows = rows.filter(
    (row) => row.cabinId === cabinId && rowProjectKeys(row).includes(project.key),
  )

  const onlyMe = () => {
    setProjectFilter(projectFilter === project.key ? null : project.key)
    toast.message(
      projectFilter === project.key
        ? '已清除项目筛选'
        : `只看 ${project.name} · 只筛左栏，不换面`,
    )
  }

  const pull = async () => {
    setBusy('pull')
    try {
      const res = await pullCabinRepo(cabinId, project.name)
      toast.success(`拉取主线 · ${project.name} ${res.branch} → ${res.commit}`)
      refetch()
      refetchFleet()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取失败')
    } finally {
      setBusy(null)
    }
  }

  const openWorktree = async () => {
    setBusy('worktree')
    try {
      const entry = await createRepoWorktree(cabinId, project.name, {})
      toast.success(`已开工作树 · ${entry.worktree_path ?? ''}`)
      invalidateCabinProjects(cabinId)
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : '开工作树失败'
      if (message.includes('worktree_exists')) {
        toast.warning('同一分支已经有一个工作树了 —— 不覆盖；要并行就换分支。')
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(null)
    }
  }

  const copyPath = async () => {
    const target = project.worktree_path ?? project.main_path
    if (!target) return
    try {
      await navigator.clipboard.writeText(target)
      toast.success('路径已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  const unbind = async () => {
    setBusy('unbind')
    try {
      await removeCabinRepo(cabinId, project.name)
      toast.success(`已解绑 ${project.name}（磁盘未动）`)
      invalidateCabinProjects(cabinId)
      select(rosterRef(cabinId))
      refetchFleet()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解绑失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="ck12-jh">
        <div className="ck12-jh-h1">
          <button type="button" className="ck12-jh-x" aria-label="收起重目面" onClick={onClose}>✕</button>
          <span className="ck12-pj-kind" data-source={project.source}>项目</span>
          <h2 className="ck12-jh-title">{project.name}</h2>
          <span className="ck12-pj-pill">
            {project.source === 'org' ? (project.org ?? 'ORG') : project.external ? '外部目录' : '本地目录'}
          </span>
          <span className="ck12-pjsrc-tag" data-source={project.source}>
            {project.source === 'org' ? 'ORG' : project.external ? '外部' : '本地'}
          </span>
          <span className="ck12-jh-spacer" />
          <button type="button" className="ck12-pj-act" onClick={() => select(rosterRef(cabinId))}>← 舱籍</button>
          <button type="button" className="ck12-pj-act" data-testid="project-only-jobs" onClick={onlyMe}>
            {projectFilter === project.key ? '取消只看' : '只看它的作业'}
          </button>
          <button type="button" className="ck12-pj-act" disabled={busy !== null} onClick={pull}>
            {busy === 'pull' ? '拉取中…' : '拉取主线'}
          </button>
          <button type="button" className="ck12-pj-act" disabled={busy !== null} onClick={openWorktree}>
            {busy === 'worktree' ? '开中…' : '开工作树'}
          </button>
        </div>
        <div className="ck12-jh-h2">
          <span>{project.git ? `${project.git.branch} → ${project.git.commit}` : '未检出'}</span>
          {project.git?.msg && <><span className="ck12-jh-sep">·</span><span>{project.git.msg}</span></>}
          {project.git?.at && <><span className="ck12-jh-sep">·</span><span>{project.git.at}</span></>}
          <span className="ck12-jh-spacer" />
          <span className="ck12-pj-cap">
            {stats.jobs} 作业 · {stats.running} 运行 · {stats.worktrees} 工作树
            {cost && <> · <span title={cost.complete ? '已定价的作业合计' : '部分行未定价'}>{cost.label}</span></>}
          </span>
        </div>
      </div>

      <div className="ck12-face-body ck12-pj-face-body" data-testid="cockpit-project-face">
        {error && <div className="ck12-pj-note-line">刷新失败 · {error}</div>}
        <div className="ck12-pj-panes">
          <section className="ck12-pj-pane">
            <div className="ck12-pj-pane-h">仓库 <b>{project.source === 'org' ? 'ORG' : 'LOCAL'}</b><span className="ck12-ln" /></div>
            <RepoLines project={project} />
            <div className="ck12-pj-sec">工作树<b>{(project.worktrees?.length ?? 0) + (project.worktree_path ? 1 : 0)}</b> · 按作业开<span className="ck12-ln" /></div>
            {project.worktree_path ? (
              <div className="ck12-pj-wt">
                <i aria-hidden="true">⑂</i>
                <span>{project.branch ?? '—'}</span>
                <em>{project.worktree_path}</em>
              </div>
            ) : (
              <div className="ck12-pj-none">没有主工作树 —— 建舱不预建，作业要时才开</div>
            )}
            {(project.worktrees ?? []).map((wt) => (
              <div key={wt.path} className="ck12-pj-wt">
                <i aria-hidden="true">⑂</i>
                <span>{wt.branch}</span>
                <em>{wt.instance}</em>
              </div>
            ))}
            <div className="ck12-pj-sec">操作<span className="ck12-ln" /></div>
            <div className="ck12-pj-acts">
              <button type="button" onClick={copyPath}>复制路径</button>
              <button type="button" disabled={busy !== null} onClick={() => setBinderOpen(true)}>绑定项目…</button>
              <button type="button" className="is-danger" disabled={busy !== null} onClick={unbind}>
                {busy === 'unbind' ? '解绑中…' : '解绑（不动磁盘）'}
              </button>
            </div>
          </section>

          <section className="ck12-pj-pane">
            <div className="ck12-pj-pane-h">作业 <b>{jobRows.length} JOBS</b><span className="ck12-ln" /></div>
            {jobRows.length === 0 ? (
              <div className="ck12-pj-none">这个项目上还没有作业。派进来就会落在这里。</div>
            ) : (
              <div className="ck12-pj-jobs">
                {jobRows.map((row) => {
                  if (row.kind === 'job') {
                    return (
                      <button
                        key={row.key}
                        type="button"
                        className="ck12-pj-job"
                        onClick={() => select({ kind: 'job', cabinId: row.cabinId, id: row.job.id })}
                      >
                        <span className="t">{row.job.title}</span>
                        <span className="s">{row.job.status}</span>
                      </button>
                    )
                  }
                  if (row.kind === 'task') {
                    return (
                      <button
                        key={row.key}
                        type="button"
                        className="ck12-pj-job"
                        onClick={() => select({ kind: 'task', cabinId: row.cabinId, id: row.task.id })}
                      >
                        <span className="t">{row.task.name}</span>
                        <span className="s">任务</span>
                      </button>
                    )
                  }
                  return null
                })}
              </div>
            )}
            <div className="ck12-pj-sec">说明<span className="ck12-ln" /></div>
            <div className="ck12-pj-none">
              作业的项目锚点：task 用 repo_group / project_ids；workflow / subagent 只在唯一命中时归属，否则算「未归属」。
            </div>
          </section>
        </div>
      </div>

      <CockpitRepoBinder
        open={binderOpen}
        cabinId={cabinId}
        cabinPath={cabinPath}
        projects={projects}
        onClose={() => setBinderOpen(false)}
        onSaved={() => {
          invalidateCabinProjects(cabinId)
          refetch()
          refetchFleet()
        }}
      />
    </>
  )
}

function projectCost(
  usage: CabinUsagePayload | null, key: string,
): { label: string; complete: boolean } | null {
  if (!usage) return null
  let usd: number | null = null
  let priced = 0
  let rows = 0
  for (const row of usage.byJob) {
    if (!row.project_keys?.includes(key)) continue
    rows += 1
    if (row.totals.cost.usd != null) {
      usd = (usd ?? 0) + row.totals.cost.usd
      priced += 1
    }
  }
  if (rows === 0 || usd == null) return null
  return { label: `¥${usd.toFixed(2)}`, complete: priced === rows }
}

function RepoLines({ project }: { project: CabinRepoEntry }) {
  const sourceLabel = project.source === 'org'
    ? `ORG manifest · ${project.org ?? ''}${project.group && project.group !== project.org ? ` · ${project.group}` : ''}`
    : `${project.external ? '外部目录 · 显式登记' : '本地目录 · 建舱时映射'}${project.local_path ? ` · ${project.local_path}` : ''}`
  return (
    <>
      <div className="ck12-pj-line"><span className="k">来源</span><span className="v">{sourceLabel}</span></div>
      <div className="ck12-pj-line">
        <span className="k">门槛</span>
        <span className="v">
          {project.source === 'org'
            ? '主仓只读 · 只能拉主线（ff-only）；要改分支 → 开工作树'
            : '只读引用 · 不克隆不搬代码；要改也开工作树'}
        </span>
      </div>
      <div className="ck12-pj-line"><span className="k">仓库</span><span className="v mono">{project.main_path ?? '—'}</span></div>
      <div className="ck12-pj-line"><span className="k">远端</span><span className="v mono">{project.git?.remote || '—'}</span></div>
      <div className="ck12-pj-line"><span className="k">分支</span><span className="v">
        <b>{project.git?.branch ?? '未检出'}</b>
        {project.git && <> → <b className="mono">{project.git.commit}</b></>}
        {project.mainline_branch && <span className="ck12-pj-dim"> · 主线 {project.mainline_branch}</span>}
      </span></div>
      <div className="ck12-pj-line"><span className="k">状态</span><span className="v">
        {project.git ? (project.git.detached ? 'detached' : '干净可读') : '未检出'}
        {' · '}{project.worktrees?.length ?? 0} 并行 / {project.worktree_path ? 1 : 0} 主工作树
      </span></div>
    </>
  )
}