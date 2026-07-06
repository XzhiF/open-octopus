import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import {
  ResourceError,
  AtomicJsonStore,
  RegistryStore,
  LockManager,
  parseRef,
  AuditWriter,
  PostInstallVerifier,
  PostUninstallVerifier,
  ResourceManager,
  SAFE_NAME_RE,
  REF_RE,
  RegistryFileSchema,
  LockFileSchema,
  isPathWithinBase,
  type ResourceEntry,
} from "../resource"

// ── Test helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resource-test-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function makeEntry(overrides: Partial<ResourceEntry> = {}): ResourceEntry {
  return {
    name: "test-skill",
    type: "skill",
    source: "builtin",
    ref: "builtin:test-skill",
    installed: true,
    verified: true,
    status: "installed",
    installedAt: new Date().toISOString(),
    scope: "org",
    installPath: "/tmp/test",
    dependsOn: [],
    ...overrides,
  }
}

// ── SAFE_NAME_RE / REF_RE ──────────────────────────────────────

describe("validation patterns", () => {
  it("SAFE_NAME_RE accepts valid names", () => {
    expect(SAFE_NAME_RE.test("brainstorming")).toBe(true)
    expect(SAFE_NAME_RE.test("octo-skill-creator")).toBe(true)
    expect(SAFE_NAME_RE.test("my.skill_v2")).toBe(true)
    expect(SAFE_NAME_RE.test("A")).toBe(true)
  })

  it("SAFE_NAME_RE rejects invalid names", () => {
    expect(SAFE_NAME_RE.test("")).toBe(false)
    expect(SAFE_NAME_RE.test(".hidden")).toBe(false)
    expect(SAFE_NAME_RE.test("-dash-start")).toBe(false)
    expect(SAFE_NAME_RE.test("has space")).toBe(false)
    expect(SAFE_NAME_RE.test("a".repeat(129))).toBe(false)
  })

  it("REF_RE accepts valid refs", () => {
    expect(REF_RE.test("builtin:brainstorming")).toBe(true)
    expect(REF_RE.test("local:/path/to/skill")).toBe(true)
  })

  it("REF_RE rejects invalid refs", () => {
    expect(REF_RE.test("invalid:name")).toBe(false)
    expect(REF_RE.test("builtin:")).toBe(false)
    expect(REF_RE.test(":name")).toBe(false)
    expect(REF_RE.test("")).toBe(false)
  })
})

// ── ResourceError ───────────────────────────────────────────────

describe("ResourceError", () => {
  it("has correct code, status, suggestion", () => {
    const err = new ResourceError("RESOURCE_NOT_FOUND", "not found")
    expect(err.code).toBe("RESOURCE_NOT_FOUND")
    expect(err.status).toBe(404)
    expect(err.suggestion).toContain("octopus resource list")
  })

  it("toJSON produces structured response", () => {
    const err = new ResourceError("INVALID_REF", "bad ref")
    const json = err.toJSON()
    expect(json.error.code).toBe("INVALID_REF")
    expect(json.error.message).toBe("bad ref")
    expect(json.error.suggestion).toBeDefined()
  })

  it("custom suggestion overrides default", () => {
    const err = new ResourceError("INTERNAL_ERROR", "oops", { suggestion: "try again" })
    expect(err.suggestion).toBe("try again")
  })
})

// ── AtomicJsonStore ─────────────────────────────────────────────

