/**
 * Clone Git Source Lifecycle Integration Tests
 *
 * Verifies the full clone resource lifecycle:
 *   AC-13: Source discovery detects clones in a git repo
 *   AC-6:  Install clone from git source
 *   AC-7:  Activate clone copies to ~/.octopus/agent/clones/
 *   AC-9:  Uninstall with keepBackup=true creates backup
 *   AC-10: Uninstall with keepBackup=false performs clean removal
 *
 * Uses a local temp directory as a git repo fixture (no external dependencies).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { execSync } from "child_process"
import {
  SourceDiscovery,
  ResourceManager,
  RegistryStore,
  SourcesStore,
  TrustManager,
  type ResourceEntry,
} from "../resource"

// ── Test helpers ────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clone-lifecycle-"))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

/**
 * The TrustManager inside SourceManager always uses ~/.octopus/config.yaml
 * regardless of the ResourceManager basePath. These helpers save/restore
 * the real config so tests can add trust entries without side effects.
 */
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".octopus", "config.yaml")
let savedConfigContent: string | null = null
let configExistedBefore = false

function saveGlobalConfig(): void {
  configExistedBefore = fs.existsSync(GLOBAL_CONFIG_PATH)
  if (configExistedBefore) {
    savedConfigContent = fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8")
  } else {
    savedConfigContent = null
  }
}

function restoreGlobalConfig(): void {
  if (configExistedBefore && savedConfigContent !== null) {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, savedConfigContent, "utf-8")
  } else if (!configExistedBefore && fs.existsSync(GLOBAL_CONFIG_PATH)) {
    // Config didn't exist before — try to remove only the trust entries we added
    // If we created the file, remove it entirely
    try { fs.unlinkSync(GLOBAL_CONFIG_PATH) } catch { /* ignore */ }
  }
}

function makeCloneEntry(overrides: Partial<ResourceEntry> = {}): ResourceEntry {
  return {
    name: "test-reviewer",
    type: "clone",
    source: "git",
    ref: "git:test-source/clones/test-reviewer",
    group: "test-source",
    installed: true,
    verified: true,
    status: "installed",
    installedAt: new Date().toISOString(),
    installPath: "/tmp/test",
    dependsOn: [],
    activated: false,
    ...overrides,
  }
}

/**
 * Create a local git repo fixture with clone definitions.
 * Returns the path to the repo root.
 *
 * Structure:
 *   temp-repo/
 *   └── clones/
 *       └── test-reviewer/
 *           ├── persona.md    (with name, description in frontmatter)
 *           └── config.json   (with persona, skills, memoryScope)
 */
function createGitRepoWithClones(baseDir: string): string {
  const repoDir = path.join(baseDir, "test-clone-repo")
  fs.mkdirSync(repoDir, { recursive: true })

  // Initialize git repo
  execSync("git init", { cwd: repoDir, stdio: "pipe" })
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" })
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: "pipe" })

  // Create clone definition: clones/test-reviewer/
  const cloneDir = path.join(repoDir, "clones", "test-reviewer")
  fs.mkdirSync(cloneDir, { recursive: true })

  fs.writeFileSync(
    path.join(cloneDir, "persona.md"),
    [
      "---",
      'name: "Test Reviewer"',
      'description: "A test clone for code review"',
      "---",
      "",
      "# Test Reviewer Persona",
      "",
      "You are an expert code reviewer.",
      "",
    ].join("\n"),
    "utf-8",
  )

  fs.writeFileSync(
    path.join(cloneDir, "config.json"),
    JSON.stringify({
      persona: "test-reviewer",
      skills: ["code-review", "best-practices"],
      memoryScope: "project",
    }, null, 2),
    "utf-8",
  )

  // Commit the files
  execSync("git add .", { cwd: repoDir, stdio: "pipe" })
  execSync('git commit -m "Add clone definition"', { cwd: repoDir, stdio: "pipe" })

  return repoDir
}

