'use client'

// 舱籍（项目）纯模型：key 解析 / 舱籍面 ref / 编队行的项目锚点。
//
// 项目 key 与 server 同构（cabin-repos.projectKey）：
//   org:<org>/<name>   ·   local:<local_path | absolute_path>
// 编队行只带 key（`project_keys`），名字从 key 派生 —— 不加接口、不猜。

import type { CabinRepoEntry } from '@/lib/cabin-api'
import type { CockpitRef } from '../state/cockpit-state'
import type { CockpitRow } from '../fleet/fleet-model'

/** 舱籍面（项目总览）在 selection 里的占位 id：?project=__roster__。 */
export const PROJECT_ROSTER_ID = '__roster__'

/** key → 展示名：ORG 取仓库名；本地取路径最后一段。 */
export function projectNameFromKey(key: string): string {
  if (key.startsWith('local:')) {
    const p = key.slice('local:'.length)
    const parts = p.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? p
  }
  if (key.startsWith('org:')) {
    const parts = key.slice('org:'.length).split('/')
    return parts[parts.length - 1] || key
  }
  return key
}

export function projectRef(cabinId: string, id: string): CockpitRef {
  return { kind: 'project', cabinId, id }
}

export function rosterRef(cabinId: string): CockpitRef {
  return projectRef(cabinId, PROJECT_ROSTER_ID)
}

export function isProjectRef(ref: CockpitRef | null | undefined): boolean {
  return ref?.kind === 'project'
}

/** 行上的项目锚点（task 行的合成行没有该字段 → 空数组，不猜）。 */
export function rowProjectKeys(row: CockpitRow): string[] {
  if (row.kind === 'job') return row.job.project_keys ?? []
  return []
}

export function rowProjectLabel(row: CockpitRow): string | null {
  const keys = rowProjectKeys(row)
  if (keys.length === 0) return null
  const first = projectNameFromKey(keys[0])
  return keys.length > 1 ? `${first} +${keys.length - 1}` : first
}

/** 项目统计：作业 / 运行 / 工作树。全部来自已有真值。 */
export interface ProjectStats {
  jobs: number
  running: number
  worktrees: number
  /** 该项目上最近一条作业（用于浮层「在做」）。 */
  latestTitle: string | null
}

export function projectStats(
  cabinId: string,
  project: CabinRepoEntry,
  rows: readonly CockpitRow[],
): ProjectStats {
  const anchor = project.key
  let jobs = 0
  let running = 0
  let latestTitle: string | null = null
  for (const row of rows) {
    if (row.cabinId !== cabinId) continue
    if (!rowProjectKeys(row).includes(anchor)) continue
    jobs += 1
    if (row.kind === 'job' && row.job.status === 'running') running += 1
    if (!latestTitle) latestTitle = row.kind === 'job' ? row.job.title : row.kind === 'task' ? row.task.name : null
  }
  const worktrees = (project.worktrees?.length ?? 0) + (project.worktree_path ? 1 : 0)
  return { jobs, running, worktrees, latestTitle }
}

export function projectsOf(
  projects: readonly CabinRepoEntry[], source: 'org' | 'local',
): CabinRepoEntry[] {
  return projects.filter((p) => p.source === source)
}