describe("AtomicJsonStore", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = createTempDir() })
  afterEach(() => { cleanupDir(tmpDir) })

  it("returns default data when file missing", () => {
    const store = new AtomicJsonStore(
      path.join(tmpDir, "test.json"),
      RegistryFileSchema,
      { version: 1 as const, resources: [] },
    )
    const data = store.read()
    expect(data.version).toBe(1)
    expect(data.resources).toEqual([])
  })

  it("writes and reads data atomically", () => {
    const filePath = path.join(tmpDir, "test.json")
    const store = new AtomicJsonStore(filePath, RegistryFileSchema, { version: 1 as const, resources: [] })

    const entry = makeEntry()
    store.write({ version: 1, resources: [entry] })

    const data = store.read()
    expect(data.resources).toHaveLength(1)
    expect(data.resources[0].name).toBe("test-skill")
  })

  it("creates .bak file on overwrite", () => {
    const filePath = path.join(tmpDir, "test.json")
    const store = new AtomicJsonStore(filePath, RegistryFileSchema, { version: 1 as const, resources: [] })

    store.write({ version: 1, resources: [] })
    store.write({ version: 1, resources: [makeEntry()] })

    expect(fs.existsSync(filePath + ".bak")).toBe(true)
  })

  it("falls back to .bak when main file corrupt", () => {
    const filePath = path.join(tmpDir, "test.json")
    const store = new AtomicJsonStore(filePath, RegistryFileSchema, { version: 1 as const, resources: [] })

    // Write 1: creates file with empty resources
    store.write({ version: 1, resources: [] })
    // Write 2: .bak = write 1 content, file = write 2 content
    store.write({ version: 1, resources: [makeEntry()] })
    // Write 3: .bak = write 2 content (with entry), file = write 3 content
    store.write({ version: 1, resources: [makeEntry({ name: "second" })] })

    // Corrupt main file
    fs.writeFileSync(filePath, "not json{{{", "utf-8")

    // Should fallback to .bak (write 2 content, which has test-skill)
    const data = store.read()
    expect(data.resources).toHaveLength(1)
    expect(data.resources[0].name).toBe("test-skill")
  })

  it("throws REGISTRY_CORRUPT when both main and .bak corrupt (B3 fix)", () => {
    const filePath = path.join(tmpDir, "test.json")
    const store = new AtomicJsonStore(filePath, RegistryFileSchema, { version: 1 as const, resources: [] })

    fs.writeFileSync(filePath, "corrupt", "utf-8")
    fs.writeFileSync(filePath + ".bak", "also corrupt", "utf-8")

    expect(() => store.read()).toThrow(/corrupt/)
  })

  it("returns defaults when neither file exists (fresh install)", () => {
    const filePath = path.join(tmpDir, "nonexistent.json")
    const store = new AtomicJsonStore(filePath, RegistryFileSchema, { version: 1 as const, resources: [] })

    const data = store.read()
    expect(data.resources).toEqual([])
  })
})

// ── RegistryStore ───────────────────────────────────────────────

