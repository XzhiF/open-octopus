import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { WorkspaceInstaller } from "../resource/installer"
import { DependencyResolver } from "../resource/dependency-resolver"
import { RegistryStore } from "../resource/registry"
import { LockManager } from "../resource/lock-manager"
import { AuditLogger } from "../resource/audit-logger"
import { InstallTransaction } from "../resource/install-transaction"
import { WorkspaceUninstaller } from "../resource/uninstaller"
import { ResourceManager } from "../resource/manager"
import { ResourceError } from "../resource/errors"
import { isPathWithinBase, computeContentHash, parseRef, formatSourceRef, formatBytes } from "../resource/utils"
import type { ResourceManifest, RegistryEntry } from "../resource/types"
import type { SourceProvider } from "../resource/providers/types"

// ── Helpers ──────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "resource-test-"))
}

function makeManifest(overrides?: Partial<ResourceManifest>): ResourceManifest {
  return {
    name: "test-skill",
    type: "skill",
    version: "1.0.0",
    source: { type: "builtin", name: "test-skill" },
    dependencies: [],
    tags: [],
    ...overrides,
  }
}

function makeProvider(manifest?: ResourceManifest): SourceProvider {
  return {
    type: "builtin",
    resolve: async (_ref, rt) => manifest ?? makeManifest({ type: rt }),
    fetch: async (_manifest, targetDir) => {
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, "SKILL.md"), "# Test Skill\nTest content")
    },
    list: async () => [manifest ?? makeManifest()],
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = makeTmpDir()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── utils ────────────────────────────────────────────────────────

describe("utils", () => {
  it("isPathWithinBase returns true for paths inside base", () => {
    expect(isPathWithinBase("/a/b/c", "/a/b")).toBe(true)
    expect(isPathWithinBase("/a/b", "/a/b")).toBe(true)
  })

  it("isPathWithinBase returns false for paths escaping base", () => {
    expect(isPathWithinBase("/a/b/../c", "/a/b")).toBe(false)
    expect(isPathWithinBase("/etc/passwd", "/a/b")).toBe(false)
  })

  it("parseRef parses builtin and local refs", () => {
    expect(parseRef("builtin:my-skill")).toEqual({ type: "builtin", value: "my-skill" })
    expect(parseRef("local:/some/path")).toEqual({ type: "local", value: "/some/path" })
  })

  it("parseRef throws on invalid ref", () => {
    expect(() => parseRef("invalid")).toThrow("Invalid ref format")
  })

  it("formatSourceRef formats refs correctly", () => {
    expect(formatSourceRef({ type: "builtin", name: "foo" })).toBe("builtin:foo")
    expect(formatSourceRef({ type: "local", path: "/bar" })).toBe("local:/bar")
  })

  it("formatBytes formats human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1048576)).toBe("1.0 MB")
  })

  it("computeContentHash returns consistent hash for same content", () => {
    const dir = join(tmpDir, "hash-test")
    mkdirSync(dir)
    writeFileSync(join(dir, "file.txt"), "hello")
    const hash1 = computeContentHash(dir)
    const hash2 = computeContentHash(dir)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64) // SHA-256 hex
  })
})

// ── WorkspaceInstaller ───────────────────────────────────────────

describe("WorkspaceInstaller", () => {
  it("installs a skill and returns path + hash", async () => {
    const installer = new WorkspaceInstaller()
    const manifest = makeManifest()
    const provider = makeProvider(manifest)
    const targetDir = join(tmpDir, "skills")

    const result = await installer.install(manifest, provider, targetDir)

    expect(result.installPath).toBe(join(targetDir, "test-skill"))
    expect(result.contentHash).toHaveLength(64)
    expect(existsSync(join(result.installPath, "SKILL.md"))).toBe(true)
  })

  it("rejects path traversal attempts", async () => {
    const installer = new WorkspaceInstaller()
    const manifest = makeManifest({ name: "../../etc/passwd" })
    const provider = makeProvider(manifest)
    const targetDir = join(tmpDir, "skills")

    await expect(installer.install(manifest, provider, targetDir))
      .rejects.toThrow("escapes workspace")
  })

  it("wraps provider fetch errors as INSTALL_FAILED", async () => {
    const installer = new WorkspaceInstaller()
    const manifest = makeManifest()
    const failingProvider: SourceProvider = {
      type: "builtin",
      resolve: async () => manifest,
      fetch: async () => { throw new Error("network error") },
      list: async () => [],
    }
    const targetDir = join(tmpDir, "skills")

    await expect(installer.install(manifest, failingProvider, targetDir))
      .rejects.toThrow("Failed to fetch resource")
  })
})

