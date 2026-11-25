'use client'

// 舱籍读数 + 浮层（design 21 §1 · plan 22 §4.3）。
// 读数常驻 HUD：`⧉ <舱名> N 项目 ▾`；0 项目 → `＋ 绑定项目`。
// 浮层按来源分组（ORG / 本地），行内是**已有真值**：来源、分支·HEAD、作业数、
// 工作树数；数字拿不到就省略，不写 0 冒充。

import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CabinRepoEntry } from '@/lib/cabin-api'
import { formatDateTime } from '@/lib/format'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { projectRef, projectStats, projectsOf, rosterRef } from './project-model'

export interface CockpitProjectsPopoverProps {
  cabinId: string
  cabinName: string
  projects: CabinRepoEntry[]
  loading: boolean
  error: string | null
  onRefetch: () => void
  onBind: () => void
}

export function CockpitProjectsPopover({
  cabinId, cabinName, projects, loading, error, onRefetch, onBind,
}: CockpitProjectsPopoverProps) {
  const { select, layer } = useCockpitState()
  const { rows } = useCockpitFleet()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-projects-pop', 40, () => setOpen(false))
  }, [open, layer])

  const org = projectsOf(projects, 'org')
  const local = projectsOf(projects, 'local')
  const count = projects.length

  const openProject = (key: string) => {
    select(projectRef(cabinId, key))
    setOpen(false)
  }
  const openRoster = () => {
    select(rosterRef(cabinId))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // 2026-11-19 用户 #5：绑定可能发生在别处（对话里让汐音绑 / 另一个窗口）——
        // 每次打开浮层强制拉一次真值，不再等 30s 缓存自然过期。
        if (next) onRefetch()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ck12-pjbtn"
          data-testid="cockpit-projects-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="当前作战舱关联的项目（项目是关联关系，不搬代码）"
        >
          <span className="ck12-pjhex" aria-hidden="true">⧉</span>
          <span className="ck12-pjname">{cabinName}</span>
          {count > 0 ? (
            <>
              <b>{count}</b>
              <span className="ck12-pjunit">项目</span>
              <span className="ck12-pjcv" aria-hidden="true">▾</span>
            </>
          ) : (
            <span className="ck12-pjempty">＋ 绑定项目</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="ck12-pjpop" data-testid="cockpit-projects-pop">
        <div className="ck12-pjpop-h">
          <span className="ck12-pjpop-k">舱籍 · 关联项目</span>
          <span className="ck12-pjpop-sub">{cabinName} · {count} 项目</span>
        </div>

        {error && (
          <div className="ck12-pjpop-err" data-testid="cockpit-projects-error">
            刷新失败 · {error}
            <button type="button" onClick={onRefetch}>重试</button>
          </div>
        )}

        {loading && count === 0 ? (
          <div className="ck12-pjpop-empty">载入项目…</div>
        ) : count === 0 ? (
          <div className="ck12-pjpop-empty" data-testid="cockpit-projects-empty">
            <span className="big" aria-hidden="true">⧉</span>
            <b>这个舱还没绑项目</b>
            <p>项目是关联关系，不搬代码。绑了之后作业才有项目归属。</p>
            <button type="button" className="ck12-pjpop-bind" onClick={onBind}>＋ 绑定项目</button>
          </div>
        ) : (
          <div className="ck12-pjpop-list">
            {org.length > 0 && (
              <div className="ck12-pjsrc">ORG 注册项目 <b>{org.length}</b></div>
            )}
            {org.map((p) => <ProjectRow key={p.key} cabinId={cabinId} project={p} onOpen={openProject} />)}
            {local.length > 0 && (
              <div className="ck12-pjsrc">本地 Git 仓库 <b>{local.length}</b></div>
            )}
            {local.map((p) => <ProjectRow key={p.key} cabinId={cabinId} project={p} onOpen={openProject} />)}
          </div>
        )}

        {count > 0 && (
          <div className="ck12-pjpop-foot">
            <button type="button" className="ck12-pjpop-btn" onClick={onBind}>＋ 绑定项目</button>
            <span>ORG 注册 / 本地目录</span>
            <span className="ck12-pjpop-sp" />
            <button type="button" className="ck12-pjpop-btn is-go" onClick={openRoster}>舱籍总览 →</button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ProjectRow({
  cabinId,
  project,
  onOpen,
}: {
  cabinId: string
  project: CabinRepoEntry
  onOpen: (key: string) => void
}) {
  const { rows } = useCockpitFleet()
  const stats = projectStats(cabinId, project, rows)
  const where = project.source === 'org'
    ? [project.org, project.group].filter(Boolean).join('/') || '—'
    : (project.local_path ?? project.main_path ?? '')
  const g = project.git

  return (
    <button
      type="button"
      className="ck12-pjx"
      data-proj={project.key}
      data-source={project.source}
      onClick={() => onOpen(project.key)}
      title={g ? `${g.branch} · ${g.commit}` : project.main_path ?? undefined}
    >
      <span className="ck12-pjx-dot" aria-hidden="true" />
      <span className="ck12-pjx-main">
        <span className="ck12-pjx-t">
          <b>{project.name}</b>
          <span className="ck12-pjx-tag" data-source={project.source}>
            {project.source === 'org' ? 'ORG' : project.external ? '外部' : 'LOCAL'}
          </span>
          <span className="ck12-pjx-where">{where}</span>
        </span>
        {g ? (
          <>
            <span className="ck12-pjx-git">
              <span className="br" title={g.branch}>⎇ {g.branch}</span>
              <span className="head">{g.commit}</span>
              <span className="at">{formatDateTime(g.at)}</span>
              <span className="ml" title="任务分支从这条分支 fork，MR 默认也合回这条">
                落点 {project.mainline_branch ?? '默认'}
              </span>
            </span>
            <span className="ck12-pjx-msg">
              {g.msg || '（无提交说明）'}
              {g.dirty && <em> · dirty</em>}
            </span>
          </>
        ) : (
          <span className="ck12-pjx-miss">未检出 · 主仓路径不可达</span>
        )}
        <span className="ck12-pjx-facts">
          <span>作战 <b>{stats.jobs}</b></span>
          <span>在跑 <b>{stats.running}</b></span>
          <span>工作树 <b>{stats.worktrees}</b></span>
        </span>
      </span>
      <span className="ck12-pjx-go" aria-hidden="true">项目面 →</span>
    </button>
  )
}