import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkspaceService } from "../services/workspace"
import { WorkspaceDAO } from '../db/dao'
import os from "os"
import path from "path"
import fs from "fs"
import { execFileSync } from "child_process"

let db: Database.Database
let service: WorkspaceService
let tmpfiles: string[] = []

beforeEach(() => {
  const dbPath = path.join(os.tmpdir(), `test-ws-svc-${Date.now()}.db`)
  tmpfiles.push(dbPath)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  service = new WorkspaceService(new WorkspaceDAO(db))
})

afterEach(() => {
  db.close()
  for (const f of tmpfiles) { if (fs.existsSync(f)) fs.unlinkSync(f) }
  tmpfiles = []
})

describe("WorkspaceService", () => {
  it("creates a workspace with auto-generated id", () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/ws" })
    expect(ws.id).toBeTruthy()
    expect(ws.name).toBe("Test")
    expect(ws.org).toBe("xzf")
    expect(ws.status).toBe("active")
  })

  it("lists all workspaces", () => {
    service.create({ name: "WS1", org: "xzf", path: "/tmp/ws1" })
    service.create({ name: "WS2", org: "xzf", path: "/tmp/ws2" })
    expect(service.list().length).toBe(2)
  })

  it("filters list by org", () => {
    service.create({ name: "A", org: "xzf", path: "/tmp/a" })
    service.create({ name: "B", org: "other", path: "/tmp/b" })
    expect(service.list("xzf").length).toBe(1)
    expect(service.list("other").length).toBe(1)
  })

  it("gets workspace by id", () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/ws" })
    const found = service.getById(ws.id)
    expect(found).toBeDefined()
    expect(found!.name).toBe("Test")
  })

  it("returns undefined for nonexistent id", () => {
    expect(service.getById("nonexistent")).toBeUndefined()
  })

  it("updates a workspace", () => {
    const ws = service.create({ name: "Old", org: "xzf", path: "/tmp/ws" })
    const updated = service.update(ws.id, { name: "New" })
    expect(updated!.name).toBe("New")
  })

  it("returns undefined when updating nonexistent workspace", () => {
    expect(service.update("nonexistent", { name: "X" })).toBeUndefined()
  })

  it("deletes a workspace with cascade", async () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/test-ws-cascade" })
    const execId = "exec-test"
    const neId = "ne-test"
    const sessionId = "session-test"
    const msgId = "msg-test"
    const now = new Date().toISOString()

    db.prepare("INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, 'test.yaml', 'test', 'pending', 'xzf', ?, ?)").run(execId, ws.id, now, now)
    db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, 'n1', 'bash', 'pending')").run(neId, execId)
    db.prepare("INSERT INTO chat_sessions (id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(sessionId, ws.id, now, now)
    db.prepare("INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', 'hello', ?)").run(msgId, sessionId, now)

    expect(await service.delete(ws.id)).toBe(true)
    expect(service.getById(ws.id)).toBeUndefined()
    expect(db.prepare("SELECT id FROM executions WHERE id = ?").get(execId)).toBeUndefined()
    expect(db.prepare("SELECT id FROM node_executions WHERE id = ?").get(neId)).toBeUndefined()
    expect(db.prepare("SELECT id FROM chat_sessions WHERE id = ?").get(sessionId)).toBeUndefined()
    expect(db.prepare("SELECT id FROM chat_messages WHERE id = ?").get(msgId)).toBeUndefined()
  })

  it("returns false when deleting nonexistent workspace", async () => {
    expect(await service.delete("nonexistent")).toBe(false)
  })

  it("creates standard subdirectories", () => {
    const ws = service.create({ name: "SubTest", org: "xzf", path: "/tmp/ws-subdirs" })
    const resolvedPath = "/tmp/ws-subdirs"
    expect(fs.existsSync(path.join(resolvedPath, "projects"))).toBe(true)
    expect(fs.existsSync(path.join(resolvedPath, "workflows"))).toBe(true)
    expect(fs.existsSync(path.join(resolvedPath, "logs"))).toBe(true)
    expect(fs.existsSync(path.join(resolvedPath, "state"))).toBe(true)
    fs.rmSync(resolvedPath, { recursive: true, force: true })
  })

  it("succeeds when workspace path already exists", () => {
    const basePath = "/tmp/ws-existing"
    fs.mkdirSync(basePath, { recursive: true })
    fs.writeFileSync(path.join(basePath, "existing-file.txt"), "hello")
    const ws = service.create({ name: "Existing", org: "xzf", path: basePath })
    expect(ws.name).toBe("Existing")
    expect(fs.existsSync(path.join(basePath, "existing-file.txt"))).toBe(true)
    fs.rmSync(basePath, { recursive: true, force: true })
  })

  // ── Ticket 08: source_path resolution + error propagation (G3) ──────────
  // createFromSpec must propagate initWorktreesFromSpec's throw so the scheduler
  // (workflow-executor.ts catch) can record schedule_executions.error_summary
  // instead of silently producing a broken workspace.
  describe("createFromSpec — source_path resolution (ticket 08)", () => {
    let realHome: string | undefined
    let realUserProfile: string | undefined
    let fakeHome: string

    beforeEach(() => {
      realHome = process.env.HOME
      realUserProfile = process.env.USERPROFILE
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ws-svc-home-"))
      // Fake both: os.homedir() reads $HOME on POSIX, %USERPROFILE% on Windows.
      process.env.HOME = fakeHome
      process.env.USERPROFILE = fakeHome
    })

    afterEach(() => {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = realUserProfile
      if (fs.existsSync(fakeHome)) fs.rmSync(fakeHome, { recursive: true, force: true })
    })

    it("creates a worktree when source_path is empty and repos/index.md resolves the repo", () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-svc-repo-"))
      try {
        execFileSync("git", ["init"], { cwd: repoDir })
        execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoDir })
        execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir })
        fs.writeFileSync(path.join(repoDir, "README.md"), "# x")
        execFileSync("git", ["add", "-A"], { cwd: repoDir })
        execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

        const reposDir = path.join(fakeHome, ".octopus", "orgs", "xzf", "repos")
        fs.mkdirSync(reposDir, { recursive: true })
        fs.writeFileSync(
          path.join(reposDir, "index.md"),
          `# GitRepo Index\n\n## core (xzf)\n\n### demo\n- local: ${repoDir} ✓ cloned\n`,
        )

        const ws = service.createFromSpec({
          org: "xzf",
          name: "taskpool-sched-1",
          projects: [{ name: "demo", source_path: "", group: "core" }],
          branch_prefix: "taskpool-s1",
          branch_suffix: "suffix",
          source: "scheduler",
          source_schedule_id: "sched-1",
          workflow_chain: [{ workflow_ref: "wf.yaml", input_values: {} }],
        })

        expect(fs.existsSync(path.join(ws.path, "projects", "demo", ".git"))).toBe(true)
      } finally {
        if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true })
      }
    })

    it("throws when source_path is empty and the repo is not resolvable (no silent skip)", () => {
      // No repos/index.md authored at all → resolveRepoPath throws index.md not found,
      // which must propagate out of createFromSpec.
      expect(() =>
        service.createFromSpec({
          org: "xzf",
          name: "taskpool-sched-2",
          projects: [{ name: "ghost", source_path: "", group: "core" }],
          branch_prefix: "taskpool-s2",
          branch_suffix: "suffix",
          source: "scheduler",
          source_schedule_id: "sched-2",
          workflow_chain: [{ workflow_ref: "wf.yaml", input_values: {} }],
        }),
      ).toThrow(/index\.md not found/)
    })
  })
})