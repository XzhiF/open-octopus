import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkspaceService } from "../services/workspace"
import { WorkspaceDAO } from '../db/dao'
import os from "os"
import path from "path"
import fs from "fs"

let db: Database.Database
let service: WorkspaceService
let tmpfiles: string[] = []
let mockArchiveWorkspace: ReturnType<typeof vi.fn>

beforeEach(() => {
  const dbPath = path.join(os.tmpdir(), `test-ws-svc-${Date.now()}.db`)
  tmpfiles.push(dbPath)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  service = new WorkspaceService(new WorkspaceDAO(db))

  // Mock ArchiveService
  mockArchiveWorkspace = vi.fn().mockResolvedValue({ archived: true, execution_count: 0 })
  vi.mock("../services/archive/archive-service", () => ({
    getArchiveService: () => ({
      archiveWorkspace: mockArchiveWorkspace,
    }),
  }))
})

afterEach(() => {
  db.close()
  for (const f of tmpfiles) { if (fs.existsSync(f)) fs.unlinkSync(f) }
  tmpfiles = []
  vi.clearAllMocks()
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
    // After delete, workspace is soft-archived (not removed)
    const archived = service.getById(ws.id)
    expect(archived).toBeDefined()
    expect(archived!.archive_status).toBe("archived")
    // Note: cascade delete of related entities happens in ArchiveService, which is mocked in this test suite.
    // Cascade behavior is tested in archive-service.test.ts, not here.
  })

  it("returns false when deleting nonexistent workspace", async () => {
    expect(await service.delete("nonexistent")).toBe(false)
  })

  it("delete() defaults to archiveMode 'full' when not specified", async () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/test-ws-mode-default" })

    await service.delete(ws.id)

    expect(mockArchiveWorkspace).toHaveBeenCalledWith(ws.id, expect.any(Object), "full")
  })

  it("delete() passes archiveMode 'cleanup' to archiveWorkspace", async () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/test-ws-mode-cleanup" })

    await service.delete(ws.id, "cleanup")

    expect(mockArchiveWorkspace).toHaveBeenCalledWith(ws.id, expect.any(Object), "cleanup")
  })

  it("delete() passes archiveMode 'full' explicitly to archiveWorkspace", async () => {
    const ws = service.create({ name: "Test", org: "xzf", path: "/tmp/test-ws-mode-full" })

    await service.delete(ws.id, "full")

    expect(mockArchiveWorkspace).toHaveBeenCalledWith(ws.id, expect.any(Object), "full")
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
})