// ── Test suites ─────────────────────────────────────────────────

describe("Clone Git Source Lifecycle", () => {
  let tmpDir: string
  let corePackDir: string
  let repoDir: string

  beforeEach(() => {
    tmpDir = createTempDir()
    corePackDir = createTempDir()
    repoDir = createGitRepoWithClones(tmpDir)
    // Save global config before each test (TrustManager writes to ~/.octopus/config.yaml)
    saveGlobalConfig()
  })

  afterEach(() => {
    // Restore global config first
    restoreGlobalConfig()
    cleanupDir(tmpDir)
    cleanupDir(corePackDir)
  })

  // ── AC-13: Source Discovery ──────────────────────────────────

  describe("AC-13: Source Discovery detects clones in git repo", () => {
    it("discovers clone resources from convention-based directory structure", () => {
      const discovery = new SourceDiscovery()
      const resources = discovery.discover(repoDir)

      const clones = resources.filter((r) => r.type === "clone")
      expect(clones).toHaveLength(1)
      expect(clones[0].name).toBe("test-reviewer")
      expect(clones[0].type).toBe("clone")
      expect(clones[0].path).toBe("clones/test-reviewer")
    })

    it("discovers clones alongside other resource types in the same repo", () => {
      // Add a rule to the same repo
      const rulesDir = path.join(repoDir, "rules")
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.writeFileSync(path.join(rulesDir, "test-rule.md"), "# Test Rule\n", "utf-8")

      // Add a skill
      const skillDir = path.join(repoDir, "skills", "test-skill")
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\n", "utf-8")

      // Re-commit
      execSync("git add .", { cwd: repoDir, stdio: "pipe" })
      execSync('git commit -m "Add rule and skill"', { cwd: repoDir, stdio: "pipe" })

      const discovery = new SourceDiscovery()
      const resources = discovery.discover(repoDir)

      expect(resources.find((r) => r.type === "clone" && r.name === "test-reviewer")).toBeDefined()
      expect(resources.find((r) => r.type === "rule" && r.name === "test-rule")).toBeDefined()
      expect(resources.find((r) => r.type === "skill" && r.name === "test-skill")).toBeDefined()
    })

    it("discovers multiple clones in the same repo", () => {
      // Add a second clone
      const clone2Dir = path.join(repoDir, "clones", "test-debugger")
      fs.mkdirSync(clone2Dir, { recursive: true })
      fs.writeFileSync(path.join(clone2Dir, "persona.md"), "# Test Debugger\n", "utf-8")
      fs.writeFileSync(
        path.join(clone2Dir, "config.json"),
        JSON.stringify({ persona: "test-debugger" }),
        "utf-8",
      )

      const discovery = new SourceDiscovery()
      const resources = discovery.discover(repoDir)

      const clones = resources.filter((r) => r.type === "clone")
      expect(clones).toHaveLength(2)
      expect(clones.map((c) => c.name).sort()).toEqual(["test-debugger", "test-reviewer"])
    })

    it("ignores clone directories without persona.md", () => {
      // Add a clone directory without persona.md
      const incompleteClone = path.join(repoDir, "clones", "incomplete-clone")
      fs.mkdirSync(incompleteClone, { recursive: true })
      fs.writeFileSync(path.join(incompleteClone, "config.json"), "{}", "utf-8")

      const discovery = new SourceDiscovery()
      const resources = discovery.discover(repoDir)

      const clones = resources.filter((r) => r.type === "clone")
      expect(clones).toHaveLength(1)
      expect(clones[0].name).toBe("test-reviewer")
    })

    it("discovers clones from manifest when octopus-resource.json exists", () => {
      // Add manifest file
      fs.writeFileSync(
        path.join(repoDir, "octopus-resource.json"),
        JSON.stringify({
          name: "test-source",
          clones: ["clones/test-reviewer"],
        }),
        "utf-8",
      )

      const discovery = new SourceDiscovery()
      const resources = discovery.discover(repoDir)

      const clones = resources.filter((r) => r.type === "clone")
      expect(clones).toHaveLength(1)
      expect(clones[0].name).toBe("test-reviewer")
    })
  })

  // ── AC-6: Install clone from git source ──────────────────────

  describe("AC-6: Install clone from git source", () => {
    it("installs clone via installFromSource with correct registry entry and files", async () => {
      // Set up the source cache to mimic a cloned git repo
      const sourceCacheDir = path.join(tmpDir, "sources", "test-source", "clones", "test-reviewer")
      fs.mkdirSync(sourceCacheDir, { recursive: true })

      // Copy clone files from the git repo to the source cache
      fs.copyFileSync(
        path.join(repoDir, "clones", "test-reviewer", "persona.md"),
        path.join(sourceCacheDir, "persona.md"),
      )
      fs.copyFileSync(
        path.join(repoDir, "clones", "test-reviewer", "config.json"),
        path.join(sourceCacheDir, "config.json"),
      )

      // Register the source in SourcesStore
      const sourcesStore = new SourcesStore(tmpDir)
      sourcesStore.upsert({
        name: "test-source",
        type: "git",
        url: "https://github.com/test/clone-repo",
        branch: "main",
        addedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        resourceCount: { skills: 0, agents: 0, workflows: 0, rules: 0, commands: 0, clones: 1 },
        cachePath: path.join(tmpDir, "sources", "test-source"),
        trusted: true,
      })

      // Add trust (must use global path since SourceManager uses ~/.octopus/config.yaml)
      const trustManager = new TrustManager(path.join(os.homedir(), ".octopus"))
      trustManager.addTrusted("https://github.com/test/clone-repo")

      // Create manager and install
      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })
      const result = manager.installFromSource(
        "test-source",
        "test-source",
        [{ type: "clone", name: "test-reviewer", path: "clones/test-reviewer" }],
        "cli",
      )

      // Assert: install result
      expect(result.installed).toBe(1)
      expect(result.skipped).toBe(0)

      // Assert: registry entry
      const entry = manager.get("clone", "test-reviewer")
      expect(entry).not.toBeNull()
      expect(entry?.type).toBe("clone")
      expect(entry?.source).toBe("git")
      expect(entry?.status).toBe("installed")
      expect(entry?.installed).toBe(true)
      expect(entry?.activated).toBe(false)
      expect(entry?.group).toBe("test-source")

      // Assert: files copied to installed directory
      expect(fs.existsSync(entry!.installPath)).toBe(true)
      expect(fs.existsSync(path.join(entry!.installPath, "persona.md"))).toBe(true)
      expect(fs.existsSync(path.join(entry!.installPath, "config.json"))).toBe(true)

      // Verify file content
      const personaContent = fs.readFileSync(path.join(entry!.installPath, "persona.md"), "utf-8")
      expect(personaContent).toContain("Test Reviewer Persona")
    })

    it("skips already-installed clones on re-install", async () => {
      const sourceCacheDir = path.join(tmpDir, "sources", "test-source", "clones", "test-reviewer")
      fs.mkdirSync(sourceCacheDir, { recursive: true })
      fs.writeFileSync(path.join(sourceCacheDir, "persona.md"), "# Test\n", "utf-8")
      fs.writeFileSync(path.join(sourceCacheDir, "config.json"), "{}", "utf-8")

      const sourcesStore = new SourcesStore(tmpDir)
      sourcesStore.upsert({
        name: "test-source",
        type: "git",
        url: "https://github.com/test/clone-repo",
        branch: "main",
        addedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        resourceCount: { skills: 0, agents: 0, workflows: 0, rules: 0, commands: 0, clones: 1 },
        cachePath: path.join(tmpDir, "sources", "test-source"),
        trusted: true,
      })

      const trustManager = new TrustManager(path.join(os.homedir(), ".octopus"))
      trustManager.addTrusted("https://github.com/test/clone-repo")

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })

      // First install
      const r1 = manager.installFromSource(
        "test-source", "test-source",
        [{ type: "clone", name: "test-reviewer", path: "clones/test-reviewer" }],
        "cli",
      )
      expect(r1.installed).toBe(1)

      // Second install — should skip
      const r2 = manager.installFromSource(
        "test-source", "test-source",
        [{ type: "clone", name: "test-reviewer", path: "clones/test-reviewer" }],
        "cli",
      )
      expect(r2.installed).toBe(0)
      expect(r2.skipped).toBe(1)
    })
  })

  // ── AC-7: Activate clone ─────────────────────────────────────

  describe("AC-7: Activate clone", () => {
    it("copies clone bundle to ~/.octopus/agent/clones/ and updates registry", async () => {
      // Set up installed clone files
      const cloneInstallDir = path.join(tmpDir, "installed", "clones", "test-group", "test-reviewer")
      fs.mkdirSync(cloneInstallDir, { recursive: true })
      fs.writeFileSync(
        path.join(cloneInstallDir, "persona.md"),
        "# Test Reviewer Persona\nYou are a code reviewer.",
        "utf-8",
      )
      fs.writeFileSync(
        path.join(cloneInstallDir, "config.json"),
        JSON.stringify({ persona: "test-reviewer", skills: ["code-review"] }),
        "utf-8",
      )

      // Register in registry
      const registry = new RegistryStore(tmpDir)
      registry.upsert(makeCloneEntry({
        installPath: cloneInstallDir,
        source: "builtin",
        ref: "builtin:test-reviewer",
        group: "test-group",
      }))

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })

      // Activate
      const result = await manager.activate("test-reviewer", "clone", "cli")

      // Assert: activatedTo path is under ~/.octopus/agent/clones/
      expect(result.activatedTo).toContain(path.join(".octopus", "agent", "clones", "test-reviewer"))
      expect(result.name).toBe("test-reviewer")
      expect(result.type).toBe("clone")

      // Assert: files exist at activation target
      expect(fs.existsSync(result.activatedTo)).toBe(true)
      expect(fs.existsSync(path.join(result.activatedTo, "persona.md"))).toBe(true)
      expect(fs.existsSync(path.join(result.activatedTo, "config.json"))).toBe(true)

      // Assert: registry updated with activated=true
      const entry = manager.get("clone", "test-reviewer")
      expect(entry?.activated).toBe(true)
      expect(entry?.activatedAt).toBeDefined()
      expect(entry?.activatedTo).toBe(result.activatedTo)

      // Cleanup: remove the activation target directory
      cleanupDir(result.activatedTo)
    })

    it("preserves file content when activating", async () => {
      const cloneInstallDir = path.join(tmpDir, "installed", "clones", "test-group", "content-test")
      fs.mkdirSync(cloneInstallDir, { recursive: true })

      const personaContent = "# Content Test\n\nDetailed persona description with **markdown**."
      const configContent = JSON.stringify({ persona: "content-test", version: 2 })

      fs.writeFileSync(path.join(cloneInstallDir, "persona.md"), personaContent, "utf-8")
      fs.writeFileSync(path.join(cloneInstallDir, "config.json"), configContent, "utf-8")

      const registry = new RegistryStore(tmpDir)
      registry.upsert(makeCloneEntry({
        name: "content-test",
        installPath: cloneInstallDir,
        source: "builtin",
        ref: "builtin:content-test",
      }))

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })
      const result = await manager.activate("content-test", "clone", "cli")

      // Verify file content is preserved
      expect(fs.readFileSync(path.join(result.activatedTo, "persona.md"), "utf-8")).toBe(personaContent)
      expect(fs.readFileSync(path.join(result.activatedTo, "config.json"), "utf-8")).toBe(configContent)

      cleanupDir(result.activatedTo)
    })
  })

  // ── AC-9: Uninstall with backup ──────────────────────────────

  describe("AC-9: Uninstall clone with keepBackup=true", () => {
    it("creates backup directory and removes installed files", async () => {
      // Set up installed clone
      const cloneInstallDir = path.join(tmpDir, "installed", "clones", "test-group", "test-reviewer")
      fs.mkdirSync(cloneInstallDir, { recursive: true })
      fs.writeFileSync(path.join(cloneInstallDir, "persona.md"), "# Backup Test\n", "utf-8")
      fs.writeFileSync(
        path.join(cloneInstallDir, "config.json"),
        JSON.stringify({ persona: "test-reviewer" }),
        "utf-8",
      )

      // Register
      const registry = new RegistryStore(tmpDir)
      registry.upsert(makeCloneEntry({
        installPath: cloneInstallDir,
        source: "builtin",
        ref: "builtin:test-reviewer",
        group: "test-group",
      }))

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })

      // Uninstall with keepBackup=true
      const result = await manager.uninstall({
        name: "test-reviewer",
        type: "clone",
        caller: "cli",
        keepBackup: true,
      })

      // Assert: uninstall succeeded
      expect(result.status).toBe("uninstalled")
      expect(result.verified).toBe(true)

      // Assert: backup directory created
      expect(result.backupPath).toBeDefined()
      expect(result.backupPath).toContain(path.join("backups", "clones", "test-reviewer"))
      expect(fs.existsSync(result.backupPath!)).toBe(true)

      // Assert: backup contains the original files
      expect(fs.existsSync(path.join(result.backupPath!, "persona.md"))).toBe(true)
      expect(fs.existsSync(path.join(result.backupPath!, "config.json"))).toBe(true)

      // Assert: installed directory removed
      expect(fs.existsSync(cloneInstallDir)).toBe(false)

      // Assert: registry entry removed
      expect(manager.get("clone", "test-reviewer")).toBeNull()
    })

    it("backup is restorable — persona.md content matches original", async () => {
      const cloneInstallDir = path.join(tmpDir, "installed", "clones", "test-group", "restore-test")
      fs.mkdirSync(cloneInstallDir, { recursive: true })

      const originalPersona = "# Restore Test\n\nThis persona should survive uninstall."
      fs.writeFileSync(path.join(cloneInstallDir, "persona.md"), originalPersona, "utf-8")
      fs.writeFileSync(path.join(cloneInstallDir, "config.json"), '{"v":1}', "utf-8")

      const registry = new RegistryStore(tmpDir)
      registry.upsert(makeCloneEntry({
        name: "restore-test",
        installPath: cloneInstallDir,
      }))

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })
      const result = await manager.uninstall({
        name: "restore-test",
        type: "clone",
        caller: "cli",
        keepBackup: true,
      })

      // Verify backup content matches original
      const backedUpPersona = fs.readFileSync(path.join(result.backupPath!, "persona.md"), "utf-8")
      expect(backedUpPersona).toBe(originalPersona)
    })
  })

  // ── AC-10: Uninstall without backup ──────────────────────────

  describe("AC-10: Uninstall clone with keepBackup=false", () => {
    it("performs clean removal with no backup directory", async () => {
      // Set up installed clone
      const cloneInstallDir = path.join(tmpDir, "installed", "clones", "test-group", "clean-test")
      fs.mkdirSync(cloneInstallDir, { recursive: true })
      fs.writeFileSync(path.join(cloneInstallDir, "persona.md"), "# Clean Test\n", "utf-8")

      // Register
      const registry = new RegistryStore(tmpDir)
      registry.upsert(makeCloneEntry({
        name: "clean-test",
        installPath: cloneInstallDir,
      }))

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })

      // Uninstall with keepBackup=false
      const result = await manager.uninstall({
        name: "clean-test",
        type: "clone",
        caller: "cli",
        keepBackup: false,
      })

      // Assert: uninstall succeeded
      expect(result.status).toBe("uninstalled")
      expect(result.verified).toBe(true)

      // Assert: no backup directory created
      expect(result.backupPath).toBeUndefined()

      // Verify no backup directory exists under backups/clones/
      const backupsDir = path.join(tmpDir, "backups", "clones")
      if (fs.existsSync(backupsDir)) {
        const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith("clean-test"))
        expect(backups).toHaveLength(0)
      }

      // Assert: installed directory removed
      expect(fs.existsSync(cloneInstallDir)).toBe(false)

      // Assert: registry entry removed
      expect(manager.get("clone", "clean-test")).toBeNull()
    })
  })

  // ── Full lifecycle: discover → install → activate → deactivate → uninstall ──

  describe("Full clone lifecycle (end-to-end)", () => {
    it("completes discover → install → activate → deactivate → uninstall with backup", async () => {
      // Step 1: Discover
      const discovery = new SourceDiscovery()
      const discovered = discovery.discover(repoDir)
      const cloneResource = discovered.find((r) => r.type === "clone" && r.name === "test-reviewer")
      expect(cloneResource).toBeDefined()

      // Step 2: Set up source cache and install
      const sourceCacheDir = path.join(tmpDir, "sources", "lifecycle-source", "clones", "test-reviewer")
      fs.mkdirSync(sourceCacheDir, { recursive: true })
      fs.copyFileSync(
        path.join(repoDir, "clones", "test-reviewer", "persona.md"),
        path.join(sourceCacheDir, "persona.md"),
      )
      fs.copyFileSync(
        path.join(repoDir, "clones", "test-reviewer", "config.json"),
        path.join(sourceCacheDir, "config.json"),
      )

      const sourcesStore = new SourcesStore(tmpDir)
      sourcesStore.upsert({
        name: "lifecycle-source",
        type: "git",
        url: "https://github.com/test/lifecycle-repo",
        branch: "main",
        addedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        resourceCount: { skills: 0, agents: 0, workflows: 0, rules: 0, commands: 0, clones: 1 },
        cachePath: path.join(tmpDir, "sources", "lifecycle-source"),
        trusted: true,
      })

      const trustManager = new TrustManager(path.join(os.homedir(), ".octopus"))
      trustManager.addTrusted("https://github.com/test/lifecycle-repo")

      const manager = new ResourceManager({ basePath: tmpDir, corePackBase: corePackDir })
      const installResult = manager.installFromSource(
        "lifecycle-source",
        "lifecycle-source",
        [{ type: "clone", name: "test-reviewer", path: "clones/test-reviewer" }],
        "cli",
      )
      expect(installResult.installed).toBe(1)

      const entry = manager.get("clone", "test-reviewer")
      expect(entry).not.toBeNull()
      expect(entry?.activated).toBe(false)

      // Step 3: Activate
      const activateResult = await manager.activate("test-reviewer", "clone", "cli")
      expect(fs.existsSync(activateResult.activatedTo)).toBe(true)

      const activatedEntry = manager.get("clone", "test-reviewer")
      expect(activatedEntry?.activated).toBe(true)

      // Step 4: Deactivate
      await manager.deactivate("test-reviewer", "clone", "cli")
      expect(fs.existsSync(activateResult.activatedTo)).toBe(false)

      const deactivatedEntry = manager.get("clone", "test-reviewer")
      expect(deactivatedEntry?.activated).toBe(false)

      // Step 5: Uninstall with backup
      const uninstallResult = await manager.uninstall({
        name: "test-reviewer",
        type: "clone",
        caller: "cli",
        keepBackup: true,
      })
      expect(uninstallResult.status).toBe("uninstalled")
      expect(uninstallResult.backupPath).toBeDefined()
      expect(fs.existsSync(uninstallResult.backupPath!)).toBe(true)
      expect(manager.get("clone", "test-reviewer")).toBeNull()

      // Cleanup activation target (may already be removed by deactivate)
      cleanupDir(activateResult.activatedTo)
    })
  })
})
