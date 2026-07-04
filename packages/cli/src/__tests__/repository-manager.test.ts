import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { RepositoryManager } from "../repository/repository-manager"
import { BuiltinProvider } from "../repository/providers"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-repo-mgr-test-"))

describe("RepositoryManager", () => {
  let testDir: string
  let mgr: RepositoryManager
  let corePack: string

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "mgr-"))
    mgr = new RepositoryManager(testDir)

    // Create a mock core-pack for builtin provider tests
    corePack = mkdtempSync(join(baseTmpDir, "corepack-"))
    mkdirSync(join(corePack, "skills", "test-builtin"), { recursive: true })
    writeFileSync(
      join(corePack, "skills", "test-builtin", "SKILL.md"),
      "---\nname: test-builtin\n---\n# Test\n",
      "utf-8"
    )

    // Override the builtin provider's corePackDir
    const providers = (mgr as any).providers
    providers.providers.get("builtin")["corePackDir"] = corePack
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    rmSync(corePack, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(baseTmpDir, { recursive: true, force: true })
  })

  it("getRepoDir() returns configured directory", () => {
    expect(mgr.getRepoDir()).toBe(testDir)
  })

  it("getRegistry() returns RegistryStore instance", () => {
    expect(mgr.getRegistry()).toBeDefined()
    expect(typeof mgr.getRegistry().list).toBe("function")
  })

  it("initRepo() creates required directories", () => {
    mgr.initRepo()
    expect(existsSync(join(testDir, "manifests"))).toBe(true)
    expect(existsSync(join(testDir, "cache"))).toBe(true)
  })

  it("initRepo() throws when registry.json already exists without --force", () => {
    // Manually create registry.json to simulate a prior init
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "registry.json"), '{"version":1,"updated_at":"x","entries":{}}', "utf-8")
    expect(() => mgr.initRepo()).toThrow(/Already initialized/)
  })

  it("initRepo() succeeds with force=true even when registry.json exists", () => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, "registry.json"), '{"version":1,"updated_at":"x","entries":{}}', "utf-8")
    expect(() => mgr.initRepo(true)).not.toThrow()
  })

  it("list() returns empty initially", () => {
    mgr.initRepo()
    expect(mgr.list()).toEqual([])
  })

  it("unregister() returns false for non-existing entry", () => {
    mgr.initRepo()
    expect(mgr.unregister("missing", "skill")).toBe(false)
  })

  it("lookup() returns undefined for non-existing entry", () => {
    mgr.initRepo()
    expect(mgr.lookup("missing")).toBeUndefined()
  })

  it("register() with builtin provider succeeds", async () => {
    mgr.initRepo()

    const entry = await mgr.register(
      { protocol: "builtin", id: "test-builtin" },
      "skill"
    )

    expect(entry.name).toBe("test-builtin")
    expect(entry.type).toBe("skill")
    expect(entry.hash).toBeDefined()
    expect(entry.cache_path).toContain("cache/skill/")

    // Now it should be in the registry
    expect(mgr.lookup("test-builtin", "skill")).toBeDefined()
    expect(mgr.list("skill")).toHaveLength(1)
  })

  it("register() throws on duplicate without --force", async () => {
    mgr.initRepo()

    await mgr.register({ protocol: "builtin", id: "test-builtin" }, "skill")
    await expect(
      mgr.register({ protocol: "builtin", id: "test-builtin" }, "skill")
    ).rejects.toThrow(/Already registered/)
  })

  it("register() with --force overwrites existing", async () => {
    mgr.initRepo()

    const e1 = await mgr.register({ protocol: "builtin", id: "test-builtin" }, "skill")
    const e2 = await mgr.register(
      { protocol: "builtin", id: "test-builtin" },
      "skill",
      { force: true }
    )
    expect(e2.name).toBe("test-builtin")
    expect(mgr.list("skill")).toHaveLength(1)
  })

  it("unregister() removes existing entry", async () => {
    mgr.initRepo()

    await mgr.register({ protocol: "builtin", id: "test-builtin" }, "skill")
    expect(mgr.unregister("test-builtin", "skill")).toBe(true)
    expect(mgr.lookup("test-builtin", "skill")).toBeUndefined()
  })

  it("register() uses custom name from opts", async () => {
    mgr.initRepo()

    const entry = await mgr.register(
      { protocol: "builtin", id: "test-builtin" },
      "skill",
      { name: "custom-name" }
    )
    expect(entry.name).toBe("custom-name")
    expect(mgr.lookup("custom-name", "skill")).toBeDefined()
  })
})
