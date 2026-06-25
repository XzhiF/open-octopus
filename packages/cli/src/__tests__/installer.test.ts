import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Installer, CORE_SKILLS, CORE_AGENTS } from "../installer"
import { VERSION } from "@octopus/shared"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-install-test-"))

describe("Installer", () => {
  let testDir: string
  let mockCorePackDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "test-"))
    mockCorePackDir = mkdtempSync(join(baseTmpDir, "corepack-"))

    mkdirSync(join(mockCorePackDir, "skills"), { recursive: true })
    mkdirSync(join(mockCorePackDir, "agents"), { recursive: true })
    mkdirSync(join(mockCorePackDir, "scripts"), { recursive: true })
    mkdirSync(join(mockCorePackDir, "config"), { recursive: true })
    mkdirSync(join(mockCorePackDir, "presets", "standard", "mcp"), {
      recursive: true,
    })

    for (const skill of CORE_SKILLS) {
      mkdirSync(join(mockCorePackDir, "skills", skill), { recursive: true })
      writeFileSync(
        join(mockCorePackDir, "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\n---\n`,
        "utf-8",
      )
    }

    for (const agent of CORE_AGENTS) {
      writeFileSync(
        join(mockCorePackDir, "agents", `${agent}.md.tpl`),
        `# ${agent}\norg: {org}\nprefix: {prefix}\norg_dir: {org_dir}\n`,
        "utf-8",
      )
    }

    mkdirSync(join(mockCorePackDir, "scripts", "skill_search"), {
      recursive: true,
    })
    writeFileSync(
      join(mockCorePackDir, "scripts", "skill_search", "search.py"),
      "# search script",
      "utf-8",
    )

    writeFileSync(
      join(mockCorePackDir, "presets", "standard", "mcp", "mcp_prod.yaml"),
      "servers:\n  - name: test-service\n",
      "utf-8",
    )

    writeFileSync(
      join(mockCorePackDir, "config", "project_config.yaml.tpl"),
      "# project config\norg: {org}\n{commented_global_fields}\n",
      "utf-8",
    )

    writeFileSync(
      join(mockCorePackDir, "config", "user_preference.md.tpl"),
      "# user preferences template\n",
      "utf-8",
    )
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(baseTmpDir, { recursive: true, force: true })
  })

  function createInstaller(
    targetDir: string,
    org: string,
    force = false,
    corePackDir?: string,
  ): Installer {
    const installer = new Installer(targetDir, org, force)
    installer["corePackPath"] = corePackDir || mockCorePackDir
    return installer
  }

  it("creates .octopus directory", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    expect(existsSync(join(testDir, ".octopus"))).toBe(true)
  })

  it("creates .claude/skills directory", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    expect(existsSync(join(testDir, ".claude", "skills"))).toBe(true)
  })

  it("creates .claude/agents directory", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    expect(existsSync(join(testDir, ".claude", "agents"))).toBe(true)
  })

  it("creates manifest.json with version", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const manifest = JSON.parse(
      readFileSync(join(testDir, ".octopus", "manifest.json"), "utf-8"),
    )
    expect(manifest.version).toBe(VERSION)
    expect(typeof manifest.installed_at).toBe("string")
  })

  it("manifest records installed skills", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const manifest = JSON.parse(
      readFileSync(join(testDir, ".octopus", "manifest.json"), "utf-8"),
    )
    const skillNames = Object.keys(manifest.skills)
    expect(skillNames.length).toBe(CORE_SKILLS.length)
    for (const name of CORE_SKILLS) {
      expect(manifest.skills[name]).toBeDefined()
      expect(manifest.skills[name].source).toBe("core_pack")
    }
  })

  it("manifest records installed agents", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const manifest = JSON.parse(
      readFileSync(join(testDir, ".octopus", "manifest.json"), "utf-8"),
    )
    const agentNames = Object.keys(manifest.agents)
    expect(agentNames.length).toBe(CORE_AGENTS.length)
  })

  it("generates agent .md files from .md.tpl templates replacing {org}", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    for (const agent of CORE_AGENTS) {
      const agentFile = join(testDir, ".claude", "agents", `${agent}.md`)
      expect(existsSync(agentFile)).toBe(true)
      const content = readFileSync(agentFile, "utf-8")
      expect(content).not.toContain("{org}")
      expect(content).toContain("org: xzf")
      expect(content).not.toContain("{prefix}")
      expect(content).not.toContain("{org_dir}")
    }
  })

  it("copies core skills into .claude/skills/", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    for (const skill of CORE_SKILLS) {
      const skillDir = join(testDir, ".claude", "skills", skill)
      expect(existsSync(skillDir)).toBe(true)
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true)
    }
  })

  it("installs scripts into .octopus/scripts/", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const scriptsDir = join(testDir, ".octopus", "scripts")
    expect(existsSync(scriptsDir)).toBe(true)
    expect(existsSync(join(scriptsDir, "skill_search"))).toBe(true)
  })

  it("registers MCP YAML from presets into org mcp dir", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const mcpDir = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".octopus",
      "xzf",
      "mcp",
    )
    if (existsSync(mcpDir)) {
      const yamlFiles = readdirSync(mcpDir).filter((f) =>
        f.endsWith(".yaml"),
      )
      expect(yamlFiles.length).toBeGreaterThan(0)
    }
  })

  it("creates config.yaml", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const configPath = join(testDir, ".octopus", "config.yaml")
    expect(existsSync(configPath)).toBe(true)
    const content = readFileSync(configPath, "utf-8")
    expect(content).toContain("org: xzf")
  })

  it("creates org subdirectories in global dir", () => {
    const installer = createInstaller(testDir, "xzf")
    installer.run()
    const orgDir = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".octopus",
      "xzf",
    )
    const expectedSubdirs = [
      "env",
      "mcp",
      "repos",
      "repos/projects",
      "evolution",
      "evolution/experiences",
      "config",
    ]
    for (const subdir of expectedSubdirs) {
      if (existsSync(orgDir)) {
        expect(existsSync(join(orgDir, subdir))).toBe(true)
      }
    }
  })

  it("throws error when .octopus exists without force", () => {
    mkdirSync(join(testDir, ".octopus"), { recursive: true })
    const installer = createInstaller(testDir, "xzf", false)
    expect(() => installer.run()).toThrow(".octopus/ exists")
  })

  it("succeeds with force when .octopus exists", () => {
    mkdirSync(join(testDir, ".octopus"), { recursive: true })
    const installer = createInstaller(testDir, "xzf", true)
    expect(() => installer.run()).not.toThrow()
  })

  it("throws error when org is empty", () => {
    const installer = createInstaller(testDir, "")
    expect(() => installer.run()).toThrow("org required")
  })

  it("handles missing core_pack gracefully (empty output)", () => {
    const installer = createInstaller(testDir, "xzf", true)
    installer["corePackPath"] = "/nonexistent/path"
    installer.run()
    expect(existsSync(join(testDir, ".octopus"))).toBe(true)
    expect(existsSync(join(testDir, ".octopus", "manifest.json"))).toBe(true)
    const skillsDir = join(testDir, ".claude", "skills")
    if (existsSync(skillsDir)) {
      expect(readdirSync(skillsDir).length).toBe(0)
    }
  })

  it("CORE_SKILLS has expected entries", () => {
    expect(CORE_SKILLS).toContain("octo-skill-creator")
    expect(CORE_SKILLS).toContain("octo-skill-evolution")
    expect(CORE_SKILLS).toContain("octo-guide")
  })

  it("CORE_AGENTS has expected entries", () => {
    expect(CORE_AGENTS).toContain("mcp-discoverer")
    expect(CORE_AGENTS).toContain("skill-searcher")
    expect(CORE_AGENTS).toContain("skill-evaluator")
    expect(CORE_AGENTS).toContain("repo-knowledge")
    expect(CORE_AGENTS).toContain("env-discoverer")
  })
})