import { describe, it, expect, vi, beforeEach } from "vitest"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import type { ResourceManager, ResourceEntry } from "@octopus/shared"

const VALID_WF = "apiVersion: octopus/v1\nkind: Workflow\nname: deploy\ninputs:\n  environment: { description: 'deploy env', required: true, default: dev }\nnodes:\n  - id: step1\n    type: bash\n    bash: echo deploy"

describe("BuiltInWorkflowService", () => {
  let mockResourceManager: Partial<ResourceManager>

  beforeEach(() => {
    mockResourceManager = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    }
  })

  it("returns empty list when no workflows installed", () => {
    const service = new BuiltInWorkflowService(mockResourceManager as ResourceManager)
    expect(service.list()).toEqual([])
  })

  it("lists workflows from ResourceManager", () => {
    const mockEntry: Partial<ResourceEntry> = {
      name: "deploy",
      type: "workflow",
      group: "built-in",
      installed: true,
      installPath: "/fake/path/workflows/deploy",
    }
    mockResourceManager.list = vi.fn().mockReturnValue([mockEntry])

    // Mock fs to return valid workflow content
    const fs = require("fs")
    vi.spyOn(fs, "existsSync").mockReturnValue(true)
    vi.spyOn(fs, "readdirSync").mockReturnValue(["deploy.yaml"])
    vi.spyOn(fs, "readFileSync").mockReturnValue(VALID_WF)

    const service = new BuiltInWorkflowService(mockResourceManager as ResourceManager)
    const list = service.list()

    expect(list).toHaveLength(1)
    expect(list[0].ref).toBe("built-in/deploy")
    expect(list[0].name).toBe("deploy")

    vi.restoreAllMocks()
  })

  it("gets workflow by ref", () => {
    const mockEntry: Partial<ResourceEntry> = {
      name: "deploy",
      type: "workflow",
      group: "built-in",
      installed: true,
      installPath: "/fake/path/workflows/deploy",
    }
    mockResourceManager.get = vi.fn().mockReturnValue(mockEntry)

    const fs = require("fs")
    vi.spyOn(fs, "existsSync").mockReturnValue(true)
    vi.spyOn(fs, "readdirSync").mockReturnValue(["deploy.yaml"])
    vi.spyOn(fs, "readFileSync").mockReturnValue(VALID_WF)

    const service = new BuiltInWorkflowService(mockResourceManager as ResourceManager)
    const detail = service.get("built-in/deploy")

    expect(detail).toBeDefined()
    expect(detail?.parsed.name).toBe("deploy")

    vi.restoreAllMocks()
  })

  it("returns null for nonexistent ref", () => {
    const service = new BuiltInWorkflowService(mockResourceManager as ResourceManager)
    expect(service.get("nonexistent/workflow")).toBeNull()
  })

  it("handles group mismatch in get()", () => {
    const mockEntry: Partial<ResourceEntry> = {
      name: "deploy",
      type: "workflow",
      group: "custom-group",
      installed: true,
      installPath: "/fake/path",
    }
    mockResourceManager.get = vi.fn().mockReturnValue(mockEntry)

    const service = new BuiltInWorkflowService(mockResourceManager as ResourceManager)
    const result = service.get("wrong-group/deploy")

    expect(result).toBeNull()
  })
})
