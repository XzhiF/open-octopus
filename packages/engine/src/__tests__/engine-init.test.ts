import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { EngineInitPhase } from "../engine-init"
import type { EngineInitOptions, GitOpsLike, ResourcePreFlightLike, ResourceProvisionerLike } from "../engine-init"
import type { EngineCallbacks } from "../engine"
import { IdentityResolver } from "../executors/identity-resolver"
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

  describe("as: execution-identity L3 hard gate (ticket 10)", () => {
    // Fake HOME fixture: identity resolution happens against a tmpdir clone
    // tree, never the real ~/.octopus (identity-resolver.test.ts pattern).
    const mkHome = () => mkdtempSync(join(tmpdir(), "engine-init-as-gate-"))
    const homes: string[] = []
    const fakeHome = () => { const h = mkHome(); homes.push(h); return h }
    function writeIdentityDir(home: string, kind: "built-in" | "clones", name: string): void {
      mkdirSync(join(home, ".octopus", "agent", kind, name), { recursive: true })
      writeFileSync(join(home, ".octopus", "agent", kind, name, "persona.md"), "# fixture persona", "utf-8")
    }
    afterEach(() => {
      while (homes.length > 0) {
        const h = homes.pop()
        if (h) rmSync(h, { recursive: true, force: true })
      }
    })

    it("rejects engine-init when a node's as: target is unresolvable", async () => {
      workflow = {
        ...workflow,
        nodes: [{ id: "implement", type: "agent", as: "ghost-clone-404", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("failed")
      expect(result.identityErrors).toHaveLength(1)
      expect(result.identityErrors[0]).toContain("ghost-clone-404")
      expect(result.identityErrors[0]).toContain("implement") // names the offending node
      expect(result.identityErrors[0]).toContain("not resolvable")
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("[ERROR]"),
      )
    })

    it("blocks provisioning when the as-gate fails (provisioner not called)", async () => {
      workflow = {
        ...workflow,
        requires: { skills: ["s1"] },
        nodes: [{ id: "implement", type: "agent", as: "ghost-clone-404", prompt: "x" }],
      } as WorkflowDef
      vi.mocked(resourcePreflight.check).mockReturnValue({ missing: [{ name: "s1", type: "skill" }] })

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("failed")
      expect(resourceProvisioner.provision).not.toHaveBeenCalled()
    })

    it("proceeds when as: resolves from the built-in directory", async () => {
      const home = fakeHome()
      writeIdentityDir(home, "built-in", "workflow-operator")
      workflow = {
        ...workflow,
        nodes: [{ id: "operate", type: "agent", as: "workflow-operator", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(result.identityErrors).toHaveLength(0)
    })

    it("proceeds when as: resolves from the user clones directory", async () => {
      const home = fakeHome()
      writeIdentityDir(home, "clones", "feat-my-branch")
      workflow = {
        ...workflow,
        nodes: [{ id: "branchy", type: "agent", as: "feat-my-branch", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
    })

    it("scans loop-nested agent nodes for as: targets", async () => {
      workflow = {
        ...workflow,
        nodes: [{
          id: "outer", type: "loop", max_iterations: 2,
          nodes: [{ id: "inner", type: "agent", as: "ghost-loop-404", prompt: "x" }],
        }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("failed")
      expect(result.identityErrors[0]).toContain("ghost-loop-404")
      expect(result.identityErrors[0]).toContain("inner") // inner node id, not the loop id
    })

    it("is a no-op when no node declares as: — default workflow-operator is NOT gate-checked (graceful)", async () => {
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }, { id: "b", type: "bash", bash: "echo 1" }],
      } as WorkflowDef

      // Empty-home resolver: workflow-operator absent — yet init must proceed,
      // existing workflows never break because the default clone is missing.
      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("completed")
      expect(result.identityErrors).toHaveLength(0)
    })

    it("reports one error per unresolvable as: site", async () => {
      workflow = {
        ...workflow,
        nodes: [
          { id: "n1", type: "agent", as: "ghost-a", prompt: "x" },
          { id: "n2", type: "agent", as: "ghost-a", prompt: "y" },
        ],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.identityErrors).toHaveLength(2)
      expect(result.identityErrors[0]).toContain("n1")
      expect(result.identityErrors[1]).toContain("n2")
    })

    it("without an injected resolver falls back to the real-home directory probe (clone-gate style)", async () => {
      const ghost = `engine-init-gate-ghost-${process.pid}-${Date.now()}`
      workflow = {
        ...workflow,
        nodes: [{ id: "implement", type: "agent", as: ghost, prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({ workflow }))

      expect(result.status).toBe("failed")
      expect(result.identityErrors[0]).toContain(ghost)
    })

    // ── review fix #5: as: 钉版本（story 25）过 L1 后，L3 闸语义 ──────────
    it("accepts a pinned as: target that resolves by name via the fs fallback", async () => {
      const home = fakeHome()
      writeIdentityDir(home, "built-in", "workflow-operator")
      workflow = {
        ...workflow,
        nodes: [{ id: "operate", type: "agent", as: "workflow-operator@1.2.0", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(result.identityErrors).toHaveLength(0)
    })

    it("names the bare clone (no @pin) in the install hint for an unresolvable pinned ref", async () => {
      workflow = {
        ...workflow,
        nodes: [{ id: "implement", type: "agent", as: "ghost-clone@1.2.0", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("failed")
      expect(result.identityErrors[0]).toContain("ghost-clone@1.2.0") // 站点原样可追溯
      expect(result.identityErrors[0]).toContain("install builtin:ghost-clone --type clone") // 提示不带 pin
    })
  })

  // ── D2（review fix #2，e2e-report 缺陷 D2）：无 `skills:` 声明的 agent 节点
  // 必须把已解析身份的 snapshot.skills 并进 provisioning analyze 集 ——
  // 缺省 workflow-operator / as: 目标分身都要在 workspace .claude/skills 里
  // 见到技能文件（ADR-0006 原生发现：文件物化 → SDK 发现，绝不走 prompt 文本）。
  describe("identity snapshot.skills provisioning merge — D2 (review fix #2)", () => {
    const mkHome = () => mkdtempSync(join(tmpdir(), "engine-init-d2-"))
    const homes: string[] = []
    const fakeHome = () => { const h = mkHome(); homes.push(h); return h }
    /** built-in 分身目录含 skills/（IdentityResolver fs 形态 = snapshot.skills） */
    function writeIdentityWithSkills(home: string, name: string, skills: string[]): void {
      const dir = join(home, ".octopus", "agent", "built-in", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "persona.md"), "# d2 persona", "utf-8")
      for (const s of skills) {
        mkdirSync(join(dir, "skills", s), { recursive: true })
        writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\nbody`, "utf-8")
      }
    }
    afterEach(() => {
      while (homes.length > 0) {
        const h = homes.pop()
        if (h) rmSync(h, { recursive: true, force: true })
      }
    })

    const checkManifestAt = (i = 0): { skills: string[] } =>
      vi.mocked(resourcePreflight.check).mock.calls[i][0] as unknown as { skills: string[] }

    it("default-operator node without skills: declaration still provisions snapshot.skills (octo-wiki)", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "workflow-operator", ["octo-wiki"])
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toContain("octo-wiki")
    })

    it("as:-targeted identity skills are merged (archive → octo-archive-analyst + octo-wiki)", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "archive", ["octo-archive-analyst", "octo-wiki"])
      workflow = {
        ...workflow,
        nodes: [{ id: "analyze", type: "agent", as: "archive", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toEqual(expect.arrayContaining(["octo-archive-analyst", "octo-wiki"]))
    })

    it("loop-nested agent nodes count toward the identity skills merge", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "workflow-operator", ["octo-wiki"])
      workflow = {
        ...workflow,
        nodes: [{
          id: "outer", type: "loop", max_iterations: 1,
          nodes: [{ id: "inner", type: "agent", prompt: "x" }],
        }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toContain("octo-wiki")
    })

    it("dedupes: node-declared skill + identity skill unioned once", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "workflow-operator", ["octo-wiki"])
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x", skills: ["octo-wiki", "extra-skill"] }],
      } as WorkflowDef
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: ["octo-wiki", "extra-skill"], commands: [], rules: [] })

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      const skills = checkManifestAt(0).skills
      expect(skills).toEqual(["octo-wiki", "extra-skill"]) // 无重复、顺序稳定
    })

    it("missing default identity (empty home) degrades gracefully — no crash, scan stays empty", async () => {
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }],
      } as WorkflowDef
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: [], commands: [], rules: [] })

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: fakeHome() }),
      }))

      expect(result.status).toBe("completed")
      expect(result.identityErrors).toHaveLength(0)
      // 身份缺 → 合并集为空 → analyze 也没给资源 → totalResources 0 → 不进 check；关键是没炸
      expect(resourcePreflight.check).not.toHaveBeenCalled()
    })

    it("original analyze manifest object is not mutated by the merge", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "workflow-operator", ["octo-wiki"])
      const baseManifest = { agents: [], skills: [], commands: [], rules: [] }
      vi.mocked(resourcePreflight.analyze).mockReturnValue(baseManifest)
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }],
      } as WorkflowDef

      await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(baseManifest.skills).toEqual([]) // 合并走新对象，不改调用方持有值
      expect(checkManifestAt(0).skills).toContain("octo-wiki")
    })

    // ── D2 数据契约缺口修复（fix-verification addendum 点 2 = 运行时 FAIL）────────
    // 真实 runtime 形态：built-in 分身目录（clone-init-service 装机）只有
    // persona.md + config.json（顶层 skills 字段 = 票09 治理声明 → snapshot.config.skills），
    // 没有 skills/ 子目录 → snapshot.skills = []。上一轮修复只读 snapshot.skills，
    // 而单测自制 skills/ 目录过契约，导致全绿而运行时惰性（Analyzing resources: 0 skills）。
    // 以下测试全部按 runtime 形态布数据（config.json 声明、不预填 snapshot.skills）。

    /** clone-init-service 真实盘上形态：persona.md + config.json（顶层 skills），无 skills/ */
    function writeIdentityConfigOnly(home: string, name: string, declaredSkills: unknown): void {
      const dir = join(home, ".octopus", "agent", "built-in", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "persona.md"), "# d2 persona", "utf-8")
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        name,
        display_name: "d2 display",
        type: "built-in",
        skills: declaredSkills,
        memoryScope: "project",
        config: { model: "sonnet" },
        created_at: "2026-10-12T00:00:00.000Z",
      }), "utf-8")
    }

    it("RUNTIME-SHAPE: built-in identity with config.skills only (empty snapshot.skills, no skills/ dir) → merged into analyze set AND provisioned", async () => {
      const home = fakeHome()
      writeIdentityConfigOnly(home, "workflow-operator", ["octo-wiki"])
      vi.mocked(resourcePreflight.check).mockReturnValue({
        missing: [{ name: "octo-wiki", type: "skill" }],
        available: [],
      })
      vi.mocked(resourceProvisioner.provision).mockResolvedValue({ provisioned: 1, failed: [], byType: { skill: 1 } })
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }], // 无 skills:、无 as: —— 缺省 workflow-operator
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toContain("octo-wiki")
      expect(callbacks.onNodeLog).toHaveBeenCalledWith(
        "__engine_init__",
        expect.stringContaining("Identity skills merged into provisioning set: octo-wiki"),
      )
      // 文件物化经由既有 Provisioner 通道（ADR-0006 原生发现，非 prompt 文本）
      expect(resourceProvisioner.provision).toHaveBeenCalledWith(
        [{ name: "octo-wiki", type: "skill" }],
        "/workspace",
      )
      expect(result.skillsCopied).toBe(1)
    })

    it("RUNTIME-SHAPE: explicit as: workflow-operator WITHOUT node skills: still merges config.skills (verify_d1w 形态)", async () => {
      const home = fakeHome()
      writeIdentityConfigOnly(home, "workflow-operator", ["octo-wiki"])
      workflow = {
        ...workflow,
        nodes: [{ id: "explicit", type: "agent", as: "workflow-operator", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toContain("octo-wiki")
    })

    it("RUNTIME-SHAPE: union of BOTH identity sources — real skills/ dir AND config.skills, deduped across sources", async () => {
      const home = fakeHome()
      writeIdentityWithSkills(home, "task-doer", ["matt-e2e-test-methodology"]) // 目录形态 → snapshot.skills
      writeFileSync(join(home, ".octopus", "agent", "built-in", "task-doer", "config.json"), JSON.stringify({
        name: "task-doer",
        type: "built-in",
        skills: ["octo-dev-copilot", "matt-e2e-test-methodology", "octo-wiki"], // 含与目录重叠项 → 去重
        config: {},
      }), "utf-8")
      workflow = {
        ...workflow,
        nodes: [{ id: "do", type: "agent", as: "task-doer", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      const skills = checkManifestAt(0).skills
      expect(skills).toEqual(expect.arrayContaining(["matt-e2e-test-methodology", "octo-dev-copilot", "octo-wiki"]))
      expect(skills.filter((s) => s === "matt-e2e-test-methodology")).toHaveLength(1) // 双源重叠只出现一次
    })

    it("RUNTIME-SHAPE: node WITH explicit skills: declaration still provisions (regression, config-decl identity)", async () => {
      const home = fakeHome()
      writeIdentityConfigOnly(home, "workflow-operator", ["octo-wiki"])
      vi.mocked(resourcePreflight.analyze).mockReturnValue({ agents: [], skills: ["declared-skill"], commands: [], rules: [] })
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x", skills: ["declared-skill"] }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(checkManifestAt(0).skills).toEqual(expect.arrayContaining(["declared-skill", "octo-wiki"]))
    })

    it("RUNTIME-SHAPE: garbage config.skills (non-array) skipped gracefully — no crash, no merge", async () => {
      const home = fakeHome()
      writeIdentityConfigOnly(home, "workflow-operator", "octo-wiki") // string ≠ array
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(resourcePreflight.check).not.toHaveBeenCalled() // analyze 空 + 合并空 → totalResources 0
    })

    it("RUNTIME-SHAPE: variable refs inside config.skills are skipped at preflight", async () => {
      const home = fakeHome()
      writeIdentityConfigOnly(home, "workflow-operator", ["$vars.skill_name"])
      workflow = {
        ...workflow,
        nodes: [{ id: "legacy", type: "agent", prompt: "x" }],
      } as WorkflowDef

      const result = await phase.run(createOptions({
        workflow,
        identityResolver: new IdentityResolver({ homeDir: home }),
      }))

      expect(result.status).toBe("completed")
      expect(resourcePreflight.check).not.toHaveBeenCalled()
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
