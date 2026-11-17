// packages/server/src/services/tasks/task-project-resolver.ts
//
// design 23 §3.2/§3.3 —— 任务项目路径解析的唯一实现。
//
// 舱的本地 / 外部项目只登记在 `<cabin>/config.json.repos[]`，不在 org
// `repos/index.md`；任务域所有需要「项目名 → 本地路径」的地方（context.md
// 生成、v4 入队门、执行期 worktree 预建）都必须走同一顺序：
//
//   ① org 注册表（WorkspaceGit.resolveRepoPath）；
//   ② 舱 config（resolveCabinRepo），目录必须真实存在 —— 不猜、不造幻影 worktree；
//   ③ 解析不到 → null（调用方决定是缺项还是降级）。
//
// `cabinHasProjects` 是同一条口径的门禁辅助：一个项目都没有的舱允许无项目入列；
// 有项目的舱要求任务至少绑一个。

import fs from "fs"
import type Database from "better-sqlite3"
import { WorkspaceGit } from "../workspace-git"
import { readCabinConfig, resolveCabinRepo } from "../cabin/cabin-repos"

export interface TaskProjectOwner {
  repo_group: string | null
  cabin_id: string | null
}

/** Cabin directory for a task, or null (deleted / not a cabin task). */
export function cabinPathOf(db: Database.Database, cabinId: string): string | null {
  try {
    const row = db
      .prepare("SELECT path FROM cabins WHERE id = ? AND deleted_at IS NULL")
      .get(cabinId) as { path?: string } | undefined
    return row?.path ?? null
  } catch {
    return null
  }
}

/** Project name → absolute local path, or null when unresolvable. */
export function resolveTaskProjectPath(
  db: Database.Database,
  task: TaskProjectOwner,
  name: string,
): string | null {
  if (task.repo_group && task.repo_group.trim() !== "") {
    try {
      return new WorkspaceGit().resolveRepoPath(task.repo_group, name)
    } catch { /* fall through to the cabin registry */ }
  }
  if (!task.cabin_id) return null
  const cabinPath = cabinPathOf(db, task.cabin_id)
  if (!cabinPath) return null
  try {
    const entry = readCabinConfig(cabinPath).repos.find((r) => r.name === name)
    if (!entry) return null
    const { mainPath } = resolveCabinRepo(cabinPath, entry)
    return mainPath && fs.existsSync(mainPath) ? mainPath : null
  } catch {
    return null
  }
}

/** Does the cabin declare any project at all? (Policy gate, design 23 §3.3.) */
export function cabinHasProjects(db: Database.Database, cabinId: string): boolean {
  const cabinPath = cabinPathOf(db, cabinId)
  if (!cabinPath) return false
  try {
    return readCabinConfig(cabinPath).repos.some((r) => !!r.name)
  } catch {
    return false
  }
}
