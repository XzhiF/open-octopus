import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkspaceService } from "../services/workspace"
import { WorkspaceDAO } from '../db/dao'
import os from "os"
import path from "path"
import fs from "fs"
import { execFileSync } from "child_process"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

/**
 * [P1 B5 票6b-1] 单引擎收口：workspaces/executions/node_executions/chat_* 均已迁 PG
 * （票5/票6a/B1）—— 造数与级联断言全部落注册池；SQLite `db` 仅保留 schema 句柄
 * （service 构造已不吃它，留作对照位）。用例间 truncate 保证计数断言不跨用例串味。
 */
describePg("WorkspaceService (PG 单引擎)", () => {
  let pg: PgFixture
  let db: Database.Database
  let service: WorkspaceService
  let tmpfiles: string[] = []

  beforeAll(async () => {
    pg = await setupRegisteredPgSchema()
  }, 30000)

  afterAll(async () => {
    await pg.close()
  })

  beforeEach(async () => {
    const dbPath = path.join(os.tmpdir(), `test-ws-svc-${Date.now()}.db`)
    tmpfiles.push(dbPath)
    db = new Database(dbPath)
    db.pragma("foreign_keys = ON")
    applySchema(db)
    // 用例间清 PG 表（CASCADE 吃掉 FK 依赖链）。
    await pg.truncate("chat_messages", "chat_sessions", "node_executions", "executions", "workspaces")
    service = new WorkspaceService(new WorkspaceDAO(pg.sql))
  })

  afterEach(() => {
    db.close()
    for (const f of tmpfiles) { if (fs.existsSync(f)) fs.unlinkSync(f) }
    tmpfiles = []
  })

  describe("WorkspaceService", () => {
    it("creates a workspace with auto-generated id", async () => {
      const ws = await service.create({ name: "Test", org: "xzf", path: "/tmp/ws" })
      expect(ws.id).toBeTruthy()
      expect(ws.name).toBe("Test")
      expect(ws.org).toBe("xzf")
      expect(ws.status).toBe("active")
    })

    it("lists all workspaces", async () => {
      await service.create({ name: "WS1", org: "xzf", path: "/tmp/ws1" })
      await service.create({ name: "WS2", org: "xzf", path: "/tmp/ws2" })
      expect((await service.list()).length).toBe(2)
    })

    it("filters list by org", async () => {
      await service.create({ name: "A", org: "xzf", path: "/tmp/a" })
      await service.create({ name: "B", org: "other", path: "/tmp/b" })
      expect((await service.list("xzf")).length).toBe(1)
      expect((await service.list("other")).length).toBe(1)
    })

    it("gets workspace by id", async () => {
      const ws = await service.create({ name: "Test", org: "xzf", path: "/tmp/ws" })
      const found = await service.getById(ws.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe("Test")
    })

    it("returns undefined for nonexistent id", async () => {
      expect(await service.getById("nonexistent")).toBeUndefined()
    })

    it("updates a workspace", async () => {
      const ws = await service.create({ name: "Old", org: "xzf", path: "/tmp/ws" })
      const updated = await service.update(ws.id, { name: "New" })
      expect(updated!.name).toBe("New")
    })

    it("returns undefined when updating nonexistent workspace", async () => {
      expect(await service.update("nonexistent", { name: "X" })).toBeUndefined()
    })

    it("deletes a workspace with cascade", async () => {
      const ws = await service.create({ name: "Test", org: "xzf", path: "/tmp/test-ws-cascade" })
      const execId = "exec-test"
      const neId = "ne-test"
      const sessionId = "session-test"
      const msgId = "msg-test"
      const now = new Date().toISOString()

      // [票6b-1] 级联链路四表全部 PG —— 造数直插注册池（FK 依赖序：executions → 其余）。
      await pg.sql.unsafe(
        "INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES ($1, $2, '0', 0, 'test.yaml', 'test', 'pending', 'xzf', $3, $3)",
        [execId, ws.id, now],
      )
      await pg.sql.unsafe(
        "INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES ($1, $2, 'n1', 'bash', 'pending')",
        [neId, execId],
      )
      await pg.sql.unsafe(
        "INSERT INTO chat_sessions (id, workspace_id, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [sessionId, ws.id, now],
      )
      await pg.sql.unsafe(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ($1, $2, 'user', 'hello', $3)",
        [msgId, sessionId, now],
      )

      expect(await service.delete(ws.id)).toBe(true)
      expect(await service.getById(ws.id)).toBeUndefined()
      const one = async (sql: string, id: string) =>
        (await pg.sql.unsafe(sql, [id]) as Array<{ id: string }>).length
      expect(await one("SELECT id FROM executions WHERE id = $1", execId)).toBe(0)
      expect(await one("SELECT id FROM node_executions WHERE id = $1", neId)).toBe(0)
      expect(await one("SELECT id FROM chat_sessions WHERE id = $1", sessionId)).toBe(0)
      expect(await one("SELECT id FROM chat_messages WHERE id = $1", msgId)).toBe(0)
    })

    it("returns false when deleting nonexistent workspace", async () => {
      expect(await service.delete("nonexistent")).toBe(false)
    })

    it("creates standard subdirectories", async () => {
      const ws = await service.create({ name: "SubTest", org: "xzf", path: "/tmp/ws-subdirs" })
      const resolvedPath = "/tmp/ws-subdirs"
      expect(ws.id).toBeTruthy()
      expect(fs.existsSync(path.join(resolvedPath, "projects"))).toBe(true)
      expect(fs.existsSync(path.join(resolvedPath, "workflows"))).toBe(true)
      expect(fs.existsSync(path.join(resolvedPath, "logs"))).toBe(true)
      expect(fs.existsSync(path.join(resolvedPath, "state"))).toBe(true)
      fs.rmSync(resolvedPath, { recursive: true, force: true })
    })

    it("succeeds when workspace path already exists", async () => {
      const basePath = "/tmp/ws-existing"
      fs.mkdirSync(basePath, { recursive: true })
      fs.writeFileSync(path.join(basePath, "existing-file.txt"), "hello")
      const ws = await service.create({ name: "Existing", org: "xzf", path: basePath })
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

      it("creates a worktree when source_path is empty and repos/index.md resolves the repo", async () => {
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

          const ws = await service.createFromSpec({
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

      it("createFromSpec 持久化 description（task-board-title 改版: task 触发写入任务标题）；缺省为 null", async () => {
        const withDesc = await service.createFromSpec({
          org: "xzf",
          name: "taskpool-desc-1",
          description: "任务标题映射到工作区描述",
          projects: [],
          branch_prefix: "taskpool-d1",
          branch_suffix: "suffix",
          source: "task",
          task_id: "task-1",
          workflow_chain: [],
        })
        expect(withDesc.description).toBe("任务标题映射到工作区描述")

        const noDesc = await service.createFromSpec({
          org: "xzf",
          name: "taskpool-desc-2",
          projects: [],
          branch_prefix: "taskpool-d2",
          branch_suffix: "suffix",
          source: "scheduler",
          workflow_chain: [],
        })
        expect(noDesc.description).toBeNull()
      })

      it("throws when source_path is empty and the repo is not resolvable (no silent skip)", async () => {
        // No repos/index.md authored at all → resolveRepoPath throws index.md not found,
        // which must propagate out of createFromSpec (async: rejected promise).
        await expect(service.createFromSpec({
          org: "xzf",
          name: "taskpool-sched-2",
          projects: [{ name: "ghost", source_path: "", group: "core" }],
          branch_prefix: "taskpool-s2",
          branch_suffix: "suffix",
          source: "scheduler",
          source_schedule_id: "sched-2",
          workflow_chain: [{ workflow_ref: "wf.yaml", input_values: {} }],
        })).rejects.toThrow(/index\.md not found/)
      })
    })
  })
})
