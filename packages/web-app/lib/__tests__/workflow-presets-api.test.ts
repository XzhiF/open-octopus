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
    it("calls the catalog endpoint (no filters — catalog is verbatim)", async () => {
      const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ presets: [] }),
      } as Response)

      await listWorkflowPresets()
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/workflow-presets",
      )
    })

    it("returns presets from response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          presets: [
            { name: "spec-dev", desc: "d", workflow: "built-in/matt-spec-dev", inputs: { batch_dir: "${phase.batch_rel}" } },
          ],
        }),
      } as Response)

      const result = await listWorkflowPresets()
      expect(result.presets).toHaveLength(1)
      expect(result.presets[0].workflow).toBe("built-in/matt-spec-dev")
      expect(result.presets[0].inputs.batch_dir).toBe("${phase.batch_rel}")
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
