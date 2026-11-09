import { execFile } from "child_process"
import { promisify } from "util"
import { readdirSync, existsSync, statSync, mkdirSync } from "fs"
import { readFile, stat } from "fs/promises"
import { join, dirname } from "path"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 1024 * 1024
/** Diff-family buffer (验货台 round-diff): numstat of a huge branch diff and a
 *  single-file patch both blow past the 1MB default; the READ ceiling for
 *  patches is still enforced at 512K chars above that (truncated flag). */
export const GIT_DIFF_MAX_BUFFER = 16 * 1024 * 1024
export const GIT_PATCH_CHAR_CAP = 512_000
/** 未跟踪文件的行数统计上限（live 变更面每拍读一次）—— 超过即按二进制记，
 *  不把大文件读进内存。 */
const UNTRACKED_STAT_MAX_BYTES = 4 * 1024 * 1024
/** 二进制启发式窗口：与 git 相同（前 8KB 内有 NUL 即视为二进制）。 */
const BINARY_SNIFF_BYTES = 8000

/**
 * 票01/票09 提交标记单源（taskboard-modal-v2, ADR-0025）—— 快改留痕的 subject
 * 前缀词。写侧 task-doer-service（对话回合落 commit）与读侧 {@link
 * GitOps.quickEditCommits}（台账「快速修改」列统计）共用这两枚：
 *   - QUICK_EDIT_MARKER   = 待验收/ready 的快速修改轮（票01 契约字符串，逐字
 *     不变 —— 票10 E2E 在飞断言认它）。
 *   - TAKEOVER_EDIT_MARKER = 人工接管回合（executions.takeover_at 已停未交付）
 *     的编辑。接管留痕的台账权威是 executions.takeover_*（票08/票09 三本账
 *     三源不互抄），若接管件也盖 [quick-edit] 就会被「快速修改」列双计 ——
 *     所以接管回合换盖这枚，快改列的默认前缀天然把它挡在外面。
 */
export const QUICK_EDIT_MARKER = "[quick-edit]"
export const TAKEOVER_EDIT_MARKER = "[takeover-edit]"
/** commit subject 前缀 = 标记 + 空格（读侧默认判据）。 */
export const QUICK_EDIT_SUBJECT_PREFIX = `${QUICK_EDIT_MARKER} `

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

/** runGit that treats the given exit codes as success. `git diff --no-index`
 *  exits 1 when the two paths differ — for an untracked-file patch that IS the
 *  success case (there is no "no differences" outcome we care about). */
