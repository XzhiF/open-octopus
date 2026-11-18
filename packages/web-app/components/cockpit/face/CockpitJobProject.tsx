'use client'

// 详情 · 项目页签（v21 六轮，原型 renderJobProject）：
// 任务必然指向 git worktree —— 一行一个项目（名称 / 分支 / 完整路径 / 只读），
// 点击在 dossier 之上弹「目录树」窗口。只列本作战自己的项目（会话只列会话的），
// 不铺统计卡、不列全舱舱籍。
//
// 数据源（与 classic 同口径，不另造）：
//   · 任务的 project_ids —— classic 的「N 项目」就是它；
//   · 舱籍真值（useCabinProjects：/repos?enrich=1）按 key / 名字对上号；
//     拿不到条目就禁用该行（树接口要 repo 名），不补 0、不编数据。

import { useCabinProjects } from '../projects/use-cabin-projects'
import { matchRepoEntry, projectNameFromKey } from '../projects/project-model'
import { useCockpitTree } from './tree-window'

export interface CockpitJobProjectProps {
  cabinId: string
  /** 项目锚点：task 用 project_ids（与 classic 同源）；其它用编队行 project_keys。 */
  projects: readonly string[]
  /** 作业分支（舱籍条目没检出 git 时的兜底）。 */
  branch?: string | null
}

export function CockpitJobProject({ cabinId, projects, branch }: CockpitJobProjectProps) {
  const { projects: repos, loading, error } = useCabinProjects(cabinId)
  const tree = useCockpitTree()

  return (
    <div data-testid="cabin-job-project">
      <div className="ck12-pnote">
        任务指向 git worktree · 只读 · 点项目看目录树；只列本作战自己的项目（会话只列会话的项目）。
      </div>

      {projects.length === 0 ? (
        <div className="ck12-face-empty">
          {loading ? '载入项目…' : error ? `项目数据加载失败 · ${error}` : '这条作业没有绑定项目。'}
        </div>
      ) : (
        projects.map((key) => {
          const repo = matchRepoEntry(repos, key)
          const label = repo?.name ?? projectNameFromKey(key)
          const branchName = repo?.git?.branch ?? repo?.branch ?? branch ?? null
          const path = repo?.worktree_path ?? repo?.main_path ?? null
          return (
            <button
              key={key}
              type="button"
              className="ck12-pjrow"
              data-testid={`cabin-job-project-row-${label}`}
              disabled={!repo}
              title={path ?? undefined}
              onClick={() => {
                if (!repo) return
                tree?.open({ cabinId, projects: [...projects], active: key })
              }}
            >
              <span className="ck12-pjrow-g" aria-hidden="true">⌗</span>
              <span className="ck12-pjrow-m">
                <b>{label}</b>
                <span>
                  ⎇ <b>{branchName ?? '未检出'}</b>
                  {' · '}
                  {path ?? (loading ? '载入项目…' : '不在当前舱的关联里')}
                </span>
              </span>
              <span className="ck12-pjrow-ro">只读</span>
              <span className="ck12-pjrow-go">目录树 →</span>
            </button>
          )
        })
      )}
    </div>
  )
}
