import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SetupRunner } from "../setup-runner"
import { VERSION } from "@octopus/shared"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-setup-test-"))

describe("SetupRunner", () => {
  let testGlobalDir: string
  let testOrgDir: string
  let mockCorePackDir: string
  let mockPresetsDir: string

  beforeEach(() => {
    testGlobalDir = mkdtempSync(join(baseTmpDir, "global-"))
    testOrgDir = join(testGlobalDir, "xzf")
    mockCorePackDir = mkdtempSync(join(baseTmpDir, "corepack-"))
    mockPresetsDir = mkdtempSync(join(baseTmpDir, "presets-"))

    mkdirSync(join(mockCorePackDir, "config"), { recursive: true })
    mkdirSync(join(mockPresetsDir, "orgs", "xzf", "mcp"), { recursive: true })
    mkdirSync(join(mockPresetsDir, "orgs", "xzf", "env"), { recursive: true })
    mkdirSync(join(mockPresetsDir, "orgs", "standard", "mcp"), { recursive: true })
    mkdirSync(join(mockPresetsDir, "orgs", "standard", "env"), { recursive: true })

    writeFileSync(
      join(mockCorePackDir, "config", "global_config.yaml.tpl"),
      "default_org: {default_org}\n",
      "utf-8",
    )
    writeFileSync(
      join(mockCorePackDir, "config", "user_preference.md.tpl"),
      "# user preferences template\n",
      "utf-8",
    )
    writeFileSync(
      join(mockCorePackDir, "config", "setup_ignore.yaml.tpl"),
      "- repos/index.md\n- repos/projects**\n",
      "utf-8",
    )
    writeFileSync(
      join(mockPresetsDir, "orgs", "xzf", "mcp", "mcp_prod.yaml"),
      "servers:\n  - name: test-service\n",
      "utf-8",
    )
    writeFileSync(
      join(mockPresetsDir, "orgs", "xzf", "env", "database.md"),
      "## Database\n- host: localhost\n- port: 3306\n",
      "utf-8",
    )
    writeFileSync(
      join(mockPresetsDir, "orgs", "xzf", "manifest.md.tpl"),
      "# Project Manifest\n\n## xzf\n\n- test-project https://git.example.com/test.git\n",
      "utf-8",
    )
  })

  afterEach(() => {
    rmSync(testGlobalDir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(baseTmpDir, { recursive: true, force: true })
  })

  function createRunner(
    org: string,
    force = false,
    dryRun = false,
  ): SetupRunner {
    const runner = new SetupRunner(org, force, dryRun)
    runner["globalDir"] = testGlobalDir
    runner["orgDir"] = join(testGlobalDir, org)
    runner["corePackPath"] = mockCorePackDir
    runner["presetsPath"] = mockPresetsDir
    return runner
  }

  describe("basic setup", () => {
    it("creates global directory", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      expect(existsSync(testGlobalDir)).toBe(true)
    })

    it("creates org subdirectories", async () => {
      const runner = createRunner("xzf")
      await runner.run()
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
        expect(existsSync(join(testOrgDir, subdir))).toBe(true)
      }
    })

    it("creates global config.yaml", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      const configPath = join(testGlobalDir, "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      const content = readFileSync(configPath, "utf-8")
      expect(content).toContain("default_org: xzf")
    })

    it("creates .version file", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      const versionPath = join(testGlobalDir, ".version")
      expect(existsSync(versionPath)).toBe(true)
      expect(readFileSync(versionPath, "utf-8").trim()).toBe(VERSION)
    })

    it("skips existing config.yaml", async () => {
      writeFileSync(
        join(testGlobalDir, "config.yaml"),
        "default_org: other\n",
        "utf-8",
      )
      mkdirSync(testGlobalDir, { recursive: true })
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(join(testGlobalDir, "config.yaml"), "utf-8")
      expect(content).toContain("default_org: other")
    })
  })

  describe("org config", () => {
    it("creates org config.yaml from preset", async () => {
      writeFileSync(
        join(mockPresetsDir, "orgs", "xzf", "config.yaml.tpl"),
        "name: xzf\nprefix: my-\norg: {org}\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const configPath = join(testOrgDir, "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      expect(readFileSync(configPath, "utf-8")).toContain("org: xzf")
    })

    it("creates org config.yaml from standard preset fallback", async () => {
      writeFileSync(
        join(mockPresetsDir, "orgs", "standard", "config.yaml.tpl"),
        "name: {org}\nprefix: {org}-\n",
        "utf-8",
      )
      const runner = createRunner("neworg")
      runner["orgDir"] = join(testGlobalDir, "neworg")
      await runner.run()
      const configPath = join(testGlobalDir, "neworg", "config.yaml")
      expect(existsSync(configPath)).toBe(true)
    })

    it("creates fallback org config when no preset", async () => {
      const runner = createRunner("testorg")
      runner["orgDir"] = join(testGlobalDir, "testorg")
      runner["presetsPath"] = null
      await runner.run()
      const configPath = join(testGlobalDir, "testorg", "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      expect(readFileSync(configPath, "utf-8")).toContain("prefix: testorg-")
    })
  })

  describe("mcp registry", () => {
    it("copies MCP YAML from preset", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      const mcpDir = join(testOrgDir, "mcp")
      expect(existsSync(mcpDir)).toBe(true)
      expect(existsSync(join(mcpDir, "mcp_prod.yaml"))).toBe(true)
    })

    it("skips existing MCP YAML", async () => {
      mkdirSync(join(testOrgDir, "mcp"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "mcp", "mcp_prod.yaml"),
        "existing: true\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(
        join(testOrgDir, "mcp", "mcp_prod.yaml"),
        "utf-8",
      )
      expect(content).toContain("existing: true")
    })
  })

  describe("env files", () => {
    it("copies env file when target doesn't exist", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      expect(existsSync(join(testOrgDir, "env", "database.md"))).toBe(true)
    })

    it("merges env file when target exists", async () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "env", "database.md"),
        "## Database\n- host: myhost\n- port: 3306\n- custom_key: myvalue\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(
        join(testOrgDir, "env", "database.md"),
        "utf-8",
      )
      expect(content).toContain("host: myhost")
    })

    it("preserves user env header during merge", async () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "env", "database.md"),
        "# Database Config\n\n> Connection info\n\n## Database\n- host: myhost\n- port: 3306\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(
        join(testOrgDir, "env", "database.md"),
        "utf-8",
      )
      expect(content).toContain("# Database Config")
      expect(content).toContain("> Connection info")
      expect(content).toContain("host: myhost")
    })
  })

  describe("manifest handling", () => {
    it("creates manifest.md from template", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      const manifestPath = join(testOrgDir, "repos", "manifest.md")
      expect(existsSync(manifestPath)).toBe(true)
    })

    it("merges existing manifest.md with template", async () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "repos", "manifest.md"),
        "# existing manifest\n\n## group1\n\n- proj1 https://git.example.com/proj1.git\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(join(testOrgDir, "repos", "manifest.md"), "utf-8")
      expect(content).toContain("proj1")
      expect(content).toContain("test-project")
      const report = runner.getReport()
      expect(report.mergedFiles).toContain("xzf/repos/manifest.md")
    })

    it("preserves user manifest header during merge", async () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "repos", "manifest.md"),
        "# My Custom Manifest\n\n> My custom description\n\n## group1\n\n- proj1 https://git.example.com/proj1.git\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(join(testOrgDir, "repos", "manifest.md"), "utf-8")
      expect(content).toContain("# My Custom Manifest")
      expect(content).toContain("> My custom description")
      expect(content).not.toContain("# Project Manifest")
    })
  })

  describe("report tracking", () => {
    it("tracks new files in report", async () => {
      const runner = createRunner("xzf")
      await runner.run()
      const report = runner.getReport()
      expect(report.newFiles.length).toBeGreaterThan(0)
    })

    it("tracks skipped files in report", async () => {
      mkdirSync(join(testOrgDir, "mcp"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "mcp", "mcp_prod.yaml"),
        "existing: true\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const report = runner.getReport()
      expect(report.skippedFiles).toContain("xzf/mcp/mcp_prod.yaml")
    })
  })

  describe("dry-run mode", () => {
    it("does not create files in dry-run mode", async () => {
      const runner = createRunner("xzf", false, true)
      await runner.run()
      expect(existsSync(join(testGlobalDir, "config.yaml"))).toBe(false)
    })

    it("still creates global directory in dry-run mode (checkGlobalDir only logs)", async () => {
      const runner = createRunner("xzf", false, true)
      await runner.run()
      const report = runner.getReport()
      expect(report.newFiles.length).toBeGreaterThan(0)
    })
  })

  describe("env parsing and merging", () => {
    it("parseEnvMd extracts sections and keys", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "env", "test.md"),
        "## SectionA\n- key1: value1\n- key2: value2\n\n## SectionB\n- key3: value3\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      const { sections } = runner.parseEnvMd(join(testOrgDir, "env", "test.md"))
      expect(sections.SectionA).toBeDefined()
      expect(sections.SectionA.key1).toBe("value1")
      expect(sections.SectionA.key2).toBe("value2")
      expect(sections.SectionB.key3).toBe("value3")
    })

    it("parseEnvMd collects headerLines before first section", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "env", "test.md"),
        "# Database Config\n\n> Connection info\n\n## SectionA\n- key1: value1\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      const { sections, headerLines } = runner.parseEnvMd(join(testOrgDir, "env", "test.md"))
      expect(sections.SectionA).toBeDefined()
      expect(headerLines).toEqual(["# Database Config", "", "> Connection info", ""])
    })

    it("parseEnvMd preserves empty lines in header", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "env", "test.md"),
        "# Title\n\n> Description\n\n## SectionA\n- key1: value1\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      const { headerLines } = runner.parseEnvMd(join(testOrgDir, "env", "test.md"))
      expect(headerLines).toEqual(["# Title", "", "> Description", ""])
      expect(headerLines.some((l) => l.trim().startsWith("## "))).toBe(false)
    })

    it("mergeEnvSections user wins with conflict detection", () => {
      const runner = createRunner("xzf")
      const user = { DB: { host: "userhost", port: "3306" } }
      const template = { DB: { host: "templatehost", port: "3306", extra: "val" } }
      const { merged, conflicts } = runner.mergeEnvSections(user, template)
      expect(merged.DB.host).toBe("userhost")
      expect(merged.DB.extra).toBe("val")
      expect(conflicts.length).toBe(1)
      expect(conflicts[0].key).toBe("host")
    })
  })

  describe("manifest parsing and merging", () => {
    it("parseManifestMdFromString extracts entries", () => {
      const runner = createRunner("xzf")
      const { entries } = runner.parseManifestMdFromString(
        "# header\n\n## group1\n\n- proj1 https://git.example.com/proj1.git [dev]\n- proj2 https://git.example.com/proj2.git\n",
      )
      expect(entries.group1).toBeDefined()
      expect(entries.group1.length).toBe(2)
      expect(entries.group1[0].name).toBe("proj1")
      expect(entries.group1[0].branch).toBe("dev")
      expect(entries.group1[1].branch).toBe("master")
    })

    it("parseManifestMdFromString collects headerLines before first group", () => {
      const runner = createRunner("xzf")
      const { entries, headerLines } = runner.parseManifestMdFromString(
        "# Project Manifest\n\n> Manual project list\n\n## group1\n\n- proj1 https://git.example.com/proj1.git\n",
      )
      expect(entries.group1).toBeDefined()
      expect(headerLines).toEqual(["# Project Manifest", "", "> Manual project list", ""])
    })

    it("mergeManifestEntries supplements new entries from template", () => {
      const runner = createRunner("xzf")
      const user = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "master", manualTags: [] },
        ],
      }
      const template = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "master", manualTags: [] },
          { name: "proj2", gitUrl: "url2", branch: "dev", manualTags: [] },
        ],
      }
      const { merged, conflicts } = runner.mergeManifestEntries(user, template)
      expect(merged.group1.length).toBe(2)
      expect(conflicts.length).toBe(0)
    })

    it("mergeManifestEntries detects branch conflicts", () => {
      const runner = createRunner("xzf")
      const user = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "master", manualTags: [] },
        ],
      }
      const template = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "dev", manualTags: [] },
        ],
      }
      const { merged, conflicts } = runner.mergeManifestEntries(user, template)
      expect(conflicts.length).toBe(1)
      expect(conflicts[0].userBranch).toBe("master")
    })

    it("parseManifestMdFromString does not include ## header lines in headerLines", () => {
      const runner = createRunner("xzf")
      const { entries, headerLines } = runner.parseManifestMdFromString(
        "# Project Manifest\n\n## group1\n\n- proj1 https://git.example.com/proj1.git\n",
      )
      expect(entries.group1).toBeDefined()
      expect(entries.group1[0].name).toBe("proj1")
      expect(headerLines).toEqual(["# Project Manifest", ""])
      expect(headerLines.some((l) => l.trim().startsWith("## "))).toBe(false)
    })

    it("manifest merge does not produce duplicate section headers", async () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      writeFileSync(
        join(testOrgDir, "repos", "manifest.md"),
        "# My Manifest\n\n## group1\n\n- proj1 https://git.example.com/proj1.git\n",
        "utf-8",
      )
      const runner = createRunner("xzf")
      await runner.run()
      const content = readFileSync(join(testOrgDir, "repos", "manifest.md"), "utf-8")
      const headerCount = (content.match(/^## /gm) || []).length
      const group1Count = (content.match(/^## group1/gm) || []).length
      expect(group1Count).toBe(1)
      expect(content).not.toMatch(/## group1.*\n.*## group1/)
    })
  })

  describe("writeEnvMd", () => {
    it("writes sections back to markdown format", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      const runner = createRunner("xzf")
      const sections = {
        DB: { host: "localhost", port: "3306" },
        API: { endpoint: "/v1" },
      }
      runner.writeEnvMd(join(testOrgDir, "env", "output.md"), sections)
      const content = readFileSync(
        join(testOrgDir, "env", "output.md"),
        "utf-8",
      )
      expect(content).toContain("## DB")
      expect(content).toContain("- host: localhost")
      expect(content).toContain("## API")
    })

    it("writeEnvMd preserves header when provided", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      const runner = createRunner("xzf")
      const sections = {
        DB: { host: "localhost", port: "3306" },
      }
      const header = "# Database Config\n\n> Connection info"
      runner.writeEnvMd(join(testOrgDir, "env", "output.md"), sections, header)
      const content = readFileSync(
        join(testOrgDir, "env", "output.md"),
        "utf-8",
      )
      expect(content).toContain("# Database Config")
      expect(content).toContain("> Connection info")
      expect(content).toContain("## DB")
    })

    it("writeEnvMd omits header when not provided", () => {
      mkdirSync(join(testOrgDir, "env"), { recursive: true })
      const runner = createRunner("xzf")
      const sections = {
        DB: { host: "localhost", port: "3306" },
      }
      runner.writeEnvMd(join(testOrgDir, "env", "output.md"), sections)
      const content = readFileSync(
        join(testOrgDir, "env", "output.md"),
        "utf-8",
      )
      expect(content).not.toContain("# Database Config")
      expect(content.startsWith("## DB")).toBe(true)
    })
  })

  describe("writeManifestMd", () => {
    it("writes manifest entries back to markdown format", () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      const runner = createRunner("xzf")
      const entries = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "dev", manualTags: ["tag1"] },
        ],
      }
      runner.writeManifestMd(
        join(testOrgDir, "repos", "output.md"),
        entries,
      )
      const content = readFileSync(
        join(testOrgDir, "repos", "output.md"),
        "utf-8",
      )
      expect(content).toContain("## group1")
      expect(content).toContain("- proj1 url1 [dev] {tag1}")
    })

    it("writeManifestMd uses default header when headerLines not provided", () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      const runner = createRunner("xzf")
      const entries = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "master", manualTags: [] },
        ],
      }
      runner.writeManifestMd(
        join(testOrgDir, "repos", "output.md"),
        entries,
      )
      const content = readFileSync(
        join(testOrgDir, "repos", "output.md"),
        "utf-8",
      )
      expect(content).toContain("# Project Manifest")
      expect(content).toContain("> 人工维护的项目清单")
    })

    it("writeManifestMd preserves headerLines when provided", () => {
      mkdirSync(join(testOrgDir, "repos"), { recursive: true })
      const runner = createRunner("xzf")
      const entries = {
        group1: [
          { name: "proj1", gitUrl: "url1", branch: "master", manualTags: [] },
        ],
      }
      const headerLines = ["# Custom Manifest", "", "> Custom description", ""]
      runner.writeManifestMd(
        join(testOrgDir, "repos", "output.md"),
        entries,
        headerLines,
      )
      const content = readFileSync(
        join(testOrgDir, "repos", "output.md"),
        "utf-8",
      )
      expect(content).toContain("# Custom Manifest")
      expect(content).toContain("> Custom description")
      expect(content).not.toContain("# Project Manifest")
    })
  })

  describe("interactive org setup", () => {
    it("needInteractiveSetup returns true when no org and no global config", () => {
      const runner = new SetupRunner("", false, false)
      runner["globalDir"] = testGlobalDir
      expect(runner.needInteractiveSetup()).toBe(true)
    })

    it("needInteractiveSetup returns false when org is provided", () => {
      const runner = new SetupRunner("xzf", false, false)
      runner["globalDir"] = testGlobalDir
      expect(runner.needInteractiveSetup()).toBe(false)
    })

    it("needInteractiveSetup returns false when global config has default_org", () => {
      writeFileSync(
        join(testGlobalDir, "config.yaml"),
        "default_org: xzf\n",
        "utf-8",
      )
      const runner = new SetupRunner("", false, false)
      runner["globalDir"] = testGlobalDir
      expect(runner.needInteractiveSetup()).toBe(false)
    })

    it("needInteractiveSetup returns true when global config exists but no default_org", () => {
      writeFileSync(
        join(testGlobalDir, "config.yaml"),
        "# empty config\n",
        "utf-8",
      )
      const runner = new SetupRunner("", false, false)
      runner["globalDir"] = testGlobalDir
      expect(runner.needInteractiveSetup()).toBe(true)
    })

    it("run skips interactive setup when org provided", async () => {
      const runner = new SetupRunner("xzf", false, false)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "xzf")
      runner["corePackPath"] = mockCorePackDir
      runner["presetsPath"] = mockPresetsDir
      expect(runner.needInteractiveSetup()).toBe(false)
      await runner.run()
      expect(existsSync(join(testGlobalDir, "config.yaml"))).toBe(true)
    })

    it("createOrgConfig uses org preset when available", () => {
      mkdirSync(join(mockPresetsDir, "orgs", "customorg"), { recursive: true })
      writeFileSync(
        join(mockPresetsDir, "orgs", "customorg", "config.yaml.tpl"),
        "name: {org}\nprefix: custom-\n",
        "utf-8",
      )
      mkdirSync(join(testGlobalDir, "customorg"), { recursive: true })

      const runner = new SetupRunner("customorg", false, false)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "customorg")
      runner["presetsPath"] = mockPresetsDir

      runner["createOrgConfig"]("customorg", "custom-", "custom org", "Custom Org")

      const configPath = join(testGlobalDir, "customorg", "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      expect(readFileSync(configPath, "utf-8")).toContain("name: customorg")
      expect(readFileSync(configPath, "utf-8")).toContain("prefix: custom-")
    })

    it("createOrgConfig uses standard preset fallback with placeholders", () => {
      writeFileSync(
        join(mockPresetsDir, "orgs", "standard", "config.yaml.tpl"),
        "name: {org}\nprefix: {prefix}\ndescription: {description}\n",
        "utf-8",
      )
      mkdirSync(join(testGlobalDir, "neworg"), { recursive: true })

      const runner = new SetupRunner("neworg", false, false)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "neworg")
      runner["presetsPath"] = mockPresetsDir

      runner["createOrgConfig"]("neworg", "neworg-", "new org desc", "New Org")

      const configPath = join(testGlobalDir, "neworg", "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      const content = readFileSync(configPath, "utf-8")
      expect(content).toContain("name: neworg")
      expect(content).toContain("prefix: neworg-")
      expect(content).toContain("description: new org desc")
    })

    it("createOrgConfig falls back to inline when no presets", () => {
      mkdirSync(join(testGlobalDir, "inlineorg"), { recursive: true })

      const runner = new SetupRunner("inlineorg", false, false)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "inlineorg")
      runner["presetsPath"] = null

      runner["createOrgConfig"]("inlineorg", "inl-", "inline org", "Inline Org")

      const configPath = join(testGlobalDir, "inlineorg", "config.yaml")
      expect(existsSync(configPath)).toBe(true)
      const content = readFileSync(configPath, "utf-8")
      expect(content).toContain("name: Inline Org")
      expect(content).toContain("prefix: inl-")
      expect(content).toContain("description: inline org")
    })

    it("createOrgConfig skips if config already exists", () => {
      mkdirSync(join(testGlobalDir, "existorg"), { recursive: true })
      writeFileSync(
        join(testGlobalDir, "existorg", "config.yaml"),
        "existing: true\n",
        "utf-8",
      )

      const runner = new SetupRunner("existorg", false, false)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "existorg")
      runner["presetsPath"] = null

      runner["createOrgConfig"]("existorg", "ex-", "exist org", "Exist Org")

      const content = readFileSync(join(testGlobalDir, "existorg", "config.yaml"), "utf-8")
      expect(content).toContain("existing: true")
      expect(content).not.toContain("prefix: ex-")
    })

    it("createOrgConfig in dry-run mode does not create files", () => {
      const runner = new SetupRunner("dryorg", false, true)
      runner["globalDir"] = testGlobalDir
      runner["orgDir"] = join(testGlobalDir, "dryorg")
      runner["presetsPath"] = null

      runner["createOrgConfig"]("dryorg", "dry-", "dry org", "Dry Org")

      expect(existsSync(join(testGlobalDir, "dryorg", "config.yaml"))).toBe(false)
    })
  })
})