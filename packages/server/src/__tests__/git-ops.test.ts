import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { GitOps } from "../services/git-ops"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
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
})