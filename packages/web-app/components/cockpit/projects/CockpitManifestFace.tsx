'use client'

// 舱籍面（项目总览）：与作业面共用同一扇窗，换内容不换位置。
// ORG 项目分列 + 本地/外部条；点项目 → 项目面；点作业 → 作业面。
// 空态给绑定入口；数字只取真值（作业数来自编队行，工作树来自仓库数据）。

import { useMemo, useState } from 'react'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinProjects } from './use-cabin-projects'
import { projectRef, projectStats, projectsOf } from './project-model'
import { CockpitRepoBinder } from './CockpitRepoBinder'

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

  return (
    <>
      <div className="ck12-jh ck12-pf-head">
        <div className="ck12-jh-h1">
          <button
            type="button"
            className="ck12-jh-x"
            aria-label="收起舱籍"
            title="收起（Esc）"
            onClick={onClose}
          >
            ✕
          </button>
          <span className="ck12-pj-kind">舱籍</span>
          <h2 className="ck12-jh-title">{cabinName} · 关联项目</h2>
          <span className="ck12-pj-pill">
            {projects.length} 项目 · {org.length} ORG{local.length ? ` · ${local.length} 本地` : ''}
          </span>
          <span className="ck12-jh-spacer" />
          <span className="ck12-pj-cap">{totalJobs} 条作业挂在项目上</span>
          <button type="button" className="ck12-pj-act" onClick={() => setBindOpen(true)}>＋ 绑定项目</button>
          <button type="button" className="ck12-pj-act" onClick={refetch}>刷新</button>
        </div>
        <div className="ck12-jh-h2">
          <span>项目是关联关系，不搬代码 —— ORG 按 manifest（主仓只读），本地按工作目录映射</span>
        </div>
      </div>

      <div className="ck12-face-body ck12-pf-body" data-testid="cockpit-manifest">
        {error && (
          <div className="ck12-pj-note-line">
            刷新失败 · {error}（显示上一份）
          </div>
        )}
        {loading && projects.length === 0 ? (
          <div className="ck12-face-empty">载入项目…</div>
        ) : projects.length === 0 ? (
          <div className="ck12-pf-empty" data-testid="cockpit-manifest-empty">
            <span className="big" aria-hidden="true">⧉</span>
            <b>这个舱还没绑项目</b>
            <p>项目是关联关系，不搬代码。绑了之后，作业的仓库、工作树、变更才有归属；可跨 org、也可同时绑多个舱。</p>
            <button type="button" className="ck12-pj-act is-primary" onClick={() => setBindOpen(true)}>＋ 绑定项目</button>
          </div>
        ) : (
          <>
            {org.length > 0 && (
              <div className="ck12-pf-lanes">
                {org.map((p) => {
                  const stats = projectStats(cabinId, p, rows)
                  return (
                    <button
                      key={p.key}
                      type="button"
                      className="ck12-pf-lane"
                      data-proj={p.key}
                      onClick={() => open(p.key)}
                    >
                      <span className="ck12-pf-lane-h">
                        <b>{p.name}</b>
                        <span className="ck12-pjsrc-tag" data-source="org">ORG</span>
                      </span>
                      <span className="ck12-pf-lane-where">{p.org ?? ''}{p.group && p.group !== p.org ? ` · ${p.group}` : ''}</span>
                      <span className="ck12-pf-lane-git">
                        {p.git ? `${p.git.branch} → ${p.git.commit}` : '未检出'}
                      </span>
                      <span className="ck12-pf-lane-msg">{p.git?.msg ?? '主仓路径不可达'}</span>
                      <span className="ck12-pf-lane-facts">
                        <span><b>{stats.jobs}</b> 作业</span>
                        <span><b>{stats.running}</b> 运行</span>
                        <span><b>{stats.worktrees}</b> 工作树</span>
                      </span>
                      <span className="ck12-pf-lane-foot">
                        {p.worktree_path ? '有主工作树' : '工作树按作业开'}
                        <span aria-hidden="true">→</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {local.length > 0 && (
              <div className="ck12-pf-local">
                <div className="ck12-pf-local-h">
                  本地 / 外部 · 建舱时映射 <b>{local.length}</b>
                  <span className="ck12-ln" aria-hidden="true" />
                </div>
                {local.map((p) => {
                  const stats = projectStats(cabinId, p, rows)
                  return (
                    <button
                      key={p.key}
                      type="button"
                      className="ck12-pf-local-row"
                      data-proj={p.key}
                      onClick={() => open(p.key)}
                    >
                      <b>{p.name}</b>
                      <span className="where">{p.local_path ?? p.main_path ?? ''}</span>
                      <span className="git">{p.git ? `${p.git.branch} → ${p.git.commit}` : '未检出'}</span>
                      <span className="facts">{stats.jobs} 作业 · {stats.worktrees} 工作树</span>
                      <span className="go">打开 →</span>
                    </button>
                  )
                })}
                <div className="ck12-pf-local-note">
                  目录里的项目：初始化时映射成关联，不克隆、不搬代码、不预建工作树。
                </div>
              </div>
            )}

            <div className="ck12-pf-note">
              项目只做关联，代码不搬；ORG 主仓只读（只拉主线），工作树按作业开，建舱不预建。
            </div>
          </>
        )}
      </div>

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={cabinId}
        cabinPath={cabinPath}
        projects={projects}
        onClose={() => setBindOpen(false)}
        onSaved={refetch}
      />
    </>
  )
}