// ── WorkspaceUninstaller ─────────────────────────────────────────

describe("WorkspaceUninstaller", () => {
  it("removes installed directory", () => {
    const uninstaller = new WorkspaceUninstaller()
    const installPath = join(tmpDir, "skills", "test-skill")
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, "SKILL.md"), "content")

    uninstaller.uninstall("test-skill", "skill", installPath, tmpDir)

    expect(existsSync(installPath)).toBe(false)
  })

  it("rejects path traversal", () => {
    const uninstaller = new WorkspaceUninstaller()
    expect(() => uninstaller.uninstall("evil", "skill", "/etc/passwd", tmpDir))
      .toThrow("escapes workspace")
  })
})

// ── RegistryStore ────────────────────────────────────────────────

describe("RegistryStore", () => {
  it("registers and retrieves entries", () => {
    const store = new RegistryStore(join(tmpDir, "registry.json"))
    const manifest = makeManifest()
    const entry = store.register(manifest)

    expect(entry.name).toBe("test-skill")
    expect(entry.installed).toBe(false)
    expect(entry.description).toBeUndefined()
    expect(entry.tags).toEqual([])

    const found = store.get("test-skill", "skill")
    expect(found).toBeDefined()
    expect(found!.name).toBe("test-skill")
  })

  it("stores description and tags from manifest", () => {
    const store = new RegistryStore(join(tmpDir, "registry.json"))
    const manifest = makeManifest({ description: "A test skill", tags: ["test", "demo"] })
    const entry = store.register(manifest)

    expect(entry.description).toBe("A test skill")
    expect(entry.tags).toEqual(["test", "demo"])
  })

  it("lists with filters", () => {
    const store = new RegistryStore(join(tmpDir, "registry.json"))
    store.register(makeManifest({ name: "skill-a", tags: ["alpha"] }))
    store.register(makeManifest({ name: "skill-b", type: "agent", tags: ["beta"] }))

    expect(store.list({ type: "skill" })).toHaveLength(1)
    expect(store.list({ type: "agent" })).toHaveLength(1)
    expect(store.list({ tag: "alpha" })).toHaveLength(1)
  })

  it("updates installed status", () => {
    const store = new RegistryStore(join(tmpDir, "registry.json"))
    store.register(makeManifest())
    store.updateInstalled("test-skill", "skill", true, "/path", "hash123")

    const entry = store.get("test-skill", "skill")
    expect(entry!.installed).toBe(true)
    expect(entry!.installPath).toBe("/path")
    expect(entry!.contentHash).toBe("hash123")
  })
})

// ── DependencyResolver ───────────────────────────────────────────

describe("DependencyResolver", () => {
  it("resolves a single item with no dependencies", () => {
    const entries = new Map<string, RegistryEntry>()
    entries.set("a", { name: "a", type: "skill", version: "1.0.0", source: { type: "builtin", name: "a" }, dependencies: [], installed: false, tags: [], createdAt: "", updatedAt: "" })

    const resolver = new DependencyResolver((name) => entries.get(name))
    const order = resolver.resolveTree("a")

    expect(order).toEqual(["a"])
  })

  it("resolves transitive dependencies in topological order", () => {
    const entries = new Map<string, RegistryEntry>()
    entries.set("a", { name: "a", type: "skill", version: "1.0.0", source: { type: "builtin", name: "a" }, dependencies: ["b", "c"], installed: false, tags: [], createdAt: "", updatedAt: "" })
    entries.set("b", { name: "b", type: "skill", version: "1.0.0", source: { type: "builtin", name: "b" }, dependencies: ["c"], installed: false, tags: [], createdAt: "", updatedAt: "" })
    entries.set("c", { name: "c", type: "skill", version: "1.0.0", source: { type: "builtin", name: "c" }, dependencies: [], installed: false, tags: [], createdAt: "", updatedAt: "" })

    const resolver = new DependencyResolver((name) => entries.get(name))
    const order = resolver.resolveTree("a")

    // c before b before a (topological)
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("b"))
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"))
  })

  it("detects circular dependencies", () => {
    const entries = new Map<string, RegistryEntry>()
    entries.set("a", { name: "a", type: "skill", version: "1.0.0", source: { type: "builtin", name: "a" }, dependencies: ["b"], installed: false, tags: [], createdAt: "", updatedAt: "" })
    entries.set("b", { name: "b", type: "skill", version: "1.0.0", source: { type: "builtin", name: "b" }, dependencies: ["a"], installed: false, tags: [], createdAt: "", updatedAt: "" })

    const resolver = new DependencyResolver((name) => entries.get(name))
    expect(() => resolver.resolveTree("a")).toThrow("Circular dependency")
  })

  it("detects depth exceeded", () => {
    const entries = new Map<string, RegistryEntry>()
    for (let i = 0; i < 12; i++) {
      entries.set(`n${i}`, {
        name: `n${i}`, type: "skill", version: "1.0.0",
        source: { type: "builtin", name: `n${i}` },
        dependencies: i < 11 ? [`n${i + 1}`] : [],
        installed: false, tags: [], createdAt: "", updatedAt: "",
      })
    }

    const resolver = new DependencyResolver((name) => entries.get(name), 5)
    expect(() => resolver.resolveTree("n0")).toThrow("max depth")
  })

  it("finds reverse dependencies", () => {
    const entries: RegistryEntry[] = [
      { name: "a", type: "skill", version: "1.0.0", source: { type: "builtin", name: "a" }, dependencies: ["c"], installed: false, tags: [], createdAt: "", updatedAt: "" },
      { name: "b", type: "skill", version: "1.0.0", source: { type: "builtin", name: "b" }, dependencies: ["c"], installed: false, tags: [], createdAt: "", updatedAt: "" },
      { name: "c", type: "skill", version: "1.0.0", source: { type: "builtin", name: "c" }, dependencies: [], installed: false, tags: [], createdAt: "", updatedAt: "" },
    ]

    const resolver = new DependencyResolver(() => undefined)
    resolver.setGetAllEntries(() => entries)

    const reverse = resolver.getReverseDeps("c")
    expect(reverse).toContain("a")
    expect(reverse).toContain("b")
    expect(reverse).toHaveLength(2)
  })
})

