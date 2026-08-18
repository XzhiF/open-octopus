import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock getServerUrl before importing the module under test
vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3472",
}))

import {
  listDemands,
  createDemand,
  getDemand,
  updateDemand,
  deleteDemand,
  markDemandReady,
  retryDemand,
  getPoolStatus,
  getPoolQueue,
} from "../demand-api"

describe("demand-api", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("listDemands", () => {
    it("fetches GET /api/task-board/demands with no params", async () => {
      const mockData = { demands: [], total: 0 }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)

      const result = await listDemands()

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands",
        { signal: undefined }
      )
      expect(result).toEqual(mockData)
    })

    it("appends query params for status and priority", async () => {
      const mockData = { demands: [], total: 0 }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)

      await listDemands({ status: "draft", priority: "high" })

      const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
      expect(calledUrl).toContain("status=draft")
      expect(calledUrl).toContain("priority=high")
    })

    it("skips undefined/null/empty params", async () => {
      const mockData = { demands: [], total: 0 }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)

      await listDemands({ status: "", priority: undefined })

      const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
      expect(calledUrl).not.toContain("status=")
      expect(calledUrl).not.toContain("priority=")
    })
  })

  describe("createDemand", () => {
    it("sends POST with JSON body", async () => {
      const mockDemand = { id: "d1", title: "Test", status: "draft" }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ demand: mockDemand }),
      } as Response)

      const result = await createDemand({
        title: "Test",
        project_ids: ["p1"],
        demand_workflow_ref: "wf-1",
      })

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(result).toEqual(mockDemand)
    })
  })

  describe("getDemand", () => {
    it("fetches GET /demands/:id", async () => {
      const mockDemand = { id: "d1", title: "Test" }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ demand: mockDemand }),
      } as Response)

      const result = await getDemand("d1")

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands/d1",
        { signal: undefined }
      )
      expect(result).toEqual(mockDemand)
    })

    it("throws on 404", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: { message: "Not found" } }),
      } as Response)

      await expect(getDemand("missing")).rejects.toThrow("Not found")
    })
  })

  describe("updateDemand", () => {
    it("sends PATCH with partial body", async () => {
      const mockDemand = { id: "d1", title: "Updated" }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ demand: mockDemand }),
      } as Response)

      const result = await updateDemand("d1", { title: "Updated" })

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands/d1",
        expect.objectContaining({ method: "PATCH" })
      )
      expect(result).toEqual(mockDemand)
    })
  })

  describe("deleteDemand", () => {
    it("sends DELETE", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as Response)

      const result = await deleteDemand("d1")

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands/d1",
        { method: "DELETE" }
      )
      expect(result).toEqual({ success: true })
    })
  })

  describe("markDemandReady", () => {
    it("sends POST to /demands/:id/ready", async () => {
      const mockDemand = { id: "d1", status: "ready" }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ demand: mockDemand }),
      } as Response)

      const result = await markDemandReady("d1")

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands/d1/ready",
        { method: "POST" }
      )
      expect(result).toEqual(mockDemand)
    })
  })

  describe("retryDemand", () => {
    it("sends POST to /demands/:id/retry", async () => {
      const mockDemand = { id: "d1", status: "ready" }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ demand: mockDemand }),
      } as Response)

      const result = await retryDemand("d1")

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/demands/d1/retry",
        { method: "POST" }
      )
      expect(result).toEqual(mockDemand)
    })
  })

  describe("getPoolStatus", () => {
    it("fetches GET /pool/status", async () => {
      const mockStatus = { draft: 2, ready: 1, done: 5 }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStatus),
      } as Response)

      const result = await getPoolStatus()

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/pool/status"
      )
      expect(result).toEqual(mockStatus)
    })
  })

  describe("getPoolQueue", () => {
    it("fetches GET /pool/queue", async () => {
      const mockQueue = { demands: [] }
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockQueue),
      } as Response)

      const result = await getPoolQueue()

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3472/api/task-board/pool/queue"
      )
      expect(result).toEqual(mockQueue)
    })
  })
})
