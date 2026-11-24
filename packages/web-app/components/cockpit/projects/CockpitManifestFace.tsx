'use client'

// 舱籍面（项目总览）：与作业面共用同一扇窗，换内容不换位置。
// v21 五轮（用户）：按原型 projects 面板重画 —— `.pnote` + 每个项目一张 `.pcard`
// （名称 / org·group / 分支·HEAD / 作战·在跑·工作树 / 路径 / 两个跳转），
// 头部换成 dossier 通用 `.ck12-dh`（✕ 左置 + 标题/副行 + ⛶，右上不放动作）。
// 数字只取真值（作业数来自编队行，工作树来自仓库数据）。

import { useMemo, useState } from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects } from './use-cabin-projects'
import { projectRef, projectStats, projectsOf } from './project-model'
import { CockpitRepoBinder } from './CockpitRepoBinder'
import { CockpitFaceHead } from '../face/CockpitFaceHead'

export interface CockpitManifestFaceProps {
  cabinId: string
  onClose: () => void
}

export function CockpitManifestFace({ cabinId, onClose }: CockpitManifestFaceProps) {
  const { select } = useCockpitState()
  const { rows } = useCockpitFleet()
  const cabinCtx = useCabinOptional()
  const { projects, loading, error, refetch } = useCabinProjects(cabinId)
  const [bindOpen, setBindOpen] = useState(false)
  const cabinPath = cabinId === cabinCtx?.cabin?.id ? cabinCtx?.cabin?.path ?? null : null
  const cabinName = cabinId === cabinCtx?.cabin?.id
    ? cabinCtx?.cabin?.name ?? '作战舱'
    : rows.find((r) => r.cabinId === cabinId)?.cabinName ?? '作战舱'

  const org = projectsOf(projects, 'org')
  const local = projectsOf(projects, 'local')
  const totalJobs = useMemo(() => {
    let n = 0
    for (const row of rows) {
      if (row.cabinId === cabinId && row.kind === 'job' && (row.job.project_keys?.length ?? 0) > 0) n += 1
    }
    return n
  }, [rows, cabinId])

  const open = (key: string) => select(projectRef(cabinId, key))

  const card = (p: (typeof projects)[number]) => {
    const stats = projectStats(cabinId, p, rows)
    return (
      <div
        key={p.key}
        className="ck12-pcard is-clickable"
        data-testid={`cockpit-manifest-card-${p.key}`}
        role="button"
        tabIndex={0}
        onClick={() => open(p.key)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open(p.key)
          }
        }}
      >
        <div className="ck12-pcard-h">
          <b>{p.name}</b>
          {(p.org || p.group) && (
            <span className="ck12-pcard-og">{[p.org, p.group].filter(Boolean).join('/')}</span>
          )}
          <span className="ck12-pcard-src" data-source={p.source}>
            {p.source === 'org' ? 'ORG' : p.external ? '外部' : '本地'}
          </span>
        </div>
        <div className="ck12-pcard-git">
          <b>{p.git?.branch ?? p.branch ?? '未检出'}</b>
          {p.git && <> · HEAD {p.git.commit}</>}
          {p.git?.msg && <> · {p.git.msg}</>}
        </div>
        <div className="ck12-pcard-stats">
          <span>作战 <b>{stats.jobs}</b></span>
          <span>在跑 <b>{stats.running}</b></span>
          <span>工作树 <b>{stats.worktrees}</b></span>
        </div>
        <div className="ck12-pcard-wt">{p.worktree_path ?? p.main_path ?? '—'}</div>
        <div className="ck12-pcard-acts">
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); open(p.key) }}
          >
            看该项目作战 →
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              window.dispatchEvent(new CustomEvent('octopus:cockpit-action', {
                detail: { action: 'ws', key: p.name },
              }))
            }}
          >
            ⌗ 工作区文件 →
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <CockpitFaceHead
        glyph="⬡"
        title={`${cabinName} · 关联项目`}
        sub={[
          `${projects.length} 项目`,
          `${org.length} ORG`,
          local.length ? `${local.length} 本地` : null,
          `${totalJobs} 条作业挂在项目上`,
        ].filter(Boolean).join(' · ')}
        onClose={onClose}
        closeLabel="收起舱籍"
      />

      <div className="ck12-face-body" data-testid="cockpit-manifest">
        <div className="ck12-pnote">
          ORG 主仓只读 · 只能拉主线（ff-only）· worktree 按作业开，建舱不预建。
        </div>
        {error && <div className="ck12-pnote">刷新失败 · {error}（显示上一份）</div>}

        <div className="ck12-pcard-acts" style={{ marginBottom: 9 }}>
          <button type="button" onClick={() => setBindOpen(true)}>＋ 绑定项目</button>
          <button type="button" onClick={refetch}>刷新</button>
        </div>

        {loading && projects.length === 0 ? (
          <div className="ck12-face-empty">载入项目…</div>
        ) : projects.length === 0 ? (
          <div className="ck12-pf-empty" data-testid="cockpit-manifest-empty">
            <span className="big" aria-hidden="true">⧉</span>
            <b>这个舱还没绑项目</b>
            <p>项目是关联关系，不搬代码。绑了之后，作业的仓库、工作树、变更才有归属；可跨 org、也可同时绑多个舱。</p>
            <button
              type="button"
              className="ck12-pj-act is-primary"
              onClick={() => setBindOpen(true)}
            >
              ＋ 绑定项目
            </button>
          </div>
        ) : (
          <>
            {org.length > 0 && (
              <>
                <div className="ck12-sect">ORG 项目 · manifest <b>{org.length}</b></div>
                {org.map(card)}
              </>
            )}
            {local.length > 0 && (
              <>
                <div className="ck12-sect">本地 / 外部 · 目录登记 <b>{local.length}</b></div>
                {local.map(card)}
              </>
            )}
            <div className="ck12-doing" style={{ marginTop: 10 }}>
              项目只做关联，代码不搬；ORG 主仓只读（只拉主线），工作树按作业开，建舱不预建。
            </div>
          </>
        )}
      </div>

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={cabinId}
        cabinName={cabinName}
        cabinPath={cabinPath}
        projects={projects}
        onClose={() => setBindOpen(false)}
        onSaved={refetch}
      />
    </>
  )
}
