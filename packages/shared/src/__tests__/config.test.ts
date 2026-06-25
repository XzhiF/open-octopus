import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import {
  resolveGlobalDir,
  resolveOrgDir,
  loadGlobalConfig,
  loadOrgConfig,
  loadProjectConfig,
  loadEffectiveConfig,
  getDefaultOrg,
  getOrgPrefix,
} from "../config/loader"

const OCTOPUS_HOME_KEY = "OCTOPUS_HOME"

describe("resolveGlobalDir", () => {
  it("returns homedir/.octopus when OCTOPUS_HOME is not set", () => {
    delete process.env[OCTOPUS_HOME_KEY]
    const dir = resolveGlobalDir()
    expect(dir).toContain(".octopus")
  })

  it("returns OCTOPUS_HOME env when set", () => {
    process.env[OCTOPUS_HOME_KEY] = "/tmp/test-octopus"
    const dir = resolveGlobalDir()
    expect(dir).toBe("/tmp/test-octopus")
    delete process.env[OCTOPUS_HOME_KEY]
  })
})

describe("resolveOrgDir", () => {
  it("returns globalDir/orgs/org", () => {
    const dir = resolveOrgDir("xzf")
    expect(dir).toContain("xzf")
  })

  it("throws on empty org", () => {
    expect(() => resolveOrgDir("")).toThrow("org must not be empty")
  })
})