// ── LockManager ──────────────────────────────────────────────────

describe("LockManager", () => {
  it("adds and retrieves lock entries", () => {
    const lm = new LockManager(join(tmpDir, "lock.json"))
    lm.add({ name: "a", type: "skill", version: "1.0.0", installPath: "/tmp/a", contentHash: "abc", installedAt: "2024-01-01" })

    const entry = lm.get("a", "skill")
    expect(entry).toBeDefined()
    expect(entry!.name).toBe("a")
    expect(entry!.contentHash).toBe("abc")
  })

  it("removes lock entries", () => {
    const lm = new LockManager(join(tmpDir, "lock.json"))
    lm.add({ name: "a", type: "skill", version: "1.0.0", installPath: "/tmp/a", contentHash: "abc", installedAt: "2024-01-01" })
    lm.remove("a", "skill")

    expect(lm.get("a", "skill")).toBeUndefined()
    expect(lm.list()).toHaveLength(0)
  })

  it("detects missing files as drift", () => {
    const lm = new LockManager(join(tmpDir, "lock.json"))
    lm.add({ name: "a", type: "skill", version: "1.0.0", installPath: "/nonexistent/path", contentHash: "abc", installedAt: "2024-01-01" })

    const drifts = lm.detectDrift()
    expect(drifts).toHaveLength(1)
    expect(drifts[0].issue).toBe("MISSING")
  })
})

// ── AuditLogger ──────────────────────────────────────────────────

describe("AuditLogger", () => {
  it("logs and reads audit entries", () => {
    const logger = new AuditLogger(join(tmpDir, "audit.jsonl"))
    logger.log({ action: "install", resource: "test", type: "skill", status: "success", detail: "OK" })

    const entries = logger.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe("install")
    expect(entries[0].resource).toBe("test")
  })

  it("filters by action and last-N", () => {
    const logger = new AuditLogger(join(tmpDir, "audit.jsonl"))
    logger.log({ action: "install", resource: "a", type: "skill", status: "success" })
    logger.log({ action: "uninstall", resource: "b", type: "skill", status: "success" })
    logger.log({ action: "install", resource: "c", type: "skill", status: "success" })

    expect(logger.read({ action: "install" })).toHaveLength(2)
    expect(logger.read({ last: 2 })).toHaveLength(2)
    // Cap at 1000 — H5 fix
    expect(logger.read({ last: 9999 })).toHaveLength(3)
  })

  it("maintains hash chain via prevHash", () => {
    const logger = new AuditLogger(join(tmpDir, "audit.jsonl"))
    logger.log({ action: "install", resource: "a", type: "skill", status: "success" })
    logger.log({ action: "install", resource: "b", type: "skill", status: "success" })

    const entries = logger.read()
    // Most recent first
    expect(entries[0].resource).toBe("b")
    expect(entries[0].prevHash).toBeDefined()
    expect(entries[1].prevHash).toBeUndefined() // first entry
  })
})

