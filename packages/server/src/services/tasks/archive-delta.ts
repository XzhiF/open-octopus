// packages/server/src/services/tasks/archive-delta.ts
//
// 2026-10-31 归档收尾（AI-native v2 落地）— 放行后的现场检查。
//
// 一个任务从「最后一轮结束」到「归档开始」之间，人可能又做了小修（验收引导轮
// 的 quick-edit）或直接在 worktree 里改文件。旧口径只看 executions.start..end，
// 这些改动会掉进裂缝：代码可能进了分支，但证据/报告/知识包不知道。
//
// 本模块把「末轮 end 锚 → 当前 HEAD」的提交、以及当前 dirty 文件，统一算成
// {@link ProjectDelta}，供三处消费：
//   1. 验收终检（get_acceptance_plan 的 postRound）——放行前先让用户看见现场；
//   2. 归档 preflight（archiving-service）——dirty 未决策就停在 archiving；
//   3. 归档素材（archive-materials 的 PR diff）——end 锚改成归档时 HEAD。
//
// 纯读；git 全部经可注入 CommandRunner（生产 spawnSync，测试真 git/假实现）。

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import type Database from "better-sqlite3"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable command runner (production = spawnSync; tests = real git). */
export type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandResult

export const defaultRun: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: 120000,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString() + (r.error ? ` ${r.error.message}` : ""),
  }
}

export interface ProjectDelta {
  project: string
  /** Resolved worktree dir (null = project not resolvable). */
  dir: string | null
  /** Last round's end anchor for this repo (null = no exec anchor). */
  from: string | null
  /** Current HEAD at inspection time. */
  head: string | null
  /** Commits after the last round's end anchor (from..HEAD). */
  commits: number
  /** Subjects of those commits (capped). */
  subjects: string[]
  /** `git status --porcelain` lines (capped). Empty = clean. */
  dirty_files: string[]
  /** Non-fatal read problem (worktree/git missing). */
  error?: string
}

const DIRTY_CAP = 200
const SUBJECT_CAP = 20

function parseJSONSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function lines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0)
}

interface TaskDeltaRow {
  project_ids: string | null
  workspace_id: string | null
}

/** Last non-empty end-commit map among the task's execution rows (same
 *  predicate as archive-materials: root row or a phase row, chronological). */
export function lastRoundEndCommits(db: Database.Database, taskId: string): Record<string, string> {
  const rows = db.prepare(
    `SELECT end_commit_id FROM executions
     WHERE task_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
     ORDER BY created_at ASC`,
  ).all(taskId) as Array<{ end_commit_id: string | null }>
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const map = parseJSONSafe<Record<string, unknown>>(rows[i]!.end_commit_id, {})
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(map)) if (typeof v === "string" && v) out[k] = v
    if (Object.keys(out).length > 0) return out
  }
  return {}
}

export interface ResolveRepoDirResult {
  dir: string | null
  error?: string
}

/** Workspace config.json repos[].worktree_path first, then `{ws}/projects/<name>`. */
export function resolveProjectDir(wsPath: string | null, project: string): ResolveRepoDirResult {
  if (!wsPath) return { dir: null, error: "workspace 未绑定" }
  const cfgPath = path.join(wsPath, "config.json")
  let configured: string | null = null
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = parseJSONSafe<{ repos?: Array<{ name?: string; worktree_path?: string }> }>(
        fs.readFileSync(cfgPath, "utf-8"),
        {},
      )
      configured = cfg.repos?.find((r) => r.name === project)?.worktree_path ?? null
    }
  } catch {
    /* malformed config — fall back to the canonical layout */
  }
  const candidates = [configured, path.join(wsPath, "projects", project)].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  )
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return { dir }
    } catch {
      /* try next */
    }
  }
  return { dir: null, error: `worktree 不在盘: ${candidates[0] ?? path.join(wsPath, "projects", project)}` }
}

/** Inspect every project of a task: commits since the last round end + dirty files. */
export function inspectTaskDelta(
  db: Database.Database,
  taskId: string,
  opts: { run?: CommandRunner } = {},
): ProjectDelta[] {
  const run = opts.run ?? defaultRun
  const row = db.prepare("SELECT project_ids, workspace_id FROM tasks WHERE id = ?")
    .get(taskId) as TaskDeltaRow | undefined
  if (!row) return []
  const projects = parseJSONSafe<string[]>(row.project_ids, [])
  const ws = row.workspace_id
    ? db.prepare("SELECT path FROM workspaces WHERE id = ?").get(row.workspace_id) as { path?: string } | undefined
    : undefined
  const wsPath = ws?.path ?? null
  const ends = lastRoundEndCommits(db, taskId)
  return projects.map((project) => inspectProjectDelta(project, wsPath, ends[project] ?? null, run))
}

export function inspectProjectDelta(
  project: string,
  wsPath: string | null,
  from: string | null,
  run: CommandRunner = defaultRun,
): ProjectDelta {
  const resolved = resolveProjectDir(wsPath, project)
  const base: ProjectDelta = {
    project,
    dir: resolved.dir,
    from,
    head: null,
    commits: 0,
    subjects: [],
    dirty_files: [],
    ...(resolved.error ? { error: resolved.error } : {}),
  }
  if (!resolved.dir) return base
  const dir = resolved.dir
  const head = run("git", ["rev-parse", "HEAD"], dir)
  if (head.code !== 0) {
    return { ...base, error: `git rev-parse HEAD 失败: ${head.stderr.trim() || "not a git worktree"}` }
  }
  const headSha = head.stdout.trim()
  const status = run("git", ["status", "--porcelain"], dir)
  const dirty = status.code === 0 ? lines(status.stdout).slice(0, DIRTY_CAP) : []
  let commits = 0
  let subjects: string[] = []
  if (from && headSha && from !== headSha) {
    const count = run("git", ["rev-list", "--count", `${from}..${headSha}`], dir)
    if (count.code === 0) commits = parseInt(count.stdout.trim(), 10) || 0
    const log = run("git", ["log", "--format=%s", `${from}..${headSha}`], dir)
    if (log.code === 0) subjects = lines(log.stdout).slice(0, SUBJECT_CAP)
  }
  return {
    ...base,
    head: headSha,
    commits,
    subjects,
    dirty_files: dirty,
    ...(status.code !== 0 ? { error: `git status 失败: ${status.stderr.trim() || status.code}` } : {}),
  }
}

/** Stable fingerprint of the dirty surface (project → status lines), used to
 *  remember an include/exclude decision across retries. */
export function dirtyFingerprint(deltas: ProjectDelta[]): string {
  return JSON.stringify(
    deltas
      .map((d) => ({ project: d.project, files: [...d.dirty_files].sort() }))
      .filter((d) => d.files.length > 0)
      .sort((a, b) => a.project.localeCompare(b.project)),
  )
}

export function hasDirtyWorktrees(deltas: ProjectDelta[]): boolean {
  return deltas.some((d) => d.dirty_files.length > 0)
}
