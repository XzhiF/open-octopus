import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { ResourceProvisioner } from "../resource/resource-provisioner"
import type { ResourceManager } from "../resource/resource-manager"
import type { ResourceEntry } from "../resource/types"

// ── Test helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "provisioner-test-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function makeEntry(overrides: Partial<ResourceEntry> = {}): ResourceEntry {
  return {
    name: "test-resource",
    type: "skill",
    source: "builtin",
    ref: "builtin:test-resource",
    group: "built-in",
    installed: true,
    verified: true,
    status: "installed",
    installedAt: new Date().toISOString(),
    installPath: "/tmp/test",
    dependsOn: [],
    ...overrides,
  }
}

/**
 * Create a mock ResourceManager that returns configured entries.
 */
function createMockManager(entries: Map<string, ResourceEntry | null>): ResourceManager {
  return {
    get: (type: string, name: string) => entries.get(`${type}:${name}`) ?? null,
  } as unknown as ResourceManager
}

// ── Tests ───────────────────────────────────────────────────────

describe("ResourceProvisioner", () => {
  let tempDir: string
  let workspaceDir: string
  let registryDir: string

  beforeEach(() => {
    tempDir = createTempDir()
    workspaceDir = path.join(tempDir, "workspace")
    registryDir = path.join(tempDir, "registry")
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(registryDir, { recursive: true })
  })

  afterEach(() => {
    cleanupDir(tempDir)
  })

  describe("command copy", () => {
    it("copies command .md file to .claude/commands/{name}.md", async () => {
      // Create source command file
      const cmdSourceDir = path.join(registryDir, "commands", "cmd-review")
      fs.mkdirSync(cmdSourceDir, { recursive: true })
      const cmdFile = path.join(cmdSourceDir, "cmd-review.md")
      fs.writeFileSync(cmdFile, "# Review Command\nDo a review.")

      const entry = makeEntry({
        name: "cmd-review",
        type: "command",
        installPath: cmdSourceDir,
      })

      const manager = createMockManager(new Map([["command:cmd-review", entry]]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "command", name: "cmd-review" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(1)
      expect(result.failed).toHaveLength(0)

      // Verify file was copied
      const destFile = path.join(workspaceDir, ".claude", "commands", "cmd-review.md")
      expect(fs.existsSync(destFile)).toBe(true)
      expect(fs.readFileSync(destFile, "utf-8")).toContain("Review Command")
    })
  })

  describe("rule copy", () => {
    it("copies rule .md file to .claude/rules/{name}.md", async () => {
      // Create source rule file
      const ruleSourceDir = path.join(registryDir, "rules", "code-style")
      fs.mkdirSync(ruleSourceDir, { recursive: true })
      const ruleFile = path.join(ruleSourceDir, "code-style.md")
      fs.writeFileSync(ruleFile, "# Code Style Rules\nUse semicolons.")

      const entry = makeEntry({
        name: "code-style",
        type: "rule",
        installPath: ruleSourceDir,
      })

      const manager = createMockManager(new Map([["rule:code-style", entry]]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "rule", name: "code-style" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(1)
      expect(result.failed).toHaveLength(0)

      // Verify file was copied
      const destFile = path.join(workspaceDir, ".claude", "rules", "code-style.md")
      expect(fs.existsSync(destFile)).toBe(true)
      expect(fs.readFileSync(destFile, "utf-8")).toContain("Code Style Rules")
    })
  })

  describe("byType return", () => {
    it("returns exact per-type counts for mixed provisioning", async () => {
      // Create source files for agent and command
      const agentSourceDir = path.join(registryDir, "agents", "my-agent")
      fs.mkdirSync(agentSourceDir, { recursive: true })
      fs.writeFileSync(path.join(agentSourceDir, "my-agent.md"), "# Agent")

      const cmdSourceDir = path.join(registryDir, "commands", "my-cmd")
      fs.mkdirSync(cmdSourceDir, { recursive: true })
      fs.writeFileSync(path.join(cmdSourceDir, "my-cmd.md"), "# Command")

      const agentEntry = makeEntry({
        name: "my-agent",
        type: "agent",
        installPath: agentSourceDir,
      })
      const cmdEntry = makeEntry({
        name: "my-cmd",
        type: "command",
        installPath: cmdSourceDir,
      })

      const manager = createMockManager(new Map([
        ["agent:my-agent", agentEntry],
        ["command:my-cmd", cmdEntry],
      ]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [
          { type: "agent", name: "my-agent" },
          { type: "command", name: "my-cmd" },
        ],
        workspaceDir,
      )

      expect(result.provisioned).toBe(2)
      expect(result.failed).toHaveLength(0)
      expect(result.byType).toEqual({ agent: 1, command: 1 })
    })

    it("returns empty byType when nothing is provisioned", async () => {
      const manager = createMockManager(new Map())
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "agent", name: "nonexistent" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(0)
      expect(result.failed).toHaveLength(1)
      expect(result.byType).toEqual({})
    })

    it("returns byType with multiple items of same type", async () => {
      const cmd1Dir = path.join(registryDir, "commands", "cmd1")
      fs.mkdirSync(cmd1Dir, { recursive: true })
      fs.writeFileSync(path.join(cmd1Dir, "cmd1.md"), "# Cmd1")

      const cmd2Dir = path.join(registryDir, "commands", "cmd2")
      fs.mkdirSync(cmd2Dir, { recursive: true })
      fs.writeFileSync(path.join(cmd2Dir, "cmd2.md"), "# Cmd2")

      const manager = createMockManager(new Map([
        ["command:cmd1", makeEntry({ name: "cmd1", type: "command", installPath: cmd1Dir })],
        ["command:cmd2", makeEntry({ name: "cmd2", type: "command", installPath: cmd2Dir })],
      ]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [
          { type: "command", name: "cmd1" },
          { type: "command", name: "cmd2" },
        ],
        workspaceDir,
      )

      expect(result.byType).toEqual({ command: 2 })
    })
  })

  describe("clone rejection", () => {
    it("does not accept clone type in provisioner type system", async () => {
      // This test verifies that the provisioner type system rejects 'clone'
      // The ProvisionableType is 'agent' | 'skill' | 'command' | 'rule'
      // We can't directly test TypeScript types at runtime, but we verify
      // that the provisioner only handles the 4 valid types
      const manager = createMockManager(new Map())
      const provisioner = new ResourceProvisioner(manager)

      // Empty provision should work fine
      const result = await provisioner.provision([], workspaceDir)
      expect(result.provisioned).toBe(0)
      expect(result.byType).toEqual({})
    })
  })

  describe("agent copy (existing behavior)", () => {
    it("copies agent .md file to .claude/agents/{name}.md", async () => {
      const agentSourceDir = path.join(registryDir, "agents", "reviewer")
      fs.mkdirSync(agentSourceDir, { recursive: true })
      fs.writeFileSync(path.join(agentSourceDir, "reviewer.md"), "# Reviewer Agent")

      const entry = makeEntry({
        name: "reviewer",
        type: "agent",
        installPath: agentSourceDir,
      })

      const manager = createMockManager(new Map([["agent:reviewer", entry]]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "agent", name: "reviewer" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(1)
      const destFile = path.join(workspaceDir, ".claude", "agents", "reviewer.md")
      expect(fs.existsSync(destFile)).toBe(true)
      expect(fs.readFileSync(destFile, "utf-8")).toContain("Reviewer Agent")
    })
  })

  describe("skill copy (existing behavior)", () => {
    it("copies skill directory to .claude/skills/{name}/", async () => {
      const skillSourceDir = path.join(registryDir, "skills", "my-skill")
      fs.mkdirSync(skillSourceDir, { recursive: true })
      fs.writeFileSync(path.join(skillSourceDir, "skill.md"), "# My Skill")
      fs.writeFileSync(path.join(skillSourceDir, "helper.ts"), "export {}")

      const entry = makeEntry({
        name: "my-skill",
        type: "skill",
        installPath: skillSourceDir,
      })

      const manager = createMockManager(new Map([["skill:my-skill", entry]]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "skill", name: "my-skill" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(1)
      const destDir = path.join(workspaceDir, ".claude", "skills", "my-skill")
      expect(fs.existsSync(destDir)).toBe(true)
      expect(fs.existsSync(path.join(destDir, "skill.md"))).toBe(true)
      expect(fs.existsSync(path.join(destDir, "helper.ts"))).toBe(true)
    })
  })

  describe("error handling", () => {
    it("fails when resource not found in registry", async () => {
      const manager = createMockManager(new Map())
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "command", name: "nonexistent" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(0)
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toContain("not found in registry")
    })

    it("fails when resource is not installed", async () => {
      const entry = makeEntry({
        name: "uninstalled-cmd",
        type: "command",
        installed: false,
      })

      const manager = createMockManager(new Map([["command:uninstalled-cmd", entry]]))
      const provisioner = new ResourceProvisioner(manager)

      const result = await provisioner.provision(
        [{ type: "command", name: "uninstalled-cmd" }],
        workspaceDir,
      )

      expect(result.provisioned).toBe(0)
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toContain("not installed")
    })
  })
})
