import { describe, it, expect, vi, beforeEach } from "vitest"
import { EngineInitPhase } from "../engine-init"
import type { EngineInitOptions, GitOpsLike, ResourcePreFlightLike, ResourceProvisionerLike } from "../engine-init"
import type { EngineCallbacks } from "../engine"
import type { WorkflowDef } from "@octopus/shared"

describe("EngineInitPhase", () => {
  let phase: EngineInitPhase
  let callbacks: EngineCallbacks
  let gitOps: GitOpsLike
  let resourcePreflight: ResourcePreFlightLike
  let resourceProvisioner: ResourceProvisionerLike
  let workflow: WorkflowDef

  beforeEach(() => {
    phase = new EngineInitPhase()

    callbacks = {
      onNodeStart: vi.fn(),
      onNodeEnd: vi.fn(),
      onNodeLog: vi.fn(),
    }

    gitOps = {
      allProjectsAction: vi.fn().mockResolvedValue({}),
      pullLatest: vi.fn().mockResolvedValue("abc123def456"),
    }

    resourcePreflight = {
      analyze: vi.fn().mockReturnValue({ agents: [], skills: [] }),
      check: vi.fn().mockReturnValue({ missing: [], available: [] }),
    }

    resourceProvisioner = {
      provision: vi.fn().mockResolvedValue({ provisioned: 0, failed: [] }),
    }

    workflow = {
      name: "test-workflow",
      nodes: [],
    } as WorkflowDef
  })

  const createOptions = (overrides?: Partial<EngineInitOptions>): EngineInitOptions => ({
    workspacePath: "/workspace",
    workflow,
    callbacks,
    gitOps,
    resourcePreflight,
    resourceProvisioner,
    ...overrides,
  })

  it("fires onNodeStart with __engine_init__ node ID", async () => {
    await phase.run(createOptions())
    expect(callbacks.onNodeStart).toHaveBeenCalledWith("__engine_init__", "bash")
  })

  it("analyzes workflow for resource references", async () => {
    await phase.run(createOptions())
    expect(resourcePreflight.analyze).toHaveBeenCalledWith(workflow)
  })

  it("returns completed status when all steps succeed", async () => {
    const result = await phase.run(createOptions())
    expect(result.status).toBe("completed")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  describe("resource provisioning", () => {
    it("provisions missing resources", async () => {
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: ["agent1"], skills: ["skill1"] })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "skill1", type: "skill" }],
        available: [{ name: "agent1", type: "agent" }],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({ provisioned: 1, failed: [] })

      const result = await phase.run(createOptions())

      expect(resourceProvisioner.provision).toHaveBeenCalledWith(
        [{ name: "skill1", type: "skill" }],
        "/workspace",
      )
      expect(result.skillsCopied).toBe(1)
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("Provisioning 1 missing resource"),
      )
    })

    it("logs success when all resources are present", async () => {
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: ["agent1"], skills: [] })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [],
        available: [{ name: "agent1", type: "agent" }],
      })

      await phase.run(createOptions())

      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        "All required resources already present",
      )
      expect(resourceProvisioner.provision).not.toHaveBeenCalled()
    })

    it("fails and throws when provisioning fails", async () => {
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: ["skill1"] })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "skill1", type: "skill" }],
        available: [],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({
        provisioned: 0,
        failed: ["skill1"],
      })

      const result = await phase.run(createOptions())

      expect(result.status).toBe("failed")
      expect(callbacks.onNodeEnd).toHaveBeenCalledWith(
        "__engine_init__",
        "failed",
        expect.any(Number),
      )
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("[ERROR] Failed to provision"),
      )
    })

    it("skips resource check when preflight is not configured", async () => {
      const result = await phase.run(createOptions({ resourcePreflight: undefined }))

      expect(result.status).toBe("completed")
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        "Resource preflight not configured, skipping",
      )
    })
  })

  describe("git sync", () => {
    it("pulls latest for all workspace projects when syncMainBranch=true", async () => {
      vi.mocked(gitOps.allProjectsAction).mockImplementation(async (_path, action) => {
        await action("/workspace/projects/proj1", "proj1")
        await action("/workspace/projects/proj2", "proj2")
        return { proj1: { project: "proj1", success: true }, proj2: { project: "proj2", success: true } }
      })

      const result = await phase.run(createOptions({ syncMainBranch: true }))

      expect(gitOps.allProjectsAction).toHaveBeenCalledWith("/workspace", expect.any(Function))
      expect(gitOps.pullLatest).toHaveBeenCalledTimes(2)
      expect(result.gitSyncResults).toHaveLength(2)
      expect(result.gitSyncResults.every((r) => r.success)).toBe(true)
    })

    it("continues when git sync fails for one project", async () => {
      vi.mocked(gitOps.allProjectsAction).mockImplementation(async (_path, action) => {
        const results: Record<string, any> = {}
        results["proj1"] = await action("/workspace/projects/proj1", "proj1")
        vi.mocked(gitOps.pullLatest).mockRejectedValueOnce(new Error("merge conflict"))
        results["proj2"] = await action("/workspace/projects/proj2", "proj2")
        return results
      })

      vi.mocked(gitOps.pullLatest)
        .mockResolvedValueOnce("abc123")
        .mockRejectedValueOnce(new Error("merge conflict"))
        .mockResolvedValueOnce("def456")

      const result = await phase.run(createOptions({ syncMainBranch: true }))

      expect(result.status).toBe("completed")
      expect(result.gitSyncResults.some((r) => !r.success)).toBe(true)
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("⚠ proj2 sync failed"),
      )
    })

    it("skips git sync when syncMainBranch=false", async () => {
      const result = await phase.run(createOptions({ syncMainBranch: false }))

      expect(gitOps.allProjectsAction).not.toHaveBeenCalled()
      expect(result.gitSyncResults).toHaveLength(0)
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        "Git sync skipped (disabled)",
      )
    })

    it("logs when gitOps is not configured", async () => {
      await phase.run(createOptions({ gitOps: undefined, syncMainBranch: true }))

      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        "Git sync requested but gitOps not configured",
      )
    })

    it("logs warning count when some projects fail to sync", async () => {
      vi.mocked(gitOps.allProjectsAction).mockImplementation(async (_path, action) => {
        const results: Record<string, any> = {}
        vi.mocked(gitOps.pullLatest).mockRejectedValueOnce(new Error("conflict"))
        results["proj1"] = await action("/workspace/projects/proj1", "proj1")
        return results
      })

      vi.mocked(gitOps.pullLatest).mockRejectedValueOnce(new Error("conflict"))

      await phase.run(createOptions({ syncMainBranch: true }))

      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("1 project(s) failed to sync"),
      )
    })
  })

  describe("duration tracking", () => {
    it("tracks duration from start to completion", async () => {
      vi.mocked(gitOps.allProjectsAction).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10))
        return {}
      })

      const result = await phase.run(createOptions())

      expect(result.durationMs).toBeGreaterThanOrEqual(10)
      expect(callbacks.onNodeEnd).toHaveBeenCalledWith(
        "__engine_init__",
        "completed",
        expect.any(Number),
      )
    })
  })
})