describe("RegistryStore", () => {
  let tmpDir: string
  let store: RegistryStore

  beforeEach(() => {
    tmpDir = createTempDir()
    store = new RegistryStore(tmpDir)
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("starts empty", () => {
    expect(store.list()).toEqual([])
    expect(store.count()).toBe(0)
  })

  it("upsert and get", () => {
    const entry = makeEntry()
    store.upsert(entry)

    const found = store.get("skill", "test-skill")
    expect(found?.name).toBe("test-skill")
  })

  it("upsert updates existing entry", () => {
    store.upsert(makeEntry())
    store.upsert(makeEntry({ verified: false, status: "installed_but_unverified" }))

    expect(store.count()).toBe(1)
    expect(store.get("skill", "test-skill")?.verified).toBe(false)
  })

  it("remove entry", () => {
    store.upsert(makeEntry())
    expect(store.remove("skill", "test-skill")).toBe(true)
    expect(store.count()).toBe(0)
  })

  it("remove non-existent returns false", () => {
    expect(store.remove("skill", "nope")).toBe(false)
  })

  it("list with filters", () => {
    store.upsert(makeEntry({ name: "alpha", type: "skill" }))
    store.upsert(makeEntry({ name: "beta", type: "agent" }))
    store.upsert(makeEntry({ name: "gamma", type: "skill", installed: false }))

    expect(store.list({ type: "skill" })).toHaveLength(2)
    expect(store.list({ type: "agent" })).toHaveLength(1)
    expect(store.list({ installed: false })).toHaveLength(1)
    expect(store.list({ query: "alph" })).toHaveLength(1)
  })

  it("findDependents returns resources depending on target", () => {
    store.upsert(makeEntry({ name: "base" }))
    store.upsert(makeEntry({ name: "dependent", dependsOn: ["skill:base"] }))

    const deps = store.findDependents("skill", "base")
    expect(deps).toHaveLength(1)
    expect(deps[0].name).toBe("dependent")
  })

  it("stats returns correct counts", () => {
    store.upsert(makeEntry({ name: "s1", type: "skill" }))
    store.upsert(makeEntry({ name: "a1", type: "agent" }))

    const stats = store.stats()
    expect(stats.total).toBe(2)
    expect(stats.byType.skill).toBe(1)
    expect(stats.byType.agent).toBe(1)
    expect(stats.installed).toBe(2)
  })
})

// ── LockManager ─────────────────────────────────────────────────

describe("LockManager", () => {
  let tmpDir: string
  let lock: LockManager

  beforeEach(() => {
    tmpDir = createTempDir()
    lock = new LockManager(tmpDir)
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("starts empty", () => {
    expect(lock.list()).toEqual([])
  })

  it("upsert and get", () => {
    lock.upsert({
      name: "test",
      type: "skill",
      hash: "abc123",
      lockedAt: new Date().toISOString(),
      installPath: "/tmp/test",
      fileCount: 1,
    })

    expect(lock.has("skill", "test")).toBe(true)
    expect(lock.get("skill", "test")?.hash).toBe("abc123")
  })

  it("remove entry", () => {
    lock.upsert({
      name: "test",
      type: "skill",
      hash: "abc",
      lockedAt: new Date().toISOString(),
      installPath: "/tmp",
      fileCount: 0,
    })
    expect(lock.remove("skill", "test")).toBe(true)
    expect(lock.has("skill", "test")).toBe(false)
  })
})

// ── parseRef ────────────────────────────────────────────────────

describe("parseRef", () => {
  it("parses builtin ref", () => {
    const result = parseRef("builtin:brainstorming")
    expect(result.source).toBe("builtin")
    expect(result.name).toBe("brainstorming")
  })

  it("parses local ref", () => {
    const result = parseRef("local:/path/to/skill")
    expect(result.source).toBe("local")
    expect(result.name).toBe("/path/to/skill")
  })

  it("throws on invalid ref", () => {
    expect(() => parseRef("invalid")).toThrow(ResourceError)
    expect(() => parseRef("npm:package")).toThrow(ResourceError)
    expect(() => parseRef("")).toThrow(ResourceError)
  })
})

// ── AuditWriter ─────────────────────────────────────────────────

describe("AuditWriter", () => {
  let tmpDir: string
  let audit: AuditWriter

  beforeEach(() => {
    tmpDir = createTempDir()
    audit = new AuditWriter(tmpDir)
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("starts with empty audit log", () => {
    expect(audit.readAll()).toEqual([])
  })

  it("appends records", () => {
    audit.append("install", { name: "test", type: "skill", source: "builtin" }, "cli")
    audit.append("uninstall", { name: "test", type: "skill", source: "builtin" }, "ui")

    const records = audit.readAll()
    expect(records).toHaveLength(2)
    expect(records[0].action).toBe("install")
    expect(records[0].caller).toBe("cli")
    expect(records[1].action).toBe("uninstall")
    expect(records[1].caller).toBe("ui")
  })

  it("query with action filter", () => {
    audit.append("install", { name: "a", type: "skill", source: "builtin" }, "cli")
    audit.append("uninstall", { name: "a", type: "skill", source: "builtin" }, "cli")
    audit.append("install", { name: "b", type: "agent", source: "builtin" }, "ui")

    const installs = audit.query({ action: "install" })
    expect(installs).toHaveLength(2)
  })

  it("query with last N", () => {
    for (let i = 0; i < 10; i++) {
      audit.append("install", { name: `r${i}`, type: "skill", source: "builtin" }, "cli")
    }

    const last3 = audit.query({ last: 3 })
    expect(last3).toHaveLength(3)
    // Newest first
    expect(last3[0].resource_name).toBe("r9")
  })

  it("audit records have consistent schema (CLI vs UI)", () => {
    audit.append("install", { name: "test", type: "skill", source: "builtin" }, "cli")
    audit.append("install", { name: "test", type: "skill", source: "builtin" }, "ui")

    const records = audit.readAll()
    const [cli, ui] = records

    // Same keys
    expect(Object.keys(cli).sort()).toEqual(Object.keys(ui).sort())

    // Only timestamp and caller differ
    expect(cli.action).toBe(ui.action)
    expect(cli.resource_name).toBe(ui.resource_name)
    expect(cli.resource_type).toBe(ui.resource_type)
    expect(cli.source).toBe(ui.source)
    expect(cli.caller).not.toBe(ui.caller)
  })
})

// ── PostInstallVerifier ─────────────────────────────────────────

describe("PostInstallVerifier", () => {
  let tmpDir: string
  let registry: RegistryStore
  let lock: LockManager
  let verifier: PostInstallVerifier

  beforeEach(() => {
    tmpDir = createTempDir()
    registry = new RegistryStore(tmpDir)
    lock = new LockManager(tmpDir)
    verifier = new PostInstallVerifier()
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("passes when all three conditions met", () => {
    const installPath = path.join(tmpDir, "installed")
    fs.mkdirSync(installPath, { recursive: true })

    registry.upsert(makeEntry({ installPath }))
    lock.upsert({
      name: "test-skill",
      type: "skill",
      hash: "abc",
      lockedAt: new Date().toISOString(),
      installPath,
      fileCount: 1,
    })

    const result = verifier.verify("skill", "test-skill", installPath, { registry, lock })
    expect(result.passed).toBe(true)
    expect(result.steps).toHaveLength(3)
    expect(result.steps.every((s) => s.passed)).toBe(true)
  })

  it("fails when file missing", () => {
    registry.upsert(makeEntry({ installPath: "/nonexistent" }))
    lock.upsert({
      name: "test-skill",
      type: "skill",
      hash: "abc",
      lockedAt: new Date().toISOString(),
      installPath: "/nonexistent",
      fileCount: 0,
    })

    const result = verifier.verify("skill", "test-skill", "/nonexistent", { registry, lock })
    expect(result.passed).toBe(false)
    expect(result.steps.find((s) => s.step === "fileExists")?.passed).toBe(false)
  })

  it("fails when registry entry missing", () => {
    const installPath = path.join(tmpDir, "installed")
    fs.mkdirSync(installPath)

    const result = verifier.verify("skill", "nonexistent", installPath, { registry, lock })
    expect(result.passed).toBe(false)
  })
})

// ── PostUninstallVerifier ───────────────────────────────────────

describe("PostUninstallVerifier", () => {
  let tmpDir: string
  let registry: RegistryStore
  let lock: LockManager
  let verifier: PostUninstallVerifier

  beforeEach(() => {
    tmpDir = createTempDir()
    registry = new RegistryStore(tmpDir)
    lock = new LockManager(tmpDir)
    verifier = new PostUninstallVerifier()
  })
  afterEach(() => { cleanupDir(tmpDir) })

  it("passes when all cleaned up", () => {
    const installPath = path.join(tmpDir, "already-removed")
    // No registry entry, no lock entry, no file
    const result = verifier.verify("skill", "test", installPath, { registry, lock })
    expect(result.passed).toBe(true)
    expect(result.steps.every((s) => s.passed)).toBe(true)
  })

  it("fails when file still exists", () => {
    const installPath = path.join(tmpDir, "still-here")
    fs.mkdirSync(installPath, { recursive: true })

    const result = verifier.verify("skill", "test", installPath, { registry, lock })
    expect(result.passed).toBe(false)
    expect(result.steps.find((s) => s.step === "fileRemoved")?.passed).toBe(false)
  })
})

// ── ResourceManager (integration) ───────────────────────────────

describe("ResourceManager", () => {
  let tmpDir: string
  let corePackDir: string
  let manager: ResourceManager

  beforeEach(() => {
    tmpDir = createTempDir()
    corePackDir = createTempDir()

    // Create fake core-pack structure
    const skillDir = path.join(corePackDir, "skills", "test-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\nHello world", "utf-8")

    const agentDir = path.join(corePackDir, "agents", "test-agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "AGENT.md"), "# Test Agent", "utf-8")

    manager = new ResourceManager({
      org: "test-org",
      basePath: tmpDir,
      corePackBase: corePackDir,
    })
  })

  afterEach(() => {
    cleanupDir(tmpDir)
    cleanupDir(corePackDir)
  })

  it("health check returns ok", () => {
    const h = manager.health()
    expect(h.ok).toBe(true)
    expect(h.registryCount).toBe(0)
  })

  it("listBuiltin returns catalog entries", () => {
    const catalog = manager.listBuiltin()
    expect(catalog.length).toBeGreaterThanOrEqual(2)
    expect(catalog.find((e) => e.name === "test-skill" && e.type === "skill")).toBeDefined()
    expect(catalog.find((e) => e.name === "test-agent" && e.type === "agent")).toBeDefined()
  })

  it("install builtin skill", async () => {
    const result = await manager.install({
      ref: "builtin:test-skill",
      scope: "org",
      caller: "cli",
    })

    expect(result.name).toBe("test-skill")
    expect(result.type).toBe("skill")
    expect(result.source).toBe("builtin")
    expect(result.status).toBe("installed")

    // Verify in registry
    const entry = manager.get("skill", "test-skill")
    expect(entry).toBeDefined()
    expect(entry?.installed).toBe(true)

    // Verify files exist
    expect(fs.existsSync(result.installPath)).toBe(true)
    expect(fs.existsSync(path.join(result.installPath, "SKILL.md"))).toBe(true)

    // Verify audit
    const audit = manager.auditQuery()
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.find((r) => r.action === "install")).toBeDefined()
  })

  it("install duplicate throws RESOURCE_ALREADY_EXISTS", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    await expect(
      manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" }),
    ).rejects.toThrow(ResourceError)
  })

  it("install non-existent builtin throws BUILTIN_NOT_FOUND", async () => {
    await expect(
      manager.install({ ref: "builtin:nonexistent-skill", scope: "org", caller: "cli" }),
    ).rejects.toThrow()
  })

  it("uninstall removes resource", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    const result = await manager.uninstall({ name: "test-skill", type: "skill", caller: "cli" })
    expect(result.status).toBe("uninstalled")
    expect(result.verified).toBe(true)

    // Verify removed from registry
    expect(manager.get("skill", "test-skill")).toBeNull()

    // Verify audit has both install and uninstall
    const audit = manager.auditQuery()
    expect(audit.find((r) => r.action === "install")).toBeDefined()
    expect(audit.find((r) => r.action === "uninstall")).toBeDefined()
  })

  it("uninstall non-existent throws RESOURCE_NOT_FOUND", async () => {
    await expect(
      manager.uninstall({ name: "nope", type: "skill", caller: "cli" }),
    ).rejects.toThrow(ResourceError)
  })

  it("uninstall blocked by dependency", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    // Manually add dependent entry
    const list = manager.list()
    // We need to add a dependent — access registry store through a second manager on same path
    const manager2 = new ResourceManager({ org: "test-org", basePath: tmpDir, corePackBase: corePackDir })
    // Hack: install another skill then modify its dependsOn
    await manager2.install({ ref: "builtin:test-agent", scope: "org", caller: "cli" })

    // Directly modify registry to add dependency
    const registryPath = path.join(tmpDir, "registry.json")
    const regData = JSON.parse(fs.readFileSync(registryPath, "utf-8"))
    const agentEntry = regData.resources.find((r: any) => r.name === "test-agent")
    if (agentEntry) {
      agentEntry.dependsOn = ["skill:test-skill"]
      fs.writeFileSync(registryPath, JSON.stringify(regData, null, 2))
    }

    // Now try uninstalling test-skill — should be blocked
    await expect(
      manager.uninstall({ name: "test-skill", type: "skill", caller: "cli" }),
    ).rejects.toThrow(ResourceError)
  })

  it("list returns installed resources", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    const result = manager.list()
    expect(result.total).toBe(1)
    expect(result.resources[0].name).toBe("test-skill")
  })

  it("list with type filter", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })
    await manager.install({ ref: "builtin:test-agent", scope: "org", caller: "cli" })

    const skills = manager.list({ type: "skill" })
    expect(skills.total).toBe(1)
  })

  it("verify returns result for installed resource", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    const result = manager.verify("skill", "test-skill")
    expect(result.passed).toBe(true)
  })

  it("stats returns correct counts", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })
    await manager.install({ ref: "builtin:test-agent", scope: "org", caller: "cli" })

    const stats = manager.stats()
    expect(stats.total).toBe(2)
    expect(stats.installed).toBe(2)
  })

  it("listFiles returns installed resource files", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    const files = manager.listFiles("skill", "test-skill")
    expect(files).toContain("SKILL.md")
  })

  it("readFile returns file content", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    const content = manager.readFile("skill", "test-skill", "SKILL.md")
    expect(content).toContain("Test Skill")
  })

  it("readFile blocks path traversal", async () => {
    await manager.install({ ref: "builtin:test-skill", scope: "org", caller: "cli" })

    expect(() =>
      manager.readFile("skill", "test-skill", "../../etc/passwd"),
    ).toThrow(ResourceError)
  })
})

// ── isPathWithinBase ─────────────────────────────────────────────

describe("isPathWithinBase", () => {
  it("returns true for path within base", () => {
    expect(isPathWithinBase("/home/user/project/file.txt", "/home/user/project")).toBe(true)
  })

  it("returns false for path outside base", () => {
    expect(isPathWithinBase("/etc/passwd", "/home/user/project")).toBe(false)
  })

  it("returns false for path traversal", () => {
    expect(isPathWithinBase("/home/user/project/../../etc/passwd", "/home/user/project")).toBe(false)
  })
})
