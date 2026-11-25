import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { WorkspaceGit } from "../services/workspace-git"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import os from "os"

// Ticket 08 — source_path fix: resolveRepoPath + initWorktreesFromSpec.
// Seam under test: WorkspaceGit public methods. We observe behavior through the
// filesystem (worktree dir + config.json) and through thrown errors, never internals.

const ORG = "testorg"
const GROUP = "testgroup"
const REPO_NAME = "demo-repo"

let git: WorkspaceGit
let realHome: string | undefined
let realUserProfile: string | undefined
let fakeHome: string
let repoDir: string
let wsDir: string

function writeIndex(content: string): void {
  const reposDir = join(fakeHome, ".octopus", "orgs", ORG, "repos")
  mkdirSync(reposDir, { recursive: true })
  writeFileSync(join(reposDir, "index.md"), content)
}

function initSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ws-git-repo-"))
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), "# demo")
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
  return dir
}

beforeEach(() => {
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = mkdtempSync(join(tmpdir(), "ws-git-home-"))
  // Fake both: os.homedir() reads $HOME on POSIX, %USERPROFILE% on Windows.
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome

  repoDir = initSourceRepo()
  writeIndex(
    `# GitRepo Index\n\n## ${GROUP} (${ORG})\n\n### ${REPO_NAME}\n- git: git@example.com:test/${REPO_NAME}.git\n- local: ${repoDir} ✓ cloned\n`,
  )

  wsDir = mkdtempSync(join(tmpdir(), "ws-git-ws-"))
  mkdirSync(join(wsDir, "projects"), { recursive: true })
  writeFileSync(join(wsDir, "config.json"), JSON.stringify({ name: "test-ws", repo_group: ORG }, null, 2))

  git = new WorkspaceGit()
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  for (const d of [fakeHome, repoDir, wsDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
})

describe("WorkspaceGit.resolveRepoPath", () => {
  it("returns the local path when the repo exists in index.md (group-scoped)", () => {
    const resolved = git.resolveRepoPath(ORG, REPO_NAME, GROUP)
    expect(resolved).toBe(repoDir)
  })

  it("resolves without group scoping when group is empty", () => {
    const resolved = git.resolveRepoPath(ORG, REPO_NAME, "")
    expect(resolved).toBe(repoDir)
  })

  it("throws a clear error when index.md is missing for the org", () => {
    rmSync(join(fakeHome, ".octopus", "orgs", ORG, "repos", "index.md"))
    expect(() => git.resolveRepoPath(ORG, REPO_NAME, GROUP)).toThrow(/index\.md not found/)
  })

  it("throws when the repo name is not present in index.md", () => {
    expect(() => git.resolveRepoPath(ORG, "no-such-repo", GROUP)).toThrow(/not found/)
  })

  it("throws when the group section is not present in index.md", () => {
    expect(() => git.resolveRepoPath(ORG, REPO_NAME, "missing-group")).toThrow(/group.*not found/)
  })

  it("throws when the local path does not exist or has no .git", () => {
    writeIndex(
      `# GitRepo Index\n\n## ${GROUP} (${ORG})\n\n### ${REPO_NAME}\n- local: /nonexistent/path/repo ✓ cloned\n`,
    )
    expect(() => git.resolveRepoPath(ORG, REPO_NAME, GROUP)).toThrow(/unreachable/)
  })
})

describe("WorkspaceGit.initWorktreesFromSpec (source_path resolution)", () => {
  it("creates a worktree when source_path is empty and index.md resolves the repo", () => {
    git.initWorktreesFromSpec(
      wsDir,
      [{ name: REPO_NAME, source_path: "", group: GROUP }],
      "taskpool-s1",
      "suffix1",
      "test-ws",
      ORG,
    )

    const wtDir = join(wsDir, "projects", REPO_NAME)
    expect(existsSync(wtDir)).toBe(true)
    expect(existsSync(join(wtDir, ".git"))).toBe(true)

    const config = JSON.parse(readFileSync(join(wsDir, "config.json"), "utf-8"))
    expect(config.repos).toHaveLength(1)
    expect(config.repos[0].name).toBe(REPO_NAME)
    expect(config.repos[0].main_path).toBe(repoDir)
    expect(config.repos[0].branch).toBe("taskpool-s1-suffix1")
  })

  it("uses explicit source_path directly when provided (no index.md lookup)", () => {
    git.initWorktreesFromSpec(
      wsDir,
      [{ name: REPO_NAME, source_path: repoDir, group: "" }],
      "taskpool-s2",
      "suffix2",
      "test-ws",
      ORG,
    )
    const wtDir = join(wsDir, "projects", REPO_NAME)
    expect(existsSync(wtDir)).toBe(true)
    expect(existsSync(join(wtDir, ".git"))).toBe(true)
  })

  it("throws when source_path is empty and the repo is not resolvable (no silent skip)", () => {
    expect(() =>
      git.initWorktreesFromSpec(
        wsDir,
        [{ name: "no-such-repo", source_path: "", group: GROUP }],
        "taskpool-s3",
        "suffix3",
        "test-ws",
        ORG,
      ),
    ).toThrow(/not found/)
  })

  it("throws when source_path is empty and index.md is missing entirely", () => {
    rmSync(join(fakeHome, ".octopus", "orgs", ORG, "repos", "index.md"))
    expect(() =>
      git.initWorktreesFromSpec(
        wsDir,
        [{ name: REPO_NAME, source_path: "", group: GROUP }],
        "taskpool-s4",
        "suffix4",
        "test-ws",
        ORG,
      ),
    ).toThrow(/index\.md not found/)
  })
})

// 分支计划（2026-11-24）：worktree 的 fork 点显式化 —— 不再取主仓当时的 HEAD
// （clean-main 主仓恒在默认分支，会把舱绑定分支的意图吃掉）。
describe("WorkspaceGit.initWorktreesFromSpec — 分支计划 base/target", () => {
  function addFeatCommit(): string {
    execFileSync("git", ["checkout", "-b", "feat/long-lived"], { cwd: repoDir })
    writeFileSync(join(repoDir, "feat.txt"), "feat work")
    execFileSync("git", ["add", "-A"], { cwd: repoDir })
    execFileSync("git", ["commit", "-m", "feat work"], { cwd: repoDir })
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()
    // 主仓回到默认分支 —— 模拟 clean-main 镜像后的状态。
    execFileSync("git", ["checkout", "-"], { cwd: repoDir })
    return sha
  }

  function readRepoEntry(): Record<string, string> {
    const config = JSON.parse(readFileSync(join(wsDir, "config.json"), "utf-8")) as {
      repos: Array<Record<string, string>>
    }
    return config.repos[0]
  }

  it("按 base 建树：worktree HEAD = base 分支提交，config 落 base/target", () => {
    const featSha = addFeatCommit()
    git.initWorktreesFromSpec(
      wsDir,
      [{ name: REPO_NAME, source_path: repoDir, group: "" }],
      "taskpool-b1",
      "s1",
      "test-ws",
      ORG,
      { [REPO_NAME]: { base: "feat/long-lived", target: "feat/long-lived" } },
    )

    const wtDir = join(wsDir, "projects", REPO_NAME)
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf-8" }).trim()
    expect(head).toBe(featSha)
    expect(existsSync(join(wtDir, "feat.txt"))).toBe(true)

    const entry = readRepoEntry()
    expect(entry.base_branch).toBe("feat/long-lived")
    expect(entry.target_branch).toBe("feat/long-lived")
    expect(entry.branch).toBe("taskpool-b1-s1")
  })

  it("base 与 target 允许不同，原样落盘", () => {
    addFeatCommit()
    git.initWorktreesFromSpec(
      wsDir,
      [{ name: REPO_NAME, source_path: repoDir, group: "" }],
      "taskpool-b2",
      "s2",
      "test-ws",
      ORG,
      { [REPO_NAME]: { base: "feat/long-lived", target: "master" } },
    )
    const entry = readRepoEntry()
    expect(entry.base_branch).toBe("feat/long-lived")
    expect(entry.target_branch).toBe("master")
  })

  it("base 不存在 → 硬失败（绝不静默回退默认分支）", () => {
    expect(() =>
      git.initWorktreesFromSpec(
        wsDir,
        [{ name: REPO_NAME, source_path: repoDir, group: "" }],
        "taskpool-b3",
        "s3",
        "test-ws",
        ORG,
        { [REPO_NAME]: { base: "feat/missing" } },
      ),
    ).toThrow(/base branch 'feat\/missing' not found/)
  })

  it("无计划 → 从仓库默认分支建树，target 跟随 base", () => {
    const defaultBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repoDir, encoding: "utf-8",
    }).trim()
    git.initWorktreesFromSpec(
      wsDir,
      [{ name: REPO_NAME, source_path: repoDir, group: "" }],
      "taskpool-b4",
      "s4",
      "test-ws",
      ORG,
    )
    const entry = readRepoEntry()
    expect(entry.base_branch).toBe(defaultBranch)
    expect(entry.target_branch).toBe(defaultBranch)
  })
})