// ── InstallTransaction ───────────────────────────────────────────

describe("InstallTransaction", () => {
  it("rolls back in reverse order", () => {
    const tx = new InstallTransaction()
    const undone: string[] = []

    tx.addStep(() => { undone.push("first") })
    tx.addStep(() => { undone.push("second") })
    tx.addStep(() => { undone.push("third") })

    tx.rollback()

    expect(undone).toEqual(["third", "second", "first"])
  })

  it("execute rolls back on failure", async () => {
    const tx = new InstallTransaction()
    const undone: string[] = []

    await expect(tx.execute([
      { description: "step1", execute: () => {}, undo: () => { undone.push("undo1") } },
      { description: "step2", execute: () => { throw new Error("fail") }, undo: () => { undone.push("undo2") } },
    ])).rejects.toThrow("fail")

    // step1 completed, then step2 failed → rollback undoes step1
    expect(undone).toEqual(["undo1"])
  })
})

// ── ResourceManager ──────────────────────────────────────────────

describe("ResourceManager", () => {
  function createManager(): ResourceManager {
    return new ResourceManager({
      workspacePath: tmpDir,
      cachePath: join(tmpDir, "cache"),
      registryPath: join(tmpDir, "registry.json"),
      lockPath: join(tmpDir, "lock.json"),
      auditPath: join(tmpDir, "audit.jsonl"),
      providers: [makeProvider()],
    })
  }

  it("installs a resource end-to-end", async () => {
    const mgr = createManager()
    const result = await mgr.install("builtin:test-skill")

    expect(result.name).toBe("test-skill")
    expect(result.installed).toBe(true)

    // Verify files were created
    const skillDir = join(tmpDir, ".claude", "skills", "test-skill")
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true)
  })

  it("rejects install of already-installed resource", async () => {
    const mgr = createManager()
    await mgr.install("builtin:test-skill")
    await expect(mgr.install("builtin:test-skill")).rejects.toThrow("already installed")
  })

  it("rolls back on install failure (B2 fix)", async () => {
    // Test that the manager's install loop calls tx.rollback when a step fails
    // by using a provider that successfully resolves but fails on fetch
    const mainManifest = makeManifest({ name: "test-skill", dependencies: [] })

    let fetchCalled = false
    const provider: SourceProvider = {
      type: "builtin",
      resolve: async () => mainManifest,
      fetch: async (_manifest, _targetDir) => {
        fetchCalled = true
        throw new Error("disk full")
      },
      list: async () => [mainManifest],
    }

    const mgr = new ResourceManager({
      workspacePath: tmpDir,
      cachePath: join(tmpDir, "cache"),
      registryPath: join(tmpDir, "registry.json"),
      lockPath: join(tmpDir, "lock.json"),
      auditPath: join(tmpDir, "audit.jsonl"),
      providers: [provider],
    })

    await expect(mgr.install("builtin:test-skill")).rejects.toThrow()
    expect(fetchCalled).toBe(true)

    // Verify no partial install remains
    const skillDir = join(tmpDir, ".claude", "skills", "test-skill")
    expect(existsSync(skillDir)).toBe(false)

    // Verify audit logged the failure
    const audit = mgr.audit.read({ action: "install" })
    expect(audit.some(e => e.status === "failed")).toBe(true)
  })

  it("uninstalls a resource", async () => {
    const mgr = createManager()
    await mgr.install("builtin:test-skill")
    await mgr.uninstall("test-skill", "skill")

    const entry = mgr.info("test-skill", "skill")
    expect(entry!.installed).toBe(false)
  })

  it("doctor reports health checks including stale_locks (B8 fix)", () => {
    const mgr = createManager()
    const result = mgr.doctor()

    // Should have at least 4 checks: registry, lock, stale_locks, cache
    expect(result.checks.length).toBeGreaterThanOrEqual(4)
    const staleCheck = result.checks.find(c => c.name === "stale_locks")
    expect(staleCheck).toBeDefined()
    // stale_locks is no longer a hardcoded stub — it actually scans for lock files
    expect(typeof staleCheck!.healthy).toBe("boolean")
    expect(staleCheck!.detail).toBeDefined()
  })

  it("lists resources with filters", async () => {
    const mgr = createManager()
    await mgr.install("builtin:test-skill")

    const all = mgr.list()
    expect(all.length).toBeGreaterThan(0)

    const skills = mgr.list({ type: "skill" })
    expect(skills.some(e => e.name === "test-skill")).toBe(true)
  })
})
