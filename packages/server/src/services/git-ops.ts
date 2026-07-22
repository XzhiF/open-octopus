import { execFile } from "child_process"
import { promisify } from "util"
import { readdirSync, existsSync, statSync, mkdirSync } from "fs"
import { join, dirname } from "path"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000
const GIT_PROJECT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 1024 * 1024

function gitError(projectPath: string, args: string[], cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(
    `Git command failed in ${projectPath}: git ${args.join(" ")}, reason: ${message}`,
  )
}

async function runGit(
  projectPath: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error: unknown) {
    throw gitError(projectPath, args, error)
  }
}

export class GitOps {
  async getHeadCommit(projectPath: string): Promise<string> {
    const { stdout } = await runGit(projectPath, ["rev-parse", "HEAD"])
    return stdout
  }

  async getCurrentBranch(projectPath: string): Promise<string> {
    const { stdout } = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    return stdout
  }

  async hasUncommittedChanges(projectPath: string): Promise<boolean> {
    const { stdout } = await runGit(projectPath, ["status", "--porcelain"])
    return stdout.length > 0
  }

  async autoCommit(projectPath: string, message: string): Promise<string> {
    await runGit(projectPath, ["add", "-A"])
    await runGit(projectPath, ["commit", "-m", message])
    return this.getHeadCommit(projectPath)
  }

  async createBranch(
    projectPath: string,
    branch: string,
    baseCommit: string,
  ): Promise<void> {
    await runGit(projectPath, ["checkout", "-b", branch, baseCommit])
  }

  async switchBranch(projectPath: string, branch: string): Promise<void> {
    await runGit(projectPath, ["checkout", branch])
  }

  async resetHard(projectPath: string, commit: string): Promise<void> {
    await runGit(projectPath, ["reset", "--hard", commit])
  }

  async cleanForce(projectPath: string): Promise<void> {
    await runGit(projectPath, ["clean", "-fd"])
  }

  /** 对 projects 目录下所有 git 项目执行 action */
  async allProjectsAction<T>(
    workspacePath: string,
    action: (projectPath: string, projectName: string) => Promise<T>,
  ): Promise<Record<string, T>> {
    const results: Record<string, T> = {}
    const projectsDir = join(workspacePath, "projects")
    if (!existsSync(projectsDir)) return results

    const entries = readdirSync(projectsDir)
    for (const entry of entries) {
      const projectPath = join(projectsDir, entry)
      const gitDir = join(projectPath, ".git")
      if (statSync(projectPath).isDirectory() && existsSync(gitDir)) {
        results[entry] = await action(projectPath, entry)
      }
    }
    return results
  }

  /** git worktree add --detach <worktree-path> */
  async worktreeAdd(mainRepoPath: string, worktreePath: string): Promise<string> {
    const parentDir = dirname(worktreePath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
    await runGit(mainRepoPath, ["worktree", "add", worktreePath, "--detach"])
    return worktreePath
  }

  /** git worktree remove --force <worktree-path> */
  async worktreeRemove(mainRepoPath: string, worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) return
    await runGit(mainRepoPath, ["worktree", "remove", worktreePath, "--force"])
  }

