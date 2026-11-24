// packages/server/src/services/tasks/branch-plan.ts
//
// 分支计划解析（2026-11-24 用户拍板）—— 任务分支从哪 fork（base）、PR 往哪合
// （target）。解析顺序：
//
//   ① 任务显式：task_spec.branch_plan[repo] > task_spec.base_branch / target_branch
//   ② 舱项目绑定：<cabin>/config.json.repos[].mainline_branch（舱里的落点分支）
//   ③ 空 —— 由调用方补「仓库默认分支」（workspace-git 建树时 / 归档 PR 时各自探测）
//
// 注意与路径解析的方向相反：`resolveTaskProjectPath` 是 org 注册表优先、舱兜底；
// 分支计划必须**舱绑定优先** —— 同名仓在 org 注册表里也有时，用户在舱里的落点
// 意图不能被注册表吞掉。
//
// target 缺省跟随 base（用户：允许不同，默认同值）。

import type Database from "better-sqlite3"
import { readCabinConfig } from "../cabin/cabin-repos"
import { cabinPathOf } from "./task-project-resolver"

export type BranchPlanSource = "task" | "cabin"

export interface BranchOverrides {
  base?: string
  target?: string
  source: BranchPlanSource
}

interface TaskBranchSpec {
  base_branch?: unknown
  target_branch?: unknown
  branch_plan?: unknown
}

function parseSpec(raw: string | null | undefined): TaskBranchSpec {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === "object" ? (v as TaskBranchSpec) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/** 任务 × 仓库的显式覆盖；null = 没有任何显式/舱绑定值（交给默认分支）。 */
export function resolveBranchOverrides(
  db: Database.Database,
  task: { cabin_id?: string | null; task_spec?: string | null },
  repoName: string,
): BranchOverrides | null {
  const spec = parseSpec(task.task_spec)
  const perRepo =
    spec.branch_plan && typeof spec.branch_plan === "object"
      ? (spec.branch_plan as Record<string, unknown>)[repoName]
      : undefined
  const entry =
    perRepo && typeof perRepo === "object"
      ? (perRepo as { base?: unknown; target?: unknown })
      : undefined
  const base = str(entry?.base) ?? str(spec.base_branch)
  const target = str(entry?.target) ?? str(spec.target_branch)
  if (base || target) {
    return {
      ...(base ? { base } : {}),
      ...(target ? { target } : {}),
      source: "task",
    }
  }

  const cabin = cabinMainlineBranch(db, task.cabin_id, repoName)
  if (cabin) return { base: cabin, target: cabin, source: "cabin" }
  return null
}

/** 舱项目登记的落点分支（mainline_branch）。读 config 失败一律按未登记。 */
export function cabinMainlineBranch(
  db: Database.Database,
  cabinId: string | null | undefined,
  repoName: string,
): string | undefined {
  if (!cabinId) return undefined
  const cabinPath = cabinPathOf(db, cabinId)
  if (!cabinPath) return undefined
  try {
    const entry = readCabinConfig(cabinPath).repos.find(
      (r) => r.name === repoName || r.repoName === repoName,
    )
    const branch = entry?.mainline_branch?.trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

/** target 缺省跟随 base；两者都空时返回空对象。 */
export function fillTarget(o: BranchOverrides | null): { base?: string; target?: string } {
  if (!o) return {}
  const base = o.base
  const target = o.target ?? base
  return {
    ...(base ? { base } : {}),
    ...(target ? { target } : {}),
  }
}