async function runGitAllowingExit(
  projectPath: string,
  args: string[],
  okCodes: number[],
  maxBufferBytes = GIT_MAX_BUFFER,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: projectPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: maxBufferBytes,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error: unknown) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string }
    if (typeof e.code === "number" && okCodes.includes(e.code)) {
      return { stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() }
    }
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

  /** Commit subjects in (from..to] — capped, newest first. Used by the
   *  post-acceptance delta section (2026-10-31). */
  async logSubjects(projectPath: string, from: string, to: string, cap = 20): Promise<string[]> {
    try {
      const { stdout } = await runGit(projectPath, ["log", "--format=%s", `${from}..${to}`])
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, cap)
    } catch {
      return []
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
    return parseDiffStatOutputs(nsOut, numOut, cap)
  }

  /** Same shape as {@link diffStat}, but the right-hand side is the CURRENT
   *  WORKING TREE (index + unstaged edits) instead of a commit. Live 轮「≡ 变更」
   *  用它：agent 改完文件还没 commit 时，改动就已经可见（提交后同一净额，
   *  不双计）。未跟踪文件不在 `git diff` 里 —— 调用方另用
   *  {@link listUntracked} + {@link statUntracked} 合并。 */
  async diffStatWorktree(
    projectPath: string,
    from: string,
    cap = 3000,
  ): Promise<{ files: DiffFileEntry[]; truncated: boolean }> {
    const { stdout: nsOut } = await runGit(
      projectPath, ["diff", "-M", "--name-status", "-z", from],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    const { stdout: numOut } = await runGit(
      projectPath, ["diff", "-M", "--numstat", "-z", from],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    return parseDiffStatOutputs(nsOut, numOut, cap)
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

  /** Unified patch for ONE file: commit `from` → CURRENT WORKING TREE (same
   *  comparison {@link diffStatWorktree} summarises). */
  async diffPatchForWorktree(
    projectPath: string,
    from: string,
    filePath: string,
  ): Promise<{ patch: string; truncated: boolean }> {
    const { stdout } = await runGit(
      projectPath, ["diff", "-M", "-U3", from, "--", `:(literal)${filePath}`],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    if (stdout.length > GIT_PATCH_CHAR_CAP) {
      return { patch: stdout.slice(0, GIT_PATCH_CHAR_CAP), truncated: true }
    }
    return { patch: stdout, truncated: false }
  }

  /** Untracked files (new files git has never seen), .gitignore respected.
   *  `git diff` never includes these — the live 变更面 merges them itself. */
  async listUntracked(projectPath: string): Promise<string[]> {
    const { stdout } = await runGit(
      projectPath, ["ls-files", "-z", "--others", "--exclude-standard"],
      GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
    )
    return stdout.split("\0").filter((p) => p.length > 0)
  }

  /** Stat one untracked file as an "A" entry: lines counted like numstat,
   *  binary sniff on the first 8KB, files over the size cap reported binary so
   *  a huge blob is never read on every poll. Unreadable → name only (0/0). */
  async statUntracked(projectPath: string, relPath: string): Promise<DiffFileEntry> {
    const base: DiffFileEntry = { path: relPath, status: "A", adds: 0, dels: 0 }
    try {
      const abs = join(projectPath, relPath)
      const st = await stat(abs)
      if (!st.isFile()) return base
      if (st.size > UNTRACKED_STAT_MAX_BYTES) return { ...base, binary: true }
      const buf = await readFile(abs)
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...base, binary: true }
      return { ...base, adds: countTextLines(buf.toString("utf-8")) }
    } catch {
      return base
    }
  }

  /** Patch for an UNTRACKED file = /dev/null → path. `git diff --no-index`
   *  exits 1 whenever the contents differ, which is the only outcome here. */
  async diffPatchForUntracked(
    projectPath: string,
    filePath: string,
  ): Promise<{ patch: string; truncated: boolean }> {
    const { stdout } = await runGitAllowingExit(
      projectPath,
      ["diff", "--no-index", "--no-color", "-U3", "--", "/dev/null", filePath],
      [1],
      GIT_DIFF_MAX_BUFFER,
    )
    if (stdout.length > GIT_PATCH_CHAR_CAP) {
      return { patch: stdout.slice(0, GIT_PATCH_CHAR_CAP), truncated: true }
    }
    return { patch: stdout, truncated: false }
  }

  /** commits in (from..to] whose subject starts with `prefix` (default the
   *  quick-edit marker 「[quick-edit] 」, 票01 契约), newest-first within the
   *  range, each with its touched files. 票09 台账「快速修改」列的权威统计源 ——
   *  读的是提交标记本身（subject/trailer），与前端会话尾帧计数不互抄。
   *
   *  单趟 `git log --name-only`：record = `%x1e`(记录界) + `%H`(field1) + `%s`
   *  (field2，单行 subject，控制字符安全)。record 之后的非空行即该提交的文件；
   *  git 在 header 与文件名之间、提交与提交之间都插空行，解析时按空行分块。
   *  坏仓/不可达 SHA → runGit 抛 → 这里吞成 []（best-effort，台账绝不因一次
   *  git 抖动 500，与实物区间 statRepo 的诚实降级同律）。 */
  async quickEditCommits(
    projectPath: string,
    from: string,
    to: string,
    prefix = QUICK_EDIT_SUBJECT_PREFIX,
  ): Promise<Array<{ sha: string; subject: string; files: string[] }>> {
    if (!from || !to || from === to) return []
    let stdout: string
    try {
      const r = await runGit(
        projectPath,
        ["log", "--no-merges", "--name-only", "--format=%x1e%H\x1f%s", `${from}..${to}`],
        GIT_TIMEOUT_MS, GIT_DIFF_MAX_BUFFER,
      )
      stdout = r.stdout
    } catch {
      return []
    }
    const out: Array<{ sha: string; subject: string; files: string[] }> = []
    for (const chunk of stdout.split("\x1e")) {
      const lines = chunk.split("\n")
      const header = lines.shift() // 记录首行 "<sha>\x1f<subject>"（首块 split 后为 "" → 跳过）
      if (!header || !header.includes("\x1f")) continue
      const sep = header.indexOf("\x1f")
      const sha = header.slice(0, sep)
      const subject = header.slice(sep + 1)
      if (!subject.startsWith(prefix)) continue
      const files = lines.map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0)
      out.push({ sha, subject, files })
    }
    return out
  }
}

/** Shared parse for a `--name-status -z` + `--numstat -z` pair (range diff and
 *  worktree diff produce the same shapes). */
function parseDiffStatOutputs(
  nsOut: string,
  numOut: string,
  cap: number,
): { files: DiffFileEntry[]; truncated: boolean } {
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

/** Line count as `git diff --numstat` would report it for an "A" entry. */
function countTextLines(text: string): number {
  if (text.length === 0) return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++
  return text.endsWith("\n") ? newlines : newlines + 1
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