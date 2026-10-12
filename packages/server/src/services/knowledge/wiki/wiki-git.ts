import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"

/**
 * Wiki git helper — 仓库无 git 库依赖（data-plane notes §6），一律 shell-out。
 * spawnSync("git", args, { cwd, timeout }) 先例：workspace-git.ts L109-126；
 * 测试 fixture 建仓方式：workspace-git.test.ts L32-37（init + per-repo config）。
 */

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export interface GitRunner {
  run(args: string[]): GitResult
}

/** Default runner: spawnSync with array args (Windows 下 git.exe 按 PATH 解析，无引号问题). */
export function spawnGit(cwd: string, timeoutMs = 30000): GitRunner {
  return {
    run(args: string[]): GitResult {
      const r = spawnSync("git", args, { cwd, timeout: timeoutMs })
      return {
        status: r.status ?? 1,
        stdout: r.stdout?.toString() ?? "",
        stderr: r.stderr?.toString() ?? "",
      }
    },
  }
}

/** Run git, throwing on non-zero status with stderr for a readable error. */
export function mustGit(git: GitRunner, args: string[]): GitResult {
  const r = git.run(args)
  if (r.status !== 0) {
    throw new Error(`GIT_FAILED: git ${args.join(" ")} — ${r.stderr.trim() || r.stdout.trim()}`)
  }
  return r
}

/**
 * 首编译时把 wiki 根初始化为独立 git 仓库（.git 已存在则跳过 — 幂等）。
 * 身份写 per-repo git config（fixture 先例同款），不动用户全局配置。
 */
export function ensureWikiGitRepo(root: string, git: GitRunner): void {
  if (fs.existsSync(path.join(root, ".git"))) return
  mustGit(git, ["init"])
  mustGit(git, ["config", "user.name", "octopus-curator"])
  mustGit(git, ["config", "user.email", "wiki@octopus.local"])
}

/** HEAD hash after a commit; null on empty repo (no commits yet). */
export function wikiHead(git: GitRunner): string | null {
  const r = git.run(["rev-parse", "HEAD"])
  return r.status === 0 ? r.stdout.trim() : null
}
