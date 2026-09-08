import { execFile } from "child_process"
import { promisify } from "util"
import { readdirSync, existsSync, statSync, mkdirSync } from "fs"
import { join, dirname } from "path"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000
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

  /**
   * Check whether a local branch exists (refs/heads/<name>).
   * Reliable inside a worktree — show-ref resolves through the common git dir.
   */
  private async branchExists(projectPath: string, branchName: string): Promise<boolean> {
    try {
      await runGit(projectPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      return true
    } catch {
      return false
    }
  }

  /** Create or switch branch. Returns whether branch was created vs switched to existing. */
  async createOrSwitchBranch(projectPath: string, branchName: string): Promise<{ created: boolean }> {
    const exists = await this.branchExists(projectPath, branchName)
    if (!exists) {
      await runGit(projectPath, ["checkout", "-b", branchName])
      return { created: true }
    }
    // Branch exists — switch to it. In a worktree this can fail when another
    // working tree holds the branch (e.g. the source repo's main tree is on
    // `main` while this scheduler worktree is on its own `taskpool-<id>`
    // branch). Previously this threw, and the caller's try/catch misread it as
    // "branch missing", falling back to `git checkout -b` which then fatals
    // ("a branch named 'main' already exists"), killing the execution in ~124ms.
    // Keep the current isolated branch instead.
    // Git wording varies by version: ≤~2.40 "fatal: 'main' is already checked
    // out at '<path>'", newer (e.g. 2.43.windows) "fatal: 'main' is already
    // used by worktree at '<path>'" — match both (open-octopus E2E 票05 fix:
    // the first wording alone left every v4 dispatch fataling at
    // switchToExecutionBranch("main") on machines with the newer git).
    try {
      await runGit(projectPath, ["checkout", branchName])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already (?:checked out|used by worktree)/i.test(msg)) {
        process.stderr.write(
          `[git-ops] branch "${branchName}" is checked out by another worktree; keeping current branch in ${projectPath}\n`,
        )
        return { created: false }
      }
      throw err
    }
    return { created: false }
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

  /** Fetch from origin and merge the default branch. Returns new HEAD commit SHA. Throws on conflict. */
  async pullLatest(projectPath: string): Promise<string> {
    await runGit(projectPath, ["fetch", "origin"])
    const { stdout: defaultBranch } = await runGit(projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    const branch = defaultBranch.replace("refs/remotes/origin/", "")
    await runGit(projectPath, ["merge", `origin/${branch}`, "--no-edit"])
    return this.getHeadCommit(projectPath)
  }

  /**
   * 镜像同步（draft repo-sync 2026-09-08）：把 repos 主 clone 强制对齐到
   * origin/<默认分支> 最新。与 pullLatest 的区别是**语义级**的：主 clone 按
   * 一次性镜像对待（用户授权决策）——
   *   fetch origin → 默认分支探测（symbolic-ref origin/HEAD，回退 main/master）
   *   → checkout -f <br> → clean -fd → reset --hard origin/<br>
   * 镜像上的任何本地改动/未跟踪文件**全部丢弃**（这正是「repos 永远干净且在
   * main/master」不变量的执行机制）；绝不作用 workspaces 的 worktree 目录。
   * fetch 超时放宽 120s（GIT_TIMEOUT_MS=30s 对远端仓库太小）。
   * @returns branch = 同步到的默认分支名；commit = 新 HEAD 短 8 位
   * @throws origin 无 main/master 可对齐、网络/命令失败
   */
  async syncToDefaultBranch(repoPath: string): Promise<{ branch: string; commit: string }> {
    await runGit(repoPath, ["fetch", "origin"], 120_000)

    let branch = ""
    try {
      const { stdout } = await runGit(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"])
      branch = stdout.replace("refs/remotes/origin/", "")
    } catch {
      // origin/HEAD 符号引用缺失（老 clone / --single-branch）→ 定点探测 main/master
      for (const cand of ["main", "master"]) {
        const probe = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cand}`]).catch(() => null)
        if (probe && probe.stdout) { branch = cand; break }
      }
      if (!branch) {
        throw new Error(`无法确定 origin 默认分支（origin/main、origin/master 均不存在）: ${repoPath}`)
      }
    }

    await runGit(repoPath, ["checkout", "-f", branch])
    await this.cleanForce(repoPath)
    await this.resetHard(repoPath, `origin/${branch}`)
    const head = await this.getHeadCommit(repoPath)
    return { branch, commit: head.slice(0, 8) }
  }
}

export const gitOps = new GitOps()