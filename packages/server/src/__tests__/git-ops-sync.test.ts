import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { execSync } from "child_process"
import { GitOps } from "../services/git-ops"

let workspacePath: string
let gitOps: GitOps

const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" })

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-git-ops-sync-${Date.now()}`)
  fs.mkdirSync(workspacePath, { recursive: true })
  gitOps = new GitOps()
})

afterEach(() => {
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * Set up a bare "remote" repo + a clone (the "project"). This mirrors how
 * git workspaces work: the project has an origin remote that points to
 * a bare repo we control.
 */
function setupRemoteAndClone(projectName: string): { projectPath: string; remotePath: string } {
  const remotePath = path.join(workspacePath, "_remote", `${projectName}.git`)
  fs.mkdirSync(remotePath, { recursive: true })
  run("git init --bare -q", remotePath)

  const projectPath = path.join(workspacePath, "projects", projectName)
  fs.mkdirSync(path.dirname(projectPath), { recursive: true })
  run(`git clone -q ${remotePath} ${projectPath}`, workspacePath)
  run("git config user.email test@test.com", projectPath)
  run("git config user.name Test", projectPath)

  // Seed initial commit on main
  fs.writeFileSync(path.join(projectPath, "README.md"), "# " + projectName)
  run("git add -A && git commit -q -m 'initial commit'", projectPath)
  run("git push -q origin HEAD", projectPath)

  return { projectPath, remotePath }
}

describe("GitOps.detectDefaultBranch", () => {
  it("returns 'main' when origin/main exists", async () => {
    const { projectPath } = setupRemoteAndClone("proj-main")
    const result = await gitOps.detectDefaultBranch(projectPath)
    expect(result).toBe("main")
  })

  it("returns 'master' when origin/master exists but not main", async () => {
    const remotePath = path.join(workspacePath, "_remote", "proj-master.git")
    fs.mkdirSync(remotePath, { recursive: true })
    run("git init --bare -q", remotePath)

    const projectPath = path.join(workspacePath, "projects", "proj-master")
    fs.mkdirSync(path.dirname(projectPath), { recursive: true })
    run(`git clone -q ${remotePath} ${projectPath}`, workspacePath)
    run("git config user.email test@test.com", projectPath)
    run("git config user.name Test", projectPath)
    // Rename branch to master
    run("git checkout -b master", projectPath)
    fs.writeFileSync(path.join(projectPath, "README.md"), "# proj-master")
    run("git add -A && git commit -q -m 'initial commit'", projectPath)
    run("git push -q origin master", projectPath)

    const result = await gitOps.detectDefaultBranch(projectPath)
    expect(result).toBe("master")
  })

  it("returns null when neither main nor master exists", async () => {
    const remotePath = path.join(workspacePath, "_remote", "proj-none.git")
    fs.mkdirSync(remotePath, { recursive: true })
    run("git init --bare -q", remotePath)

    const projectPath = path.join(workspacePath, "projects", "proj-none")
    fs.mkdirSync(path.dirname(projectPath), { recursive: true })
    run(`git clone -q ${remotePath} ${projectPath}`, workspacePath)
    run("git config user.email test@test.com", projectPath)
    run("git config user.name Test", projectPath)
    run("git checkout -b feature", projectPath)
    fs.writeFileSync(path.join(projectPath, "README.md"), "# feature")
    run("git add -A && git commit -q -m 'initial'", projectPath)
    run("git push -q origin feature", projectPath)

    const result = await gitOps.detectDefaultBranch(projectPath)
    expect(result).toBe(null)
  })
})

describe("GitOps.syncProjectToMain", () => {
  it("clean + ff merge succeeds on main", async () => {
    const { projectPath, remotePath } = setupRemoteAndClone("proj-clean")

    // Push an update to remote (simulate another dev pushing)
    const otherClone = path.join(workspacePath, "_other-clone")
    fs.mkdirSync(otherClone, { recursive: true })
    run(`git clone -q ${remotePath} ${otherClone}/proj`, workspacePath)
    run("git config user.email other@test.com", `${otherClone}/proj`)
    run("git config user.name Other", `${otherClone}/proj`)
    fs.writeFileSync(path.join(otherClone, "proj", "new-file.txt"), "hello")
    run("git add -A && git commit -q -m 'remote update'", `${otherClone}/proj`)
    run("git push -q origin HEAD", `${otherClone}/proj`)

    const result = await gitOps.syncProjectToMain(projectPath, "proj-clean")
    expect(result.status).toBe("success")
    expect(result.branch).toBe("main")
    // Verify the new file appeared
    expect(fs.existsSync(path.join(projectPath, "new-file.txt"))).toBe(true)
  })

  it("dirty worktree → auto-commit → merge", async () => {
    const { projectPath } = setupRemoteAndClone("proj-dirty")

    // Make dirty
    fs.writeFileSync(path.join(projectPath, "local.txt"), "local change")

    const result = await gitOps.syncProjectToMain(projectPath, "proj-dirty")
    expect(result.status).toBe("success")

    // Verify auto-commit message exists in log
    const log = run("git log --oneline", projectPath).toString()
    expect(log).toContain("[octopus] auto-commit before sync")
  })

  it("diverge → merge abort + warning", async () => {
    const { projectPath, remotePath } = setupRemoteAndClone("proj-diverge")

    // Make local commit that diverges from remote
    fs.writeFileSync(path.join(projectPath, "local.txt"), "local")
    run("git add -A && git commit -q -m 'local diverge'", projectPath)

    // Push different commit to remote on same file
    const otherClone = path.join(workspacePath, "_other-clone2")
    fs.mkdirSync(otherClone, { recursive: true })
    run(`git clone -q ${remotePath} ${otherClone}/proj`, workspacePath)
    run("git config user.email other@test.com", `${otherClone}/proj`)
    run("git config user.name Other", `${otherClone}/proj`)
    fs.writeFileSync(path.join(otherClone, "proj", "local.txt"), "remote")
    run("git add -A && git commit -q -m 'remote diverge'", `${otherClone}/proj`)
    run("git push -q origin HEAD", `${otherClone}/proj`)

    const headBefore = run("git rev-parse HEAD", projectPath).toString().trim()
    const result = await gitOps.syncProjectToMain(projectPath, "proj-diverge")
    const headAfter = run("git rev-parse HEAD", projectPath).toString().trim()

    expect(result.status).toBe("warning")
    expect(result.reason).toContain("merge failed")
    expect(result.reason).toContain("aborted")
    // HEAD should be unchanged after abort
    expect(headBefore).toBe(headAfter)
  })

  it("feature branch → fetch only (HEAD stays)", async () => {
    const { projectPath } = setupRemoteAndClone("proj-feat")
    run("git checkout -b feature/test", projectPath)

    const branchBefore = await gitOps.getCurrentBranch(projectPath)
    expect(branchBefore).toBe("feature/test")

    const result = await gitOps.syncProjectToMain(projectPath, "proj-feat")
    expect(result.status).toBe("info")
    expect(result.branch).toBe("feature/test")

    const branchAfter = await gitOps.getCurrentBranch(projectPath)
    expect(branchAfter).toBe("feature/test")
  })

  it("detached HEAD → skip", async () => {
    const { projectPath } = setupRemoteAndClone("proj-detach")
    run("git checkout --detach", projectPath)

    const result = await gitOps.syncProjectToMain(projectPath, "proj-detach")
    expect(result.status).toBe("skipped")
    expect(result.reason).toContain("detached")
  })

  it("no remote main/master → skip", async () => {
    const remotePath = path.join(workspacePath, "_remote", "proj-nomain.git")
    fs.mkdirSync(remotePath, { recursive: true })
    run("git init --bare -q", remotePath)

    const projectPath = path.join(workspacePath, "projects", "proj-nomain")
    fs.mkdirSync(path.dirname(projectPath), { recursive: true })
    run(`git clone -q ${remotePath} ${projectPath}`, workspacePath)
    run("git config user.email test@test.com", projectPath)
    run("git config user.name Test", projectPath)
    run("git checkout -b develop", projectPath)
    fs.writeFileSync(path.join(projectPath, "README.md"), "# dev")
    run("git add -A && git commit -q -m 'initial'", projectPath)
    run("git push -q origin develop", projectPath)

    const result = await gitOps.syncProjectToMain(projectPath, "proj-nomain")
    expect(result.status).toBe("skipped")
    expect(result.reason).toContain("no main/master")
  })
})
