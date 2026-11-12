// packages/server/src/services/cabin/cabin-knowledge.ts
//
// G4 findings 舱级 scoping —— 读时派生，不给 findings 加 cabin_id 列（保持全局
// wiki 解耦）。锚点链：finding.raw_ref（或 detail.raw.path）→ raw front-matter
// origin "task-archive:<taskId>" → 任务行 → cabin_id 命中 OR repo_group /
// project_ids 与舱仓库相交。patrol findings 无 raw 锚点 → 不入舱。
// raw 素材包冻结后不变，按 finding.id+updated_at+status 缓存命中结果，10s 轮询
// 不重复读盘。

import type { FindingRow } from "../../db/dao/findings-dao"
import { readRawSource } from "../knowledge/raw"

export interface CabinFindingTaskRef {
  cabin_id?: string | null
  repo_group?: string | null
  project_ids?: string | null
}

export interface CabinFindingScopeOpts {
  root: string
  cabinId: string
  cabinRepoNames: ReadonlySet<string>
  taskById: (id: string) => CabinFindingTaskRef | undefined
}

const cache = new Map<string, boolean>()

function rawRelOf(f: FindingRow): string | null {
  if (f.raw_ref) return f.raw_ref
  try {
    const detail = JSON.parse(f.detail) as { raw?: { path?: string } }
    return detail.raw?.path ?? null
  } catch {
    return null
  }
}

function taskMatchesCabin(task: CabinFindingTaskRef, opts: CabinFindingScopeOpts): boolean {
  if (task.cabin_id === opts.cabinId) return true
  if (task.repo_group && opts.cabinRepoNames.has(task.repo_group)) return true
  if (task.project_ids) {
    try {
      const projects = JSON.parse(task.project_ids) as unknown
      if (Array.isArray(projects)) {
        return projects.some((p) => typeof p === "string" && opts.cabinRepoNames.has(p))
      }
    } catch { /* malformed project_ids → no repo anchor */ }
  }
  return false
}

export function scopeCabinFindings(findings: FindingRow[], opts: CabinFindingScopeOpts): FindingRow[] {
  const out: FindingRow[] = []
  for (const f of findings) {
    const key = `${f.id}:${f.updated_at}:${f.status}`
    const hit = cache.get(key)
    if (hit === true) { out.push(f); continue }
    if (hit === false) continue
    let match = false
    const rel = rawRelOf(f)
    if (rel) {
      try {
        const raw = readRawSource(opts.root, rel)
        const m = /^task-archive:(.+)$/.exec(raw.origin ?? "")
        if (m) {
          const task = opts.taskById(m[1])
          if (task) match = taskMatchesCabin(task, opts)
        }
      } catch { /* raw gone / bad path → no anchor */ }
    }
    cache.set(key, match)
    if (match) out.push(f)
  }
  return out
}

/** Test hook: drop the read-time cache between fixtures. */
export function clearCabinFindingScopeCache(): void {
  cache.clear()
}