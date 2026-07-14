import { describe, it, expect, vi, beforeEach } from "vitest"
import { WorkspaceService } from "../services/workspace"
import { createWorkspaceRoutes } from "../routes/workspace"
import { WorkspaceDAO } from "../db/dao"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import path from "path"
import os from "os"

// Mock the archive service - vi.mock is hoisted, so we define the mock function inline
vi.mock("../services/archive/archive-service", () => {
  const mockFn = vi.fn()
  return {
    getArchiveService: () => ({
      archiveWorkspace: mockFn,
    }),
    ArchivePartialFailure: class ArchivePartialFailure extends Error {
      failures: any[]
      constructor(failures: any[]) {
        super("Archive partial failure")
        this.failures = failures
      }
    },
    __getMock: () => mockFn,
  }
})

// Import after mock is set up
import { __getMock } from "../services/archive/archive-service"

describe("DELETE /api/workspaces/:id route", () => {
  let db: Database.Database
  let workspaceService: WorkspaceService
  let workspaceId: string
  let mockArchiveWarehouse: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const dbPath = path.join(os.tmpdir(), `test-ws-route-${Date.now()}.db`)
    db = new Database(dbPath)
    db.pragma("foreign_keys = ON")
    applySchema(db)

    const workspaceDAO = new WorkspaceDAO(db)
    workspaceService = new WorkspaceService(workspaceDAO)

    // Get the mock function and configure it
    mockArchiveWarehouse = __getMock()
    mockArchiveWarehouse.mockReset()
    mockArchiveWarehouse.mockResolvedValue({ archived: true, execution_count: 0 })

    // Create test workspace
    const ws = workspaceService.create({ name: "Test WS", org: "test-org", path: "/tmp/test-ws-route" })
    workspaceId = ws.id
  })

  it("DELETE with no query param defaults to archiveMode 'full'", async () => {
    const routes = createWorkspaceRoutes(workspaceService, new WorkspaceDAO(db), new WorkspaceDAO(db))
    const req = new Request(`http://localhost/${workspaceId}`, { method: "DELETE" })
    const res = await routes.fetch(req)

    expect(res.status).toBe(200)
    expect(mockArchiveWarehouse).toHaveBeenCalledWith(workspaceId, expect.any(Object), "full")
  })

  it("DELETE with ?mode=cleanup passes archiveMode 'cleanup'", async () => {
    const routes = createWorkspaceRoutes(workspaceService, new WorkspaceDAO(db), new WorkspaceDAO(db))
    const req = new Request(`http://localhost/${workspaceId}?mode=cleanup`, { method: "DELETE" })
    const res = await routes.fetch(req)

    expect(res.status).toBe(200)
    expect(mockArchiveWarehouse).toHaveBeenCalledWith(workspaceId, expect.any(Object), "cleanup")
  })

  it("DELETE with ?mode=full passes archiveMode 'full'", async () => {
    const routes = createWorkspaceRoutes(workspaceService, new WorkspaceDAO(db), new WorkspaceDAO(db))
    const req = new Request(`http://localhost/${workspaceId}?mode=full`, { method: "DELETE" })
    const res = await routes.fetch(req)

    expect(res.status).toBe(200)
    expect(mockArchiveWarehouse).toHaveBeenCalledWith(workspaceId, expect.any(Object), "full")
  })

  it("DELETE with invalid mode returns 400", async () => {
    const routes = createWorkspaceRoutes(workspaceService, new WorkspaceDAO(db), new WorkspaceDAO(db))
    const req = new Request(`http://localhost/${workspaceId}?mode=bogus`, { method: "DELETE" })
    const res = await routes.fetch(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
    expect(body.error).toContain("Invalid mode")
  })

  it("DELETE with uppercase mode returns 400", async () => {
    const routes = createWorkspaceRoutes(workspaceService, new WorkspaceDAO(db), new WorkspaceDAO(db))
    const req = new Request(`http://localhost/${workspaceId}?mode=ARCHIVE`, { method: "DELETE" })
    const res = await routes.fetch(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })
})
