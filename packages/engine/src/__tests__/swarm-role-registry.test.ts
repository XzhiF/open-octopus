import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { RoleRegistry } from "../executors/swarm/role-registry"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("RoleRegistry", () => {
  let tmpDirs: string[] = []

  function createTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "role-registry-test-"))
    tmpDirs.push(dir)
    return dir
  }

  function writeAgentFile(dir: string, filename: string, frontmatter: Record<string, string>, body = ""): void {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n")
    const content = `---\n${fm}\n---\n\n${body}`
    writeFileSync(join(dir, filename), content, "utf-8")
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tmpDirs = []
  })

  it("loads index from a directory of agent files", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "coder.md", {
      name: "coder",
      description: "Writes code",
      category: "engineering",
    }, "# Coder\nI write code.")

    writeAgentFile(dir, "tester.md", {
      name: "tester",
      description: "Writes tests",
      category: "testing",
    })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.list()).toHaveLength(2)
    expect(registry.list().map(r => r.name).sort()).toEqual(["coder", "tester"])
  })

  it("resolves a role with lazy-loaded body", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "coder.md", {
      name: "coder",
      description: "Writes code",
      category: "engineering",
    }, "# Coder Body\nDetailed instructions here.")

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    const role = registry.resolve("coder")
    expect(role).not.toBeNull()
    expect(role!.name).toBe("coder")
    expect(role!.body).toContain("# Coder Body")
    expect(role!.body).toContain("Detailed instructions here.")
  })

  it("returns null for unknown roles", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "coder.md", {
      name: "coder",
      description: "Writes code",
      category: "engineering",
    })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.resolve("nonexistent")).toBeNull()
  })

  it("skips files missing required frontmatter", async () => {
    const dir = createTmpDir()

    // Valid file
    writeAgentFile(dir, "good.md", {
      name: "good-role",
      description: "Good",
      category: "engineering",
    })

    // Missing description
    const badContent = `---\nname: "bad-role"\ncategory: "engineering"\n---\n`
    writeFileSync(join(dir, "bad.md"), badContent, "utf-8")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe("good-role")
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it("higher-priority source takes precedence", async () => {
    const customDir = join(createTmpDir(), ".claude", "agents")
    mkdirSync(customDir, { recursive: true })
    const orgDir = createTmpDir()

    writeAgentFile(customDir, "coder.md", {
      name: "coder",
      description: "Custom coder (high priority)",
      category: "engineering",
    })

    writeAgentFile(orgDir, "coder.md", {
      name: "coder",
      description: "Org coder (lower priority)",
      category: "engineering",
    })

    // custom first (higher priority), then org
    const registry = new RoleRegistry([customDir, orgDir])
    await registry.loadIndex()

    const roles = registry.list()
    expect(roles).toHaveLength(1)
    expect(roles[0].description).toBe("Custom coder (high priority)")
    expect(roles[0].source).toBe("custom")
  })

  it("searches by name and description (case insensitive)", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "architect.md", {
      name: "system-architect",
      description: "Designs system architecture",
      category: "engineering",
    })
    writeAgentFile(dir, "tester.md", {
      name: "qa-tester",
      description: "Runs quality assurance tests",
      category: "testing",
    })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.search("architect")).toHaveLength(1)
    expect(registry.search("ARCHITECT")).toHaveLength(1)
    expect(registry.search("tests")).toHaveLength(1)
    expect(registry.search("nonexistent")).toHaveLength(0)
  })

  it("handles Chinese search queries", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "dev.md", {
      name: "developer",
      description: "全栈开发工程师",
      category: "engineering",
    })
    writeAgentFile(dir, "pm.md", {
      name: "product-manager",
      description: "产品经理",
      category: "management",
    })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.search("工程师")).toHaveLength(1)
    expect(registry.search("产品")).toHaveLength(1)
  })

  it("resolveMany returns only valid roles", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "a.md", { name: "a", description: "A", category: "x" }, "body-a")
    writeAgentFile(dir, "b.md", { name: "b", description: "B", category: "x" }, "body-b")

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    const resolved = registry.resolveMany(["a", "b", "missing"])
    expect(resolved).toHaveLength(2)
    expect(resolved.map(r => r.name).sort()).toEqual(["a", "b"])
  })

  it("listByCategory groups roles correctly", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "eng1.md", { name: "eng1", description: "E1", category: "engineering" })
    writeAgentFile(dir, "eng2.md", { name: "eng2", description: "E2", category: "engineering" })
    writeAgentFile(dir, "test1.md", { name: "test1", description: "T1", category: "testing" })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    const groups = registry.listByCategory()
    expect(Object.keys(groups).sort()).toEqual(["engineering", "testing"])
    expect(groups["engineering"]).toHaveLength(2)
    expect(groups["testing"]).toHaveLength(1)
  })

  it("scans subdirectories recursively", async () => {
    const dir = createTmpDir()
    const sub = join(dir, "sub")
    mkdirSync(sub)

    writeAgentFile(dir, "top.md", { name: "top", description: "Top level", category: "a" })
    writeAgentFile(sub, "nested.md", { name: "nested", description: "Nested", category: "b" })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    expect(registry.list()).toHaveLength(2)
  })

  it("parses capabilities from comma-separated frontmatter", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "dev.md", {
      name: "dev",
      description: "Developer",
      category: "engineering",
      capabilities: "coding,testing,review",
    })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    const role = registry.resolve("dev")
    expect(role!.capabilities).toEqual(["coding", "testing", "review"])
  })

  it("handles nonexistent base paths gracefully", async () => {
    const registry = new RoleRegistry(["/nonexistent/path/that/doesnt/exist"])
    await registry.loadIndex()
    expect(registry.list()).toHaveLength(0)
  })

  it("loadIndex is idempotent", async () => {
    const dir = createTmpDir()
    writeAgentFile(dir, "a.md", { name: "a", description: "A", category: "x" })

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()
    expect(registry.list()).toHaveLength(1)

    // Second call should not re-scan (even if we add files)
    writeAgentFile(dir, "b.md", { name: "b", description: "B", category: "x" })
    await registry.loadIndex()
    expect(registry.list()).toHaveLength(1) // still 1, not 2
  })

  it("infers source from path", async () => {
    const customDir = join(createTmpDir(), ".claude", "agents")
    mkdirSync(customDir, { recursive: true })
    const agencyDir = join(createTmpDir(), "agency-agents-zh", "engineering")
    mkdirSync(agencyDir, { recursive: true })
    const orgDir = createTmpDir()

    writeAgentFile(customDir, "c.md", { name: "custom-role", description: "C", category: "x" })
    writeAgentFile(agencyDir, "a.md", { name: "agency-role", description: "A", category: "x" })
    writeAgentFile(orgDir, "o.md", { name: "org-role", description: "O", category: "x" })

    const registry = new RoleRegistry([customDir, orgDir, agencyDir])
    await registry.loadIndex()

    const roles = registry.list()
    const byName = Object.fromEntries(roles.map(r => [r.name, r]))

    expect(byName["custom-role"].source).toBe("custom")
    expect(byName["agency-role"].source).toBe("agency-agents-zh")
    expect(byName["org-role"].source).toBe("org")
  })

  // TC-041: Custom role in .claude/agents/ is loaded with source "custom"
  it("TC-041: custom role in .claude/agents/ loaded with source=custom and resolves correctly", async () => {
    const customDir = join(createTmpDir(), ".claude", "agents")
    mkdirSync(customDir, { recursive: true })

    writeAgentFile(customDir, "my-expert.md", {
      name: "my-expert",
      description: "自定义专家角色",
      category: "engineering",
      capabilities: "coding,review",
    }, "# My Expert\nCustom expert instructions here.")

    const registry = new RoleRegistry([customDir])
    await registry.loadIndex()

    const roles = registry.list()
    expect(roles).toHaveLength(1)
    expect(roles[0].name).toBe("my-expert")
    expect(roles[0].source).toBe("custom")
    expect(roles[0].description).toBe("自定义专家角色")
    expect(roles[0].category).toBe("engineering")

    // Verify resolve also returns source=custom
    const resolved = registry.resolve("my-expert")
    expect(resolved).not.toBeNull()
    expect(resolved!.source).toBe("custom")
    expect(resolved!.body).toContain("Custom expert instructions here.")
  })

  // TC-042: Frontmatter missing description -> skip with warning
  it("TC-042: frontmatter missing description is skipped with console.warn", async () => {
    const dir = createTmpDir()

    // Valid file
    writeAgentFile(dir, "valid.md", {
      name: "valid-role",
      description: "A valid role",
      category: "engineering",
    })

    // Missing description — only name and category
    const badContent = `---\nname: "no-desc-role"\ncategory: "testing"\n---\n# No Desc\n`
    writeFileSync(join(dir, "no-desc.md"), badContent, "utf-8")

    // Missing category — only name and description
    const badContent2 = `---\nname: "no-cat-role"\ndescription: "Missing category"\n---\n# No Cat\n`
    writeFileSync(join(dir, "no-cat.md"), badContent2, "utf-8")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const registry = new RoleRegistry([dir])
    await registry.loadIndex()

    // Missing category is OK — category is inferred from directory structure
    // Only the file missing description should be skipped
    const roles = registry.list()
    expect(roles).toHaveLength(2)
    const validRole = roles.find(r => r.name === "valid-role")
    expect(validRole).toBeDefined()
    const noCatRole = roles.find(r => r.name === "no-cat-role")
    expect(noCatRole).toBeDefined()
    expect(noCatRole?.category).toBe("uncategorized") // inferred

    // Only the file missing description should trigger a warning
    const warnCalls = warnSpy.mock.calls.map(c => c.join(" "))
    expect(warnCalls.some(msg => msg.includes("no-desc.md"))).toBe(true)

    warnSpy.mockRestore()
  })
})
