import { describe, it, expect, vi, beforeEach } from "vitest"
import { listWorkflowPresets, getBuiltInWorkflowDetail, listBuiltInWorkflows } from "../workflow-presets-api"

// Mock the server-config module
vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))

describe("workflow-presets-api", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe("listWorkflowPresets", () => {
    it("calls correct URL without skills_group", async () => {
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ presets: [] }),
      } as Response)

      await listWorkflowPresets()
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/workflow-presets",
      )
    })

    it("calls correct URL with skills_group", async () => {
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ presets: [] }),
      } as Response)

      await listWorkflowPresets(["octo-backend", "octo-frontend"])
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain("skills_group=octo-backend%2Cocto-frontend")
    })

    it("returns presets from response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          presets: [
            { name: "test", skills_group: [], workflow: "built-in/flow", inputs: {} },
          ],
        }),
      } as Response)

      const result = await listWorkflowPresets()
      expect(result.presets).toHaveLength(1)
      expect(result.presets[0].name).toBe("test")
    })
  })

  describe("getBuiltInWorkflowDetail", () => {
    it("calls correct URL with encoded ref", async () => {
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ref: "built-in/flow", content: "", parsed: {} }),
      } as Response)

      await getBuiltInWorkflowDetail("built-in/my-flow")
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/workflows/built-in/built-in%2Fmy-flow",
      )
    })
  })

  describe("listBuiltInWorkflows", () => {
    it("calls correct URL", async () => {
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      } as Response)

      await listBuiltInWorkflows()
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/workflows/built-in",
      )
    })
  })
})
