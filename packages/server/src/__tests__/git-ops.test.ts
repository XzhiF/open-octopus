import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { GitOps } from "../services/git-ops"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let gitOps: GitOps
let testDir: string

beforeEach(() => {
  gitOps = new GitOps()
  testDir = mkdtempSync(join(tmpdir(), "git-ops-test-"))
  execFileSync("git", ["init"], { cwd: testDir })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: testDir })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir })
  // 创建初始 commit
  writeFileSync(join(testDir, "README.md"), "# Test")
  execFileSync("git", ["add", "-A"], { cwd: testDir })
  execFileSync("git", ["commit", "-m", "initial"], { cwd: testDir })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe("GitOps", () => {
  it("gets HEAD commit", async () => {
    const commit = await gitOps.getHeadCommit(testDir)
    expect(commit).toMatch(/^[a-f0-9]{40}$/)
  })

  it("detects uncommitted changes", async () => {
    writeFileSync(join(testDir, "new.txt"), "hello")
    const hasChanges = await gitOps.hasUncommittedChanges(testDir)
    expect(hasChanges).toBe(true)
  })

  it("detects no uncommitted changes on clean repo", async () => {
    const hasChanges = await gitOps.hasUncommittedChanges(testDir)
    expect(hasChanges).toBe(false)
  })

  it("auto-commits and returns commit sha", async () => {
    writeFileSync(join(testDir, "new.txt"), "hello")
    const sha = await gitOps.autoCommit(testDir, "test: auto commit")
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    const hasChanges = await gitOps.hasUncommittedChanges(testDir)
    expect(hasChanges).toBe(false)
  })

  it("creates and switches branch", async () => {
    const headBefore = await gitOps.getHeadCommit(testDir)
    await gitOps.createBranch(testDir, "test-branch", headBefore)
    const branch = await gitOps.getCurrentBranch(testDir)
    expect(branch).toBe("test-branch")
  })

  it("resets hard to a commit", async () => {
    const headBefore = await gitOps.getHeadCommit(testDir)
    writeFileSync(join(testDir, "to-reset.txt"), "will be reset")
    await gitOps.autoCommit(testDir, "temp")
    await gitOps.resetHard(testDir, headBefore)
    const headAfter = await gitOps.getHeadCommit(testDir)
    expect(headAfter).toBe(headBefore)
  })

  it("clean force removes untracked files", async () => {
    writeFileSync(join(testDir, "untracked.txt"), "hello")
    await gitOps.cleanForce(testDir)
    const output = execFileSync("git", ["status", "--porcelain"], { cwd: testDir, encoding: "utf8" })
    expect(output.trim()).toBe("")
  })

  it("switches to an existing branch", async () => {
    const headBefore = await gitOps.getHeadCommit(testDir)
    const origBranch = await gitOps.getCurrentBranch(testDir)
    await gitOps.createBranch(testDir, "other-branch", headBefore)
    await gitOps.switchBranch(testDir, origBranch)
    const branch = await gitOps.getCurrentBranch(testDir)
    expect(branch).toBe(origBranch)
  })

  it("executes action on all git projects in workspace", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-test-"))
    const projectsDir = join(workspaceDir, "projects")
    mkdirSync(projectsDir)

    const projA = join(projectsDir, "proj-a")
    mkdirSync(projA)
    execFileSync("git", ["init"], { cwd: projA })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: projA })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projA })
    writeFileSync(join(projA, "README.md"), "# A")
    execFileSync("git", ["add", "-A"], { cwd: projA })
    execFileSync("git", ["commit", "-m", "init a"], { cwd: projA })

    const projB = join(projectsDir, "proj-b")
    mkdirSync(projB)
    execFileSync("git", ["init"], { cwd: projB })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: projB })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projB })
    writeFileSync(join(projB, "README.md"), "# B")
    execFileSync("git", ["add", "-A"], { cwd: projB })
    execFileSync("git", ["commit", "-m", "init b"], { cwd: projB })

    const results = await gitOps.allProjectsAction(workspaceDir,
      async (_, name) => name,
    )
    expect(Object.keys(results).sort()).toEqual(["proj-a", "proj-b"])

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  // ── Regression: task-pool dispatch "0.13s failed" root cause ──────────
  // A scheduler worktree is checked out to its own branch (e.g. taskpool-<id>),
  // while the main working tree of the source repo holds `main`. The execution
  // engine calls switchToExecutionBranch("main") → createOrSwitchBranch("main").
  // `git checkout main` fails with "already checked out at <main-tree>"; the
  // old code treated ANY checkout failure as "branch missing" and fell back to
  // `git checkout -b main` which then fatals with "a branch named 'main' already
  // exists". Result: echo node reports "Git command failed", execution dies in
  // ~124ms. Fix: when the branch exists but can't be checked out because another
  // worktree holds it, keep the current (isolated) branch instead of fataling.
  it("createOrSwitchBranch keeps current branch when target is held by another worktree (no fatal)", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "wt-repo-"))
    try {
      execFileSync("git", ["init"], { cwd: repoDir })
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoDir })
      execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir })
      writeFileSync(join(repoDir, "f.txt"), "1")
      execFileSync("git", ["add", "-A"], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })
      // 主工作树当前占用的分支(默认 main 或 master,取决于 git 配置)
      const heldBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoDir, encoding: "utf8",
      }).trim()

      // 建 worktree 在独立分支 dev,主树仍占 heldBranch
      const wtDir = mkdtempSync(join(tmpdir(), "wt-tree-")) + "-wt"
      rmSync(wtDir, { recursive: true, force: true })
      execFileSync("git", ["worktree", "add", "-b", "dev", wtDir], { cwd: repoDir })

      try {
        // 在 worktree 里切 heldBranch —— 主树已占,git checkout 必 fatal
        const result = await gitOps.createOrSwitchBranch(wtDir, heldBranch)
        expect(result.created).toBe(false)
        // worktree 仍留在自己的隔离分支 dev,没有崩
        const branchAfter = await gitOps.getCurrentBranch(wtDir)
        expect(branchAfter).toBe("dev")
      } finally {
        execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: repoDir })
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })
})
// ── syncToDefaultBranch（镜像同步，draft repo-sync 2026-09-08）────────────
describe("GitOps.syncToDefaultBranch", () => {
  let srcDir: string
  let mirrorDir: string

  /** src=远端替身，mirror=带 origin 的本地 clone；返回两边目录。 */
  function makeOriginPair(defaultBranch = "main") {
    srcDir = mkdtempSync(join(tmpdir(), "git-sync-src-"))
    mirrorDir = mkdtempSync(join(tmpdir(), "git-sync-mirror-"))
    rmSync(mirrorDir, { recursive: true, force: true })
    execFileSync("git", ["init", "-b", defaultBranch], { cwd: srcDir })
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: srcDir })
    execFileSync("git", ["config", "user.name", "T"], { cwd: srcDir })
    writeFileSync(join(srcDir, "a.txt"), "v1")
    execFileSync("git", ["add", "-A"], { cwd: srcDir })
    execFileSync("git", ["commit", "-m", "one"], { cwd: srcDir })
    execFileSync("git", ["clone", srcDir, mirrorDir])
    execFileSync("git", ["remote", "set-head", "origin", "-a"], { cwd: mirrorDir })
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: mirrorDir })
    execFileSync("git", ["config", "user.name", "T"], { cwd: mirrorDir })
  }

  function advanceOrigin(defaultBranch = "main") {
    writeFileSync(join(srcDir, "b.txt"), "v2")
    execFileSync("git", ["add", "-A"], { cwd: srcDir })
    execFileSync("git", ["commit", "-m", "two"], { cwd: srcDir })
    void defaultBranch
  }

  afterEach(() => {
    if (srcDir) rmSync(srcDir, { recursive: true, force: true })
    if (mirrorDir) rmSync(mirrorDir, { recursive: true, force: true })
    srcDir = "" as never
    mirrorDir = "" as never
  })

  it("镜像脏（改动+未跟踪+偏分支）→ 强制对齐 origin/main 最新", async () => {
    makeOriginPair("main")
    advanceOrigin("main")
    // 把镜像搞脏：tracked 改动 + untracked 文件 + 切去野分支
    writeFileSync(join(mirrorDir, "a.txt"), "LOCAL EDIT")
    writeFileSync(join(mirrorDir, "junk.log"), "untracked")
    execFileSync("git", ["checkout", "-b", "stray"], { cwd: mirrorDir })

    const { branch, commit } = await gitOps.syncToDefaultBranch(mirrorDir)
    expect(branch).toBe("main")
    const originMain = execFileSync("git", ["rev-parse", "origin/main"], { cwd: mirrorDir }).toString().trim()
    expect(originMain.startsWith(commit)).toBe(true)
    expect(await gitOps.getCurrentBranch(mirrorDir)).toBe("main")
    expect(await gitOps.hasUncommittedChanges(mirrorDir)).toBe(false)
    // 本地编辑被丢弃、untracked 被清
    expect(readFileSync(join(mirrorDir, "a.txt"), "utf-8")).toBe("v1")
    expect(existsSync(join(mirrorDir, "junk.log"))).toBe(false)
  })

  it("origin/HEAD 符号引用缺失 → 回退探测 main", async () => {
    makeOriginPair("main")
    advanceOrigin("main")
    execFileSync("git", ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], { cwd: mirrorDir })
    const { branch, commit } = await gitOps.syncToDefaultBranch(mirrorDir)
    expect(branch).toBe("main")
    expect(commit).toMatch(/^[a-f0-9]{8}$/)
  })

  it("master 仓库同样成立（探测顺序 main→master）", async () => {
    makeOriginPair("master")
    execFileSync("git", ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], { cwd: mirrorDir })
    const { branch } = await gitOps.syncToDefaultBranch(mirrorDir)
    expect(branch).toBe("master")
  })

  it("origin 无 main/master → 抛错且不动镜像", async () => {
    makeOriginPair("trunk")
    execFileSync("git", ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], { cwd: mirrorDir })
    const headBefore = await gitOps.getHeadCommit(mirrorDir)
    await expect(gitOps.syncToDefaultBranch(mirrorDir)).rejects.toThrow(/无法确定 origin 默认分支/)
    expect(await gitOps.getHeadCommit(mirrorDir)).toBe(headBefore)
  })
})