  /** git worktree list --porcelain */
  async worktreeList(mainRepoPath: string): Promise<{ path: string; head: string; branch: string | null }[]> {
    const { stdout } = await runGit(mainRepoPath, ["worktree", "list", "--porcelain"])
    const result: { path: string; head: string; branch: string | null }[] = []
    let current: { path?: string; head?: string; branch: string | null } = { branch: null }
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) result.push({ path: current.path!, head: current.head ?? "", branch: current.branch })
        current = { path: line.slice(9), branch: null }
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5)
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(14)
      } else if (line === "" && current.path) {
        result.push({ path: current.path!, head: current.head ?? "", branch: current.branch })
        current = { branch: null }
      }
    }
    return result
  }

  /** Get branch info: current branch or detached HEAD SHA */
  async getBranchInfo(projectPath: string): Promise<{ branch: string; detached: boolean }> {
    const { stdout } = await runGit(projectPath, ["branch", "--show-current"])
    if (stdout) return { branch: stdout, detached: false }
    const { stdout: sha } = await runGit(projectPath, ["rev-parse", "--short", "HEAD"])
    return { branch: sha, detached: true }
  }

  /** Create or switch branch. Returns whether branch was created vs switched to existing. */
  async createOrSwitchBranch(projectPath: string, branchName: string): Promise<{ created: boolean }> {
    try {
      await runGit(projectPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      await runGit(projectPath, ["checkout", branchName])
      return { created: false }
    } catch {
      await runGit(projectPath, ["checkout", "-b", branchName])
      return { created: true }
    }
  }

  /** Number of commits ahead of upstream */
  async getAheadCount(projectPath: string): Promise<number> {
    try {
      const { stdout } = await runGit(projectPath, ["rev-list", "--count", "@{upstream}..HEAD"])
      return parseInt(stdout, 10) || 0
    } catch {
      return 0
    }
  }

  /**
   * Detect default branch: prefer "main", fallback "master".
   * Uses `git symbolic-ref refs/remotes/origin/HEAD` if set, otherwise checks
   * `git rev-parse --verify main` then `master` against remote refs.
   * Returns null if neither exists.
   */
  async detectDefaultBranch(projectPath: string): Promise<string | null> {
    // Try origin HEAD shortcut first
    try {
      const { stdout } = await runGit(projectPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      const branch = stdout.replace(/^origin\//, "")
      if (branch === "main" || branch === "master") return branch
    } catch { /* fallthrough */ }

    // Check if refs exist on origin
    for (const candidate of ["main", "master"]) {
      try {
        await runGit(projectPath, ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`])
        return candidate
      } catch { /* try next */ }
    }
    return null
  }

  /**
   * Synchronize a project to the latest main/master. Returns a result describing
   * what happened. Never throws — failures are captured in result.status.
   *
   * Behavior:
   * - On main/master: fetch + merge --ff-only (abort on diverge)
   * - On feature branch: fetch only (HEAD stays on feature)
   * - Detached HEAD: skip
   * - Dirty worktree: auto-commit before merge
   */
  async syncProjectToMain(
    projectPath: string,
    projectName: string,
  ): Promise<SyncProjectResult> {
    try {
      // Check for detached HEAD
      const branchInfo = await this.getBranchInfo(projectPath)
      if (branchInfo.detached) {
        return { projectName, status: "skipped", reason: "detached HEAD" }
      }

      const currentBranch = branchInfo.branch
      const defaultBranch = await this.detectDefaultBranch(projectPath)

      if (!defaultBranch) {
        return { projectName, status: "skipped", reason: "no main/master remote branch found" }
      }

      // Always fetch first
      try {
        await runGit(projectPath, ["fetch", "origin"], GIT_PROJECT_TIMEOUT_MS)
      } catch (fetchErr: unknown) {
        return {
          projectName,
          status: "warning",
          reason: `fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          branch: currentBranch,
        }
      }

      // Not on default branch → fetch only
      if (currentBranch !== defaultBranch) {
        return {
          projectName,
          status: "info",
          reason: `on feature branch ${currentBranch}, fetched only`,
          branch: currentBranch,
        }
      }

      // On default branch: dirty → auto-commit first
      if (await this.hasUncommittedChanges(projectPath)) {
        try {
          await this.autoCommit(projectPath, "[octopus] auto-commit before sync")
        } catch (commitErr: unknown) {
          return {
            projectName,
            status: "warning",
            reason: `auto-commit failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
            branch: currentBranch,
          }
        }
      }

      // Merge --ff-only
      try {
        await runGit(
          projectPath,
          ["merge", "--ff-only", `origin/${defaultBranch}`],
          GIT_PROJECT_TIMEOUT_MS,
        )
        return {
          projectName,
          status: "success",
          branch: currentBranch,
        }
      } catch (mergeErr: unknown) {
        // Abort to leave the tree clean
        try { await runGit(projectPath, ["merge", "--abort"]) } catch { /* best-effort */ }
        return {
          projectName,
          status: "warning",
          reason: `merge failed (aborted): ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`,
          branch: currentBranch,
        }
      }
    } catch (err: unknown) {
      return {
        projectName,
        status: "warning",
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

export interface SyncProjectResult {
  projectName: string
  status: "success" | "info" | "warning" | "skipped"
  reason?: string
  branch?: string
}

export const gitOps = new GitOps()