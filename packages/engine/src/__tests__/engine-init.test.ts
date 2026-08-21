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
      analyze: vi.fn().mockReturnValue({ agents: [], skills: [], commands: [], rules: [] }),
      check: vi.fn().mockReturnValue({ missing: [], available: [] }),
    }

    resourceProvisioner = {
      provision: vi.fn().mockResolvedValue({ provisioned: 0, failed: [], byType: {} }),
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
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: ["agent1"], skills: ["skill1"], commands: [], rules: [] })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "skill1", type: "skill" }],
        available: [{ name: "agent1", type: "agent" }],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({ provisioned: 1, failed: [], byType: { skill: 1 } })

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
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: ["agent1"], skills: [], commands: [], rules: [] })
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
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: ["skill1"], commands: [], rules: [] })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "skill1", type: "skill" }],
        available: [],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({
        provisioned: 0,
        failed: ["skill1"],
        byType: {},
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

    describe("requires declaration", () => {
      it("provisions requires resources first, then scans", async () => {
        workflow = {
          ...workflow,
          requires: {
            skills: ["declared-skill"],
            agent_files: ["declared-agent.md"],
          },
        } as WorkflowDef

        // First call: requires check (declared resources)
        // Second call: scan check (scanned resources)
        vi.mocked(resourcePreflight.analyze).mockReturnValue({
          agents: ["scanned-agent"],
          skills: ["scanned-skill"],
          commands: [],
          rules: [],
        })
        vi.mocked(resourcePreflight.check)
          .mockReturnValueOnce({
            missing: [{ name: "declared-skill", type: "skill" }, { name: "declared-agent", type: "agent" }],
            available: [],
          })
          .mockReturnValueOnce({
            missing: [{ name: "scanned-skill", type: "skill" }],
            available: [{ name: "scanned-agent", type: "agent" }],
          })
        vi.mocked(resourceProvisioner.provision).mockResolvedValue({
          provisioned: 2,
          failed: [],
          byType: { skill: 1, agent: 1 },
        })

        await phase.run(createOptions({ workflow }))

        // Verify log order: requires first, then scan
        const logCalls = vi.mocked(callbacks.onNodeLog).mock.calls.map(c => c[1])
        const requiresIdx = logCalls.findIndex(l => l.includes("Provisioning from requires"))
        const scanIdx = logCalls.findIndex(l => l.includes("Scanning for additional resources"))
        expect(requiresIdx).toBeGreaterThan(-1)
        expect(scanIdx).toBeGreaterThan(-1)
        expect(requiresIdx).toBeLessThan(scanIdx)
      })

      it("deduplicates requires and scanned resources", async () => {
        workflow = {
          ...workflow,
          requires: {
            skills: ["shared-skill"],
            agent_files: [],
          },
        } as WorkflowDef

        vi.mocked(resourcePreflight.analyze).mockReturnValue({
          agents: [],
          skills: ["shared-skill"], // same as requires
          commands: [],
          rules: [],
        })
        vi.mocked(resourcePreflight.check)
          .mockReturnValueOnce({
            missing: [{ name: "shared-skill", type: "skill" }],
            available: [],
          })
          .mockReturnValueOnce({
            // After requires provisioned shared-skill, scan finds nothing missing
            missing: [],
            available: [{ name: "shared-skill", type: "skill" }],
          })
        vi.mocked(resourceProvisioner.provision).mockResolvedValue({
          provisioned: 1,
          failed: [],
          byType: { skill: 1 },
        })

        await phase.run(createOptions({ workflow }))

        // Provision called only once for requires, not again for scan
        expect(resourceProvisioner.provision).toHaveBeenCalledTimes(1)
      })

      it("works without requires (backward compatible)", async () => {
        // workflow has no requires field
        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: ["skill1"], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check).mockReturnValue({
          missing: [{ name: "skill1", type: "skill" }],
          available: [],
        })
        vi.mocked(resourceProvisioner.provision).mockResolvedValue({
          provisioned: 1,
          failed: [],
          byType: { skill: 1 },
        })

        const result = await phase.run(createOptions())

        expect(result.status).toBe("completed")
        // Should NOT log "Provisioning from requires"
        const logCalls = vi.mocked(callbacks.onNodeLog).mock.calls.map(c => c[1])
        expect(logCalls.some(l => l.includes("Provisioning from requires"))).toBe(false)
      })

      it("logs requires counts correctly", async () => {
        workflow = {
          ...workflow,
          requires: {
            skills: ["s1", "s2"],
            agent_files: ["a1.md", "a2.md", "a3.md"],
          },
        } as WorkflowDef

        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check)
          .mockReturnValueOnce({ missing: [], available: [] })
          .mockReturnValueOnce({ missing: [], available: [] })
        vi.mocked(resourceProvisioner.provision).mockResolvedValue({ provisioned: 0, failed: [], byType: {} })

        await phase.run(createOptions({ workflow }))

        expect(callbacks.onNodeLog).toHaveBeenCalledWith(
          "__engine_init__",
          expect.stringContaining("Provisioning from requires: 2 skills, 3 agents"),
        )
      })
    })

    // 07 (SG7): configRequires (from the schedule's WorkflowConfig.requires,
    // propagated by materializeTaskSpecToConfig) UNION-merges with
    // workflow.requires for provisioning. Does NOT override workflow-defined
    // requires; duplicates are deduped. The merged set is what the provisioner
    // sees via resourcePreflight.check.
    describe("configRequires UNION merge (07 SG7)", () => {
      it("UNION-merges configRequires with workflow.requires (deduped, no override)", async () => {
        workflow = {
          ...workflow,
          requires: { skills: ["wf-skill"] },
        } as WorkflowDef

        // analyze returns empty (no scan resources) so check is only called
        // once — for the merged requires manifest in Step 1.
        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check).mockReturnValue({ missing: [], available: [] })

        await phase.run(createOptions({
          workflow,
          configRequires: { skills: ["cfg-skill", "wf-skill"] }, // "wf-skill" is a dupe
        } as any))

        // Step 1 manifest passed to preflight.check = UNION(wf.requires, configRequires), deduped
        const manifest = vi.mocked(resourcePreflight.check).mock.calls[0][0]
        expect(manifest.skills).toEqual(expect.arrayContaining(["wf-skill", "cfg-skill"]))
        expect(manifest.skills).toHaveLength(2)
      })

      it("configRequires alone (no workflow.requires) is provisioned", async () => {
        // workflow has no requires field
        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check).mockReturnValue({ missing: [], available: [] })

        await phase.run(createOptions({
          configRequires: { commands: ["ship-cmd"], rules: ["coding-style"] },
        } as any))

        const manifest = vi.mocked(resourcePreflight.check).mock.calls[0][0]
        expect(manifest.commands).toEqual(["ship-cmd"])
        expect(manifest.rules).toEqual(["coding-style"])
      })

      it("agent_files from configRequires UNION with workflow agent_files", async () => {
        workflow = {
          ...workflow,
          requires: { agent_files: ["wf-agent.md"] },
        } as WorkflowDef
        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check).mockReturnValue({ missing: [], available: [] })

        await phase.run(createOptions({
          workflow,
          configRequires: { agent_files: ["cfg-agent"] },
        } as any))

        const manifest = vi.mocked(resourcePreflight.check).mock.calls[0][0]
        // agentFileToName strips .md → both resolve to bare names, deduped
        expect(manifest.agents).toEqual(expect.arrayContaining(["wf-agent", "cfg-agent"]))
        expect(manifest.agents).toHaveLength(2)
      })

      it("no configRequires → unchanged behavior (backward compat)", async () => {
        workflow = {
          ...workflow,
          requires: { skills: ["wf-skill"] },
        } as WorkflowDef
        vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })
        vi.mocked(resourcePreflight.check).mockReturnValue({ missing: [], available: [] })

        await phase.run(createOptions({ workflow }))

        const manifest = vi.mocked(resourcePreflight.check).mock.calls[0][0]
        expect(manifest.skills).toEqual(["wf-skill"])
      })
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

  describe("clone hard-fail gate", () => {
    it("fails with cloneErrors when a required clone is not installed", async () => {
      workflow = {
        ...workflow,
        requires: {
          clones: ["missing-clone"],
        },
      } as WorkflowDef

      const result = await phase.run(createOptions({ workflow }))

      expect(result.status).toBe("failed")
      expect(result.cloneErrors).toHaveLength(1)
      expect(result.cloneErrors[0]).toContain("missing-clone")
      expect(result.cloneErrors[0]).toContain("is not installed")
      expect(result.cloneErrors[0]).toContain("octopus resource install builtin:missing-clone --type clone")
    })

    it("fails with multiple cloneErrors for multiple missing clones", async () => {
      workflow = {
        ...workflow,
        requires: {
          clones: ["clone-a", "clone-b"],
        },
      } as WorkflowDef

      const result = await phase.run(createOptions({ workflow }))

      expect(result.status).toBe("failed")
      expect(result.cloneErrors).toHaveLength(2)
      expect(result.cloneErrors[0]).toContain("clone-a")
      expect(result.cloneErrors[1]).toContain("clone-b")
    })

    it("logs error messages for missing clones", async () => {
      workflow = {
        ...workflow,
        requires: {
          clones: ["bad-clone"],
        },
      } as WorkflowDef

      await phase.run(createOptions({ workflow }))

      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("[ERROR] Clone 'bad-clone' is not installed"),
      )
    })

    it("blocks provisioning when clone gate fails (no provisioner called)", async () => {
      workflow = {
        ...workflow,
        requires: {
          clones: ["missing-clone"],
          skills: ["some-skill"],
        },
      } as WorkflowDef

      await phase.run(createOptions({ workflow }))

      // Provisioner should NOT be called — clone gate blocks everything
      expect(resourceProvisioner.provision).not.toHaveBeenCalled()
    })

    it("proceeds when no clones are declared", async () => {
      workflow = {
        ...workflow,
        requires: {
          skills: ["some-skill"],
        },
      } as WorkflowDef

      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [],
        available: [{ name: "some-skill", type: "skill" }],
      })

      const result = await phase.run(createOptions({ workflow }))

      expect(result.status).toBe("completed")
      expect(result.cloneErrors).toHaveLength(0)
    })
  })

  describe("command and rule provisioning", () => {
    it("provisions missing commands from requires", async () => {
      workflow = {
        ...workflow,
        requires: {
          commands: ["cmd-review"],
        },
      } as WorkflowDef

      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "cmd-review", type: "command" }],
        available: [],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({
        provisioned: 1,
        failed: [],
        byType: { command: 1 },
      })

      const result = await phase.run(createOptions({ workflow }))

      expect(resourceProvisioner.provision).toHaveBeenCalledWith(
        [{ name: "cmd-review", type: "command" }],
        "/workspace",
      )
      expect(result.commandsCopied).toBe(1)
      expect(result.status).toBe("completed")
    })

    it("provisions missing rules from requires", async () => {
      workflow = {
        ...workflow,
        requires: {
          rules: ["code-style"],
        },
      } as WorkflowDef

      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "code-style", type: "rule" }],
        available: [],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({
        provisioned: 1,
        failed: [],
        byType: { rule: 1 },
      })

      const result = await phase.run(createOptions({ workflow }))

      expect(resourceProvisioner.provision).toHaveBeenCalledWith(
        [{ name: "code-style", type: "rule" }],
        "/workspace",
      )
      expect(result.rulesCopied).toBe(1)
      expect(result.status).toBe("completed")
    })

    it("handles mixed requires with all 5 types — clone gate first, then provisioning", async () => {
      // Create a temp directory to simulate an installed clone
      const os = await import("os")
      const path = await import("path")
      const fs = await import("fs")
      const homeDir = os.homedir()
      const cloneDir = path.join(homeDir, '.octopus', 'agent', 'built-in', 'workspace')

      // Create the clone directory temporarily
      fs.mkdirSync(cloneDir, { recursive: true })

      try {
        workflow = {
          ...workflow,
          requires: {
            skills: ["s1"],
            agent_files: ["a1.md"],
            commands: ["cmd1"],
            rules: ["rule1"],
            clones: ["workspace"],
          },
        } as WorkflowDef

        vi.mocked(resourcePreflight.check).mockReturnValue({
          missing: [
            { name: "s1", type: "skill" },
            { name: "a1", type: "agent" },
            { name: "cmd1", type: "command" },
            { name: "rule1", type: "rule" },
          ],
          available: [],
        })
        vi.mocked(resourceProvisioner.provision).mockResolvedValue({
          provisioned: 4,
          failed: [],
          byType: { skill: 1, agent: 1, command: 1, rule: 1 },
        })

        const result = await phase.run(createOptions({ workflow }))

        expect(result.status).toBe("completed")
        expect(result.cloneErrors).toHaveLength(0)
        expect(result.skillsCopied).toBe(1)
        expect(result.agentsCopied).toBe(1)
        expect(result.commandsCopied).toBe(1)
        expect(result.rulesCopied).toBe(1)
      } finally {
        // Clean up
        try { fs.rmSync(cloneDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })
  })

  describe("byType counter usage", () => {
    it("uses byType from provisioner result instead of ratio estimation", async () => {
      vi.mocked(resourcePreflight.analyze).mockReturnValue({
        agents: ["a1"],
        skills: ["s1"],
        commands: [],
        rules: [],
      })
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [
          { name: "s1", type: "skill" },
          { name: "a1", type: "agent" },
        ],
        available: [],
      })
      // byType says only 1 skill succeeded, agent failed
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({
        provisioned: 1,
        failed: ["agent:a1 — not found"],
        byType: { skill: 1 },
      })

      const result = await phase.run(createOptions())

      expect(result.skillsCopied).toBe(1)
      expect(result.agentsCopied).toBe(0) // not estimated from ratio
      expect(result.status).toBe("failed") // provision had failures
    })
  })

  describe("error logging", () => {
    it("captures and logs error message from unexpected exceptions", async () => {
      // Force an unexpected error in the provisioning path
      vi.mocked(resourcePreflight.analyze).mockImplementation(() => {
        throw new Error("unexpected permission denied")
      })

      const result = await phase.run(createOptions())

      expect(result.status).toBe("failed")
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("unexpected permission denied"),
      )
    })
  })

  describe("EngineInitResult shape", () => {
    it("includes commandsCopied, rulesCopied, and cloneErrors in result", async () => {
      const result = await phase.run(createOptions())

      expect(result).toHaveProperty("commandsCopied")
      expect(result).toHaveProperty("rulesCopied")
      expect(result).toHaveProperty("cloneErrors")
      expect(result.commandsCopied).toBe(0)
      expect(result.rulesCopied).toBe(0)
      expect(result.cloneErrors).toEqual([])
    })
  })
})
