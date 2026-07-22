import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { execSync } from "child_process"
import { EngineInitPhase, ENGINE_INIT_JSONL } from "../services/execution/EngineInitPhase"
import { SSEService } from "../services/sse"

const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" })

let workspacePath: string
let sse: SSEService
let receivedEvents: { event: string; data: unknown }[]

beforeEach(() => {
  workspacePath = path.join(os.tmpdir(), `test-engine-init-sync-${Date.now()}`)
  fs.mkdirSync(workspacePath, { recursive: true })
  sse = new SSEService()
  receivedEvents = []
  sse.subscribe("test:test-ws", (event) => { receivedEvents.push(event) })
})

afterEach(() => {
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function setupRemoteAndClone(projectName: string): string {
  const remotePath = path.join(workspacePath, "_remote", `${projectName}.git`)
  fs.mkdirSync(remotePath, { recursive: true })
  run("git init --bare -q", remotePath)

  const projectPath = path.join(workspacePath, "projects", projectName)
  fs.mkdirSync(path.dirname(projectPath), { recursive: true })
  run(`git clone -q ${remotePath} ${projectPath}`, workspacePath)
  run("git config user.email test@test.com", projectPath)
  run("git config user.name Test", projectPath)

  fs.writeFileSync(path.join(projectPath, "README.md"), "# " + projectName)
  run("git add -A && git commit -q -m 'initial commit'", projectPath)
  run("git push -q origin HEAD", projectPath)

  return projectPath
}

describe("EngineInitPhase git sync", () => {
  it("syncMainBranch=true syncs project and emits engine_init_pull", async () => {
    const projectPath = setupRemoteAndClone("proj-sync")

    // Push an update to remote
    const otherClone = path.join(workspacePath, "_other-clone")
    fs.mkdirSync(otherClone, { recursive: true })
    const remotePath = path.join(workspacePath, "_remote", "proj-sync.git")
    run(`git clone -q ${remotePath} ${otherClone}/proj`, workspacePath)
    run("git config user.email other@test.com", `${otherClone}/proj`)
    run("git config user.name Other", `${otherClone}/proj`)
    fs.writeFileSync(path.join(otherClone, "proj", "new.txt"), "from remote")
    run("git add -A && git commit -q -m 'remote update'", `${otherClone}/proj`)
    run("git push -q origin HEAD", `${otherClone}/proj`)

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-sync-1",
      syncMainBranch: true,
      sse,
      skillsSourceOverride: null,
    })

    const pullEvents = receivedEvents.filter(e => e.event === "engine_init_pull")
    expect(pullEvents.length).toBe(1)
    expect((pullEvents[0].data as any).projectName).toBe("proj-sync")
    expect((pullEvents[0].data as any).status).toBe("success")

    // Verify the file was synced
    expect(fs.existsSync(path.join(projectPath, "new.txt"))).toBe(true)

    // Verify JSONL includes the pull event
    const jsonlPath = path.join(workspacePath, "logs", "exec-sync-1", ENGINE_INIT_JSONL)
    const content = fs.readFileSync(jsonlPath, "utf-8")
    expect(content).toContain("engine_init_pull")
    expect(content).toContain("proj-sync")
  })

  it("syncMainBranch=false skips git sync entirely", async () => {
    setupRemoteAndClone("proj-nosync")

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-nosync-1",
      syncMainBranch: false,
      sse,
      skillsSourceOverride: null,
    })

    const pullEvents = receivedEvents.filter(e =>
      e.event === "engine_init_pull" ||
      e.event === "engine_init_info" ||
      e.event === "engine_init_warning"
    )
    expect(pullEvents.length).toBe(0)
  })

  it("dirty worktree triggers auto-commit + merge, emits engine_init_pull", async () => {
    const projectPath = setupRemoteAndClone("proj-dirty")

    // Make dirty
    fs.writeFileSync(path.join(projectPath, "local-change.txt"), "dirty")

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-dirty-1",
      syncMainBranch: true,
      sse,
      skillsSourceOverride: null,
    })

    const pullEvents = receivedEvents.filter(e => e.event === "engine_init_pull")
    expect(pullEvents.length).toBe(1)

    // Verify auto-commit message in git log
    const log = run("git log --oneline", projectPath).toString()
    expect(log).toContain("[octopus] auto-commit before sync")
  })

  it("feature branch emits engine_init_info (not engine_init_pull)", async () => {
    const projectPath = setupRemoteAndClone("proj-feat")
    run("git checkout -b feature/test", projectPath)

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-feat-1",
      syncMainBranch: true,
      sse,
      skillsSourceOverride: null,
    })

    const infoEvents = receivedEvents.filter(e => e.event === "engine_init_info")
    expect(infoEvents.length).toBe(1)
    expect((infoEvents[0].data as any).branch).toBe("feature/test")

    // HEAD should still be on feature branch
    const branch = run("git rev-parse --abbrev-ref HEAD", projectPath).toString().trim()
    expect(branch).toBe("feature/test")
  })

  it("detached HEAD emits engine_init_warning", async () => {
    const projectPath = setupRemoteAndClone("proj-detach")
    run("git checkout --detach", projectPath)

    const phase = new EngineInitPhase()
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-detach-1",
      syncMainBranch: true,
      sse,
      skillsSourceOverride: null,
    })

    const warnings = receivedEvents.filter(e => e.event === "engine_init_warning")
    const detachWarning = warnings.find((e: any) => e.data?.errorMessage?.includes("detached"))
    expect(detachWarning).toBeDefined()
  })

  it("diverge → merge abort, emits engine_init_warning, does not block execution", async () => {
    const projectPath = setupRemoteAndClone("proj-diverge")
    const remotePath = path.join(workspacePath, "_remote", "proj-diverge.git")

    // Make local diverging commit
    fs.writeFileSync(path.join(projectPath, "conflict.txt"), "local")
    run("git add -A && git commit -q -m 'local diverge'", projectPath)

    // Push different commit on same file
    const otherClone = path.join(workspacePath, "_other-clone")
    fs.mkdirSync(otherClone, { recursive: true })
    run(`git clone -q ${remotePath} ${otherClone}/proj`, workspacePath)
    run("git config user.email other@test.com", `${otherClone}/proj`)
    run("git config user.name Other", `${otherClone}/proj`)
    fs.writeFileSync(path.join(otherClone, "proj", "conflict.txt"), "remote")
    run("git add -A && git commit -q -m 'remote diverge'", `${otherClone}/proj`)
    run("git push -q origin HEAD", `${otherClone}/proj`)

    const headBefore = run("git rev-parse HEAD", projectPath).toString().trim()

    const phase = new EngineInitPhase()
    // Should NOT throw even though merge fails
    await phase.run({
      workspacePath,
      workspaceId: "test:test-ws",
      executionId: "exec-diverge-1",
      syncMainBranch: true,
      sse,
      skillsSourceOverride: null,
    })

    const headAfter = run("git rev-parse HEAD", projectPath).toString().trim()
    expect(headBefore).toBe(headAfter)

    const warnings = receivedEvents.filter(e => e.event === "engine_init_warning")
    const divergeWarning = warnings.find((e: any) => e.data?.errorMessage?.includes("merge failed"))
    expect(divergeWarning).toBeDefined()

    // engine_init_complete must still have been emitted
    const complete = receivedEvents.find(e => e.event === "engine_init_complete")
    expect(complete).toBeDefined()
  })
})
