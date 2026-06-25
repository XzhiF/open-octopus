import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import {
  resolveCurrentOrg,
  resolveProjectDir,
  resolveSkillDir,
  resolveEnvDir,
  resolveMcpDir,
  resolveReposDir,
  resolveEvolutionDir,
} from "../utils/path"

const OCTOPUS_HOME_KEY = "OCTOPUS_HOME"
const OCTOPUS_ORG_KEY = "OCTOPUS_ORG"

describe("resolveCurrentOrg", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "octopus-path-test-"))
    process.env[OCTOPUS_HOME_KEY] = testDir
    delete process.env[OCTOPUS_ORG_KEY]
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env[OCTOPUS_HOME_KEY]
    delete process.env[OCTOPUS_ORG_KEY]
  })

  it("returns OCTOPUS_ORG env when set (layer 1)", () => {
    process.env[OCTOPUS_ORG_KEY] = "env-org"
    expect(resolveCurrentOrg()).toBe("env-org")
  })

  it("returns workspace .octopus/config.yaml org when env not set (layer 2)", () => {
    const projDir = join(testDir, "project")
    mkdirSync(join(projDir, ".octopus"), { recursive: true })
    writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: ws-org\n")
    expect(resolveCurrentOrg(projDir)).toBe("ws-org")
  })

  it("returns global default_org when env and workspace both missing (layer 3)", () => {
    writeFileSync(join(testDir, "config.yaml"), "default_org: global-org\n")
    expect(resolveCurrentOrg(testDir)).toBe("global-org")
  })

  it("calls process.exit when global default_org is empty (layer 3 error)", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    resolveCurrentOrg(testDir)
    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
    mockError.mockRestore()
  })

  it("env overrides workspace config", () => {
    process.env[OCTOPUS_ORG_KEY] = "env-org"
    const projDir = join(testDir, "project")
    mkdirSync(join(projDir, ".octopus"), { recursive: true })
    writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: ws-org\n")
    expect(resolveCurrentOrg(projDir)).toBe("env-org")
    delete process.env[OCTOPUS_ORG_KEY]
  })

  it("workspace config overrides global default_org", () => {
    writeFileSync(join(testDir, "config.yaml"), "default_org: global-org\n")
    const projDir = join(testDir, "project2")
    mkdirSync(join(projDir, ".octopus"), { recursive: true })
    writeFileSync(join(projDir, ".octopus", "config.yaml"), "org: ws-org\n")
    expect(resolveCurrentOrg(projDir)).toBe("ws-org")
  })
})

describe("resolveProjectDir", () => {
  it("returns cwd", () => {
    expect(resolveProjectDir()).toBe(process.cwd())
  })
})

describe("resolveSkillDir", () => {
  it("resolves skill directory under org", () => {
    const dir = resolveSkillDir("xzf", "my-skill-creator")
    expect(dir).toContain("xzf")
    expect(dir).toContain("skills")
    expect(dir).toContain("my-skill-creator")
  })
})

describe("resolveEnvDir", () => {
  it("resolves env directory under org", () => {
    const dir = resolveEnvDir("xzf")
    expect(dir).toMatch(/xzf[\/\\]env$/)
  })
})

describe("resolveMcpDir", () => {
  it("resolves mcp directory under org", () => {
    const dir = resolveMcpDir("xzf")
    expect(dir).toMatch(/xzf[\/\\]mcp$/)
  })
})

describe("resolveReposDir", () => {
  it("resolves repos directory under org", () => {
    const dir = resolveReposDir("xzf")
    expect(dir).toMatch(/xzf[\/\\]repos$/)
  })
})

describe("resolveEvolutionDir", () => {
  it("resolves evolution directory under org", () => {
    const dir = resolveEvolutionDir("xzf")
    expect(dir).toMatch(/xzf[\/\\]evolution$/)
  })
})