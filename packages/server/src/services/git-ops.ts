import { execFile } from "child_process"
import { promisify } from "util"
import { readdirSync, existsSync, statSync, mkdirSync } from "fs"
import { join, dirname } from "path"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 1024 * 1024
/** Diff-family buffer (验货台 round-diff): numstat of a huge branch diff and a
 *  single-file patch both blow past the 1MB default; the READ ceiling for
 *  patches is still enforced at 512K chars above that (truncated flag). */
export const GIT_DIFF_MAX_BUFFER = 16 * 1024 * 1024
export const GIT_PATCH_CHAR_CAP = 512_000

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
  maxBufferBytes = GIT_MAX_BUFFER,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
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

  // ── 验货台 (acceptance v2)：range-diff family ──────────────────────────
  // All read-only; called with FULL 40-char SHAs from executions.start/end_commit
  // (never user-typed refs — the round-evidence service validates first).
  // execFile array args → no shell; pathspecs use :(literal) magic.

  /** `rev-parse --verify <sha>^{commit}` — false on missing object/dir. The
   *  honest evidence-expiry probe (worktree gone but main clone holds the
   *  object store → still true when run against main_path). */
  async commitExists(projectPath: string, sha: string): Promise<boolean> {
    try {
      await runGit(projectPath, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /** commits in (from..to] — cheap count for the stat strip. */
  async countCommits(projectPath: string, from: string, to: string): Promise<number> {
    try {
      const { stdout } = await runGit(projectPath, ["rev-list", "--count", `${from}..${to}`])
      return parseInt(stdout, 10) || 0
    } catch {
      return 0
    }
  }

  /** Diffstat of start..end: `-M` rename detection, `-z` machine-safe parse.
   *  name-status drives entry arity/order; numstat is consumed positionally
   *  against it (both list the same files in the same order for one command).
   *  files capped at `cap` → truncated flag (aggregate sums stay honest up
   *  to the cap). Binary pairs come as "-\t-" → binary:true, 0/0. */
  async diffStat(
    projectPath: string,
    from: string,
    to: string,
    cap = 3000,
  ): Promise<{ files: DiffFileEntry[]; truncated: boolean }> {
    const { stdout: nsOut } = await runGit(
      projectPath, ["diff", "-M", "--name-status", "-z", from, to],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    const { stdout: numOut } = await runGit(
      projectPath, ["diff", "-M", "--numstat", "-z", from, to],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    // name-status -z: STATUS\0path | Rxxx\0old\0new | Cxxx\0old\0new (NUL-terminated triples)
    const nsTok = nsOut.split("\0").filter((t) => t.length > 0)
    const entries: { status: string; path: string; oldPath?: string }[] = []
    for (let i = 0; i < nsTok.length; i++) {
      const status = nsTok[i]!
      const code = status[0]!
      if (code === "R" || code === "C") {
        const oldPath = nsTok[i + 1]!
        const path = nsTok[i + 2]!
        entries.push({ status: code, path, oldPath })
        i += 2
      } else {
        entries.push({ status: code, path: nsTok[i + 1]! })
        i += 1
      }
    }
    // numstat -z record shapes (columns are TAB-separated; only the PATH ends
    // at NUL): normal → "<adds>\t<dels>\t<path>"; rename/copy →
    // "<adds>\t<dels>\t" then two more NUL-terminated tokens old/new (the lone
    // tab of the empty path field survives the empty-filter — arity is driven
    // by name-status, which stays authoritative for paths/order).
    const numTok = numOut.split("\0").filter((t) => t.length > 0)
    const files: DiffFileEntry[] = []
    let truncated = false
    let ti = 0
    for (const e of entries) {
      if (ti >= numTok.length) break // malformed tail (concurrent repo change) — stop, keep what we have
      const rec = numTok[ti++]!
      const first = rec.indexOf("\t")
      const addsRaw = first < 0 ? rec : rec.slice(0, first)
      const rest = first < 0 ? "" : rec.slice(first + 1)
      const second = rest.indexOf("\t")
      const delsRaw = second < 0 ? rest : rest.slice(0, second)
      if (e.oldPath != null) ti += 2 // skip the ""/old/new path tokens (paths from name-status)
      if (files.length >= cap) { truncated = true; continue } // keep draining to stay token-synced
      const binary = addsRaw === "-" || delsRaw === "-"
      files.push({
        path: e.path,
        ...(e.oldPath != null ? { oldPath: e.oldPath } : {}),
        status: e.status,
        adds: binary ? 0 : parseInt(addsRaw, 10) || 0,
        dels: binary ? 0 : parseInt(delsRaw, 10) || 0,
        ...(binary ? { binary: true } : {}),
      })
    }
    if (entries.length > cap) truncated = true
    return { files, truncated }
  }

  /** Unified patch for ONE file across start..end (lazy, on click).
   *  :(literal) pathspec → glob chars in real filenames match literally. */
  async diffPatchFor(
    projectPath: string,
    from: string,
    to: string,
    filePath: string,
  ): Promise<{ patch: string; truncated: boolean }> {
    const { stdout } = await runGit(
      projectPath, ["diff", "-M", "-U3", from, to, "--", `:(literal)${filePath}`],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    if (stdout.length > GIT_PATCH_CHAR_CAP) {
      return { patch: stdout.slice(0, GIT_PATCH_CHAR_CAP), truncated: true }
    }
    return { patch: stdout, truncated: false }
  }
}

/** One row of a range-diff stat (验货台 实物 tab). */
export interface DiffFileEntry {
  path: string
  /** rename/copy source (status R/C). */
  oldPath?: string
  /** single-letter git status code: A M D R C T. */
  status: string
  adds: number
  dels: number
  binary?: boolean
}

export const gitOps = new GitOps()