describe("config loading with temp dirs", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "octopus-test-"))
    process.env[OCTOPUS_HOME_KEY] = testDir
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env[OCTOPUS_HOME_KEY]
  })

  describe("loadGlobalConfig", () => {
    it("returns { default_org: '' } when config.yaml is missing", () => {
      const cfg = loadGlobalConfig()
      expect(cfg).toEqual({ default_org: "" })
    })

    it("loads config.yaml with default_org", () => {
      writeFileSync(join(testDir, "config.yaml"), "default_org: xzf\n")
      const cfg = loadGlobalConfig()
      expect(cfg.default_org).toBe("xzf")
    })

    it("skips comments and lines starting with >", () => {
      writeFileSync(join(testDir, "config.yaml"), "# comment\n> ignored\ndefault_org: xzf\n")
      const cfg = loadGlobalConfig()
      expect(cfg.default_org).toBe("xzf")
    })

    it("returns empty default_org for malformed content", () => {
      writeFileSync(join(testDir, "config.yaml"), "random text without colon\n")
      const cfg = loadGlobalConfig()
      expect(cfg).toEqual({ default_org: "" })
    })

    it("accepts explicit configPath override", () => {
      const customPath = join(testDir, "custom_global.yaml")
      writeFileSync(customPath, "default_org: custom-org\n")
      const cfg = loadGlobalConfig(customPath)
      expect(cfg.default_org).toBe("custom-org")
    })

    it("reads from ~/.octopus/config.yaml path (not global_config.yaml)", () => {
      writeFileSync(join(testDir, "config.yaml"), "default_org: test-org\n")
      const cfg = loadGlobalConfig()
      expect(cfg.default_org).toBe("test-org")
    })
  })

  describe("loadOrgConfig", () => {
    it("returns defaults when config.yaml is missing", () => {
      const cfg = loadOrgConfig("xzf")
      expect(cfg.name).toBe("xzf")
      expect(cfg.prefix).toBe("")
      expect(cfg.description).toBe("")
      expect(cfg.platform).toBe("gitlab")
      expect(cfg.groups).toEqual([])
      expect(cfg.clone_base).toContain("xzf")
      expect(cfg.clone_base).toContain("repos")
      expect(cfg.clone_base).toContain("projects")
    })

    it("loads config.yaml from ~/.octopus/orgs/{org}/config.yaml", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "name: xzf",
        "prefix: my-",
        "description: Octopus 组织",
        "platform: gitlab",
      ].join("\n"))
      const cfg = loadOrgConfig("xzf")
      expect(cfg.name).toBe("xzf")
      expect(cfg.prefix).toBe("my-")
      expect(cfg.description).toBe("Octopus 组织")
      expect(cfg.platform).toBe("gitlab")
    })

    it("does NOT include 'org' field in result", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), "name: xzf\nprefix: my-\n")
      const cfg = loadOrgConfig("xzf")
      expect("org" in cfg).toBe(false)
    })

    it("parses groups with comma-separated format", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), "groups: xzf,xzf3.0\n")
      const cfg = loadOrgConfig("xzf")
      expect(cfg.groups).toEqual(["xzf", "xzf3.0"])
    })

    it("parses groups with embedded - item and continuation lines", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "prefix: my-",
        "groups: - xzf",
        "  - xzf3.0",
        "name: xzf",
      ].join("\n"))
      const cfg = loadOrgConfig("xzf")
      expect(cfg.groups).toEqual(["xzf", "xzf3.0"])
      expect(cfg.name).toBe("xzf")
    })

    it("parses groups with empty value and list continuation lines", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "prefix: my-",
        "groups:",
        "  - xzf",
        "  - xzf3.0",
        "name: xzf",
      ].join("\n"))
      const cfg = loadOrgConfig("xzf")
      expect(cfg.groups).toEqual(["xzf", "xzf3.0"])
    })

    it("parses clone_base with ~ expansion", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), "clone_base: ~/custom/repos\n")
      const cfg = loadOrgConfig("xzf")
      expect(cfg.clone_base).not.toContain("~")
    })

    it("accepts explicit configPath override", () => {
      const customPath = join(testDir, "custom_org.yaml")
      writeFileSync(customPath, "name: testorg\nprefix: ts-\n")
      const cfg = loadOrgConfig("testorg", customPath)
      expect(cfg.name).toBe("testorg")
      expect(cfg.prefix).toBe("ts-")
    })

    it("skips comments and lines starting with >", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "# comment",
        "> ignored",
        "name: xzf",
        "prefix: my-",
      ].join("\n"))
      const cfg = loadOrgConfig("xzf")
      expect(cfg.name).toBe("xzf")
      expect(cfg.prefix).toBe("my-")
    })
  })

  describe("loadProjectConfig", () => {
    it("returns empty object when .octopus/config.yaml is missing", () => {
      const cfg = loadProjectConfig(testDir)
      expect(cfg).toEqual({})
    })

    it("loads .octopus/config.yaml with org field", () => {
      const projDir = join(testDir, "project")
      mkdirSync(join(projDir, ".octopus"), { recursive: true })
      writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: project-org\n")
      const cfg = loadProjectConfig(projDir)
      expect(cfg.org).toBe("project-org")
    })

    it("accepts explicit configPath override", () => {
      const customPath = join(testDir, "custom_proj.yaml")
      writeFileSync(customPath, "org: override-org\n")
      const cfg = loadProjectConfig(testDir, customPath)
      expect(cfg.org).toBe("override-org")
    })

    it("reads from .octopus/config.yaml (not project_config.yaml)", () => {
      const projDir = join(testDir, "project2")
      mkdirSync(join(projDir, ".octopus"), { recursive: true })
      writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: ws-org\n")
      const cfg = loadProjectConfig(projDir)
      expect(cfg.org).toBe("ws-org")
    })
  })

  describe("loadEffectiveConfig", () => {
    it("returns org defaults when both configs missing", () => {
      const effective = loadEffectiveConfig("xzf")
      expect(effective.name).toBe("xzf")
      expect(effective.platform).toBe("gitlab")
    })

    it("returns org config when project config missing", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "name: xzf",
        "prefix: my-",
      ].join("\n"))
      const effective = loadEffectiveConfig("xzf")
      expect(effective.name).toBe("xzf")
      expect(effective.prefix).toBe("my-")
    })

    it("merges project overrides onto org config", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), [
        "name: xzf",
        "prefix: my-",
      ].join("\n"))

      const projDir = join(testDir, "project")
      mkdirSync(join(projDir, ".octopus"), { recursive: true })
      writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: project-org\n")

      const effective = loadEffectiveConfig("xzf", projDir)
      expect(effective.org).toBe("project-org")
      expect(effective.prefix).toBe("my-")
    })
  })

  describe("getDefaultOrg", () => {
    it("calls process.exit(1) when default_org is empty", () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      loadGlobalConfig()
      getDefaultOrg()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("default_org"))
      expect(mockExit).toHaveBeenCalledWith(1)
      mockExit.mockRestore()
      mockError.mockRestore()
    })

    it("returns default_org from global config when set", () => {
      writeFileSync(join(testDir, "config.yaml"), "default_org: xzf\n")
      expect(getDefaultOrg()).toBe("xzf")
    })
  })

  describe("getOrgPrefix", () => {
    it("returns org- fallback when org config missing", () => {
      expect(getOrgPrefix("xzf")).toBe("xzf-")
    })

    it("returns prefix from org config", () => {
      const orgDir = join(testDir, "orgs", "xzf")
      mkdirSync(orgDir, { recursive: true })
      writeFileSync(join(orgDir, "config.yaml"), "name: xzf\nprefix: my-\n")
      expect(getOrgPrefix("xzf")).toBe("my-")
    })
  })
})