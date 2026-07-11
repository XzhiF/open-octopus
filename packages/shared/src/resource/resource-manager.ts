import fs from "fs"
import path from "path"
import os from "os"
import { EventEmitter } from "events"
import { ResourceError } from "./errors"
import { parseRef } from "./ref-parser"
import { RegistryStore } from "./registry-store"
import { LockManager } from "./lock-manager"
import { BuiltinProvider } from "./builtin-provider"
import { LocalProvider } from "./local-provider"
import { isPathWithinBase, listFilesRecursive, generateFileHash } from "./fs-utils"
import { PostInstallVerifier, PostUninstallVerifier } from "./verifier"
import { AuditWriter } from "./audit-writer"
import { SourceManager } from "./source-manager"
import {
  type ResourceEntry,
  type ResourceType,
  type InstallRequest,
  type InstallResponse,
  type UninstallRequest,
  type UninstallResponse,
  type ResourceListResponse,
  type VerifyResult,
  type BuiltinCatalogEntry,
  type ResourceAuditCaller,
  SAFE_NAME_RE,
} from "./types"

/**
 * ResourceManager — orchestrates install/uninstall/verify lifecycle.
 * Global singleton (not org-scoped).
 * Concurrency control is handled by the server-level lock (middleware.ts).
 *
 * Five-node closed loop:
 *   INSTALL → REGISTER → VERIFY → UNINSTALL → VERIFY-CLEAN
 */

export interface ResourceManagerConfig {
  basePath?: string
  corePackBase?: string
}

export class ResourceManager extends EventEmitter {
  readonly basePath: string
  private registry: RegistryStore
  private lock: LockManager
  private audit: AuditWriter
  private builtin: BuiltinProvider
  private local: LocalProvider
  private installVerifier: PostInstallVerifier
  private uninstallVerifier: PostUninstallVerifier
  private sourceManager: SourceManager

  constructor(config: ResourceManagerConfig = {}) {
    super()
    this.basePath = config.basePath ?? path.join(os.homedir(), ".octopus", "resources")
    this.registry = new RegistryStore(this.basePath)
    this.lock = new LockManager(this.basePath)
    this.audit = new AuditWriter(this.basePath)
    this.builtin = new BuiltinProvider({ corePackBase: config.corePackBase })
    this.local = new LocalProvider()
    this.installVerifier = new PostInstallVerifier()
    this.uninstallVerifier = new PostUninstallVerifier()
    this.sourceManager = new SourceManager({ basePath: this.basePath })
  }

  // ── Install ───────────────────────────────────────────────────

  async install(req: InstallRequest): Promise<InstallResponse> {
    const parsed = parseRef(req.ref)
    let type: ResourceType
    let name: string
    let group: string
    let sourceCopyPath: string | undefined

    // Resolve name/type/path based on source
    if (parsed.source === "git") {
      // git:sourceName/resourcePath — resolve from source cache first
      const [sourceName, ...rest] = parsed.name.split("/")
      const resourcePath = rest.join("/")
      const { cachePath, type: detectedType } = this.sourceManager.getResourceFromSource(sourceName, resourcePath)
      type = req.type ?? detectedType
      name = path.basename(resourcePath).replace(/\.(md|yaml|yml)$/, "")
      group = req.group ?? sourceName
      sourceCopyPath = cachePath
    } else if (parsed.source === "builtin") {
      type = this.detectType(parsed.name, parsed.source, req.type)
      name = parsed.name
      group = req.group ?? "built-in"
    } else {
      // local
      type = this.detectType(parsed.name, parsed.source, req.type)
      name = parsed.name
      group = req.group ?? "local"
    }

    // Validate group name to prevent path traversal
    if (!SAFE_NAME_RE.test(group)) {
      throw new ResourceError("INVALID_NAME", `Invalid group name: ${group}`)
    }

    // Validate name
    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`)
    }

    // Check if already installed
    const existing = this.registry.get(type, name)
    if (existing?.installed) {
      throw new ResourceError("RESOURCE_ALREADY_EXISTS", `Resource ${type}/${name} is already installed`)
    }

    const installPath = this.getInstallPath(type, name, group)
    if (!isPathWithinBase(installPath, this.basePath)) {
      throw new ResourceError("PATH_TRAVERSAL", `Install path escapes base: ${installPath}`)
    }

    // Audit-first: write install intent
    this.audit.append("install", { name, type, source: parsed.source }, req.caller)

    // Install files
    let fileCount = 0
    let hash = ""

    if (parsed.source === "builtin") {
      const result = this.builtin.install(name, type, installPath)
      fileCount = result.fileCount
      hash = result.hash
    } else if (parsed.source === "local") {
      const result = this.local.install(parsed.name, installPath)
      fileCount = result.fileCount
      hash = result.hash
    } else if (parsed.source === "git" && sourceCopyPath) {
      const result = this.local.install(sourceCopyPath, installPath)
      fileCount = result.fileCount
      hash = result.hash
    }

    // Register
    const entry: ResourceEntry = {
      name,
      type,
      source: parsed.source,
      ref: req.ref,
      group,
      installed: true,
      verified: false,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath,
      dependsOn: [],
      sourceHash: hash,
    }
    this.registry.upsert(entry)

    // Lock
    this.lock.upsert({
      name,
      type,
      hash,
      lockedAt: new Date().toISOString(),
      installPath,
      fileCount,
    })

    // Verify
    const verifyResult = this.installVerifier.verify(type, name, installPath, {
      registry: this.registry,
      lock: this.lock,
    })

    // Update verified status
    entry.verified = verifyResult.passed
    entry.status = verifyResult.passed ? "installed" : "installed_but_unverified"
    this.registry.upsert(entry)

    if (!verifyResult.passed) {
      this.audit.append("verify_warn", { name, type, source: parsed.source }, req.caller, {
        steps: verifyResult.steps,
      })
    }

    // Update CLAUDE.md with current resource inventory
    this.updateClaudeMd()

    // Emit event (预埋 — Phase 4+ consumers)
    this.emit("install", entry)

    return {
      name,
      type,
      source: parsed.source,
      status: entry.status,
      installPath,
      installedAt: entry.installedAt,
    }
  }

  // ── Install or Upgrade (for setup) ────────────────────────────

  /**
   * Install a resource if not present, or upgrade if already installed.
   * Used by `octopus setup` to ensure core-pack resources are up-to-date.
   * Always replaces files, updates sourceHash, and sets installedAt to now.
   */
  async installOrUpgrade(req: InstallRequest): Promise<InstallResponse> {
    const parsed = parseRef(req.ref)
    const type = req.type ?? this.detectType(parsed.name, parsed.source, req.type)
    const name = parsed.name
    const group = req.group ?? (parsed.source === "builtin" ? "built-in" : "local")

    if (!SAFE_NAME_RE.test(group)) {
      throw new ResourceError("INVALID_NAME", `Invalid group name: ${group}`)
    }
    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`)
    }

    const installPath = this.getInstallPath(type, name, group)
    if (!isPathWithinBase(installPath, this.basePath)) {
      throw new ResourceError("PATH_TRAVERSAL", `Install path escapes base: ${installPath}`)
    }

    // Delete old files if exists (direct replacement strategy)
    if (fs.existsSync(installPath)) {
      try {
        fs.rmSync(installPath, { recursive: true, force: true })
      } catch (err: any) {
        throw new ResourceError("FILE_DELETE_FAILED", `Failed to delete old ${installPath}: ${err.message}`)
      }
    }

    // Audit
    this.audit.append("install_or_upgrade", { name, type, source: parsed.source }, req.caller)

    // Install files
    let fileCount = 0
    let hash = ""

    if (parsed.source === "builtin") {
      const result = this.builtin.install(name, type, installPath)
      fileCount = result.fileCount
      hash = result.hash
    } else if (parsed.source === "local") {
      const result = this.local.install(parsed.name, installPath)
      fileCount = result.fileCount
      hash = result.hash
    } else if (parsed.source === "git") {
      const [sourceName, ...rest] = parsed.name.split("/")
      const resourcePath = rest.join("/")
      const { cachePath } = this.sourceManager.getResourceFromSource(sourceName, resourcePath)
      const result = this.local.install(cachePath, installPath)
      fileCount = result.fileCount
      hash = result.hash
    }

    // Register (upsert)
    const entry: ResourceEntry = {
      name,
      type,
      source: parsed.source,
      ref: req.ref,
      group,
      installed: true,
      verified: false,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath,
      dependsOn: [],
      sourceHash: hash,
    }
    this.registry.upsert(entry)

    // Lock
    this.lock.upsert({
      name,
      type,
      hash,
      lockedAt: new Date().toISOString(),
      installPath,
      fileCount,
    })

    // Verify
    const verifyResult = this.installVerifier.verify(type, name, installPath, {
      registry: this.registry,
      lock: this.lock,
    })

    entry.verified = verifyResult.passed
    entry.status = verifyResult.passed ? "installed" : "installed_but_unverified"
    this.registry.upsert(entry)

    this.emit("install", entry)

    return {
      name,
      type,
      source: parsed.source,
      status: entry.status,
      installPath,
      installedAt: entry.installedAt,
    }
  }

  /**
   * Register an already-installed resource in the registry.
   * Caller is responsible for having placed files at the correct install path.
   * Used by archive-service which copies files before registering.
   */
  registerInstalled(req: {
    name: string
    type: ResourceType
    group: string
    source?: string
  }): ResourceEntry {
    const { name, type, group } = req
    const source = (req.source ?? "local") as ResourceEntry["source"]

    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`)
    }
    if (!SAFE_NAME_RE.test(group)) {
      throw new ResourceError("INVALID_NAME", `Invalid group name: ${group}`)
    }

    const installPath = this.getInstallPath(type, name, group)
    if (!isPathWithinBase(installPath, this.basePath)) {
      throw new ResourceError("PATH_TRAVERSAL", `Install path escapes base: ${installPath}`)
    }

    const hash = fs.existsSync(installPath) ? generateFileHash(installPath) : ""

    const entry: ResourceEntry = {
      name,
      type,
      source,
      ref: `${source}:${name}`,
      group,
      installed: true,
      verified: false,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath,
      dependsOn: [],
      sourceHash: hash,
    }
    this.registry.upsert(entry)
    return entry
  }

  // ── Uninstall ─────────────────────────────────────────────────

  async uninstall(req: UninstallRequest): Promise<UninstallResponse> {
    const { name, type } = req

    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`)
    }

    const entry = this.registry.get(type, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    // Check reverse dependencies
    const dependents = this.registry.findDependents(type, name)
    if (dependents.length > 0) {
      const depNames = dependents.map((d) => `${d.type}/${d.name}`).join(", ")
      throw new ResourceError(
        "DEPENDENCY_BLOCKED",
        `Cannot uninstall: ${dependents.length} resource(s) depend on ${name}: [${depNames}]`,
      )
    }

    const installPath = entry.installPath

    // Audit-first
    this.audit.append("uninstall", { name, type, source: entry.source }, req.caller)

    // Delete files
    try {
      if (fs.existsSync(installPath)) {
        fs.rmSync(installPath, { recursive: true, force: true })
      }
    } catch (err: any) {
      throw new ResourceError("FILE_DELETE_FAILED", `Failed to delete ${installPath}: ${err.message}`)
    }

    // Remove from registry
    this.registry.remove(type, name)

    // Remove from lock
    this.lock.remove(type, name)

    // Verify clean
    const verifyResult = this.uninstallVerifier.verify(type, name, installPath, {
      registry: this.registry,
      lock: this.lock,
    })

    // Update CLAUDE.md with current resource inventory
    this.updateClaudeMd()

    this.emit("uninstall", { name, type, verified: verifyResult.passed })

    return {
      name,
      type,
      status: "uninstalled" as const,
      verified: verifyResult.passed,
    }
  }

  // ── List ──────────────────────────────────────────────────────

  list(filter?: { type?: ResourceType; query?: string; installed?: boolean }): ResourceListResponse {
    const resources = this.registry.list(filter)
    return { resources, total: resources.length }
  }

  // ── Detail ────────────────────────────────────────────────────

  get(type: ResourceType, name: string): ResourceEntry | null {
    return this.registry.get(type, name) ?? null
  }

  // ── Verify ────────────────────────────────────────────────────

  verify(type: ResourceType, name: string): VerifyResult {
    const entry = this.registry.get(type, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    return this.installVerifier.verify(type, name, entry.installPath, {
      registry: this.registry,
      lock: this.lock,
    })
  }

  // ── Stats ─────────────────────────────────────────────────────

  stats() {
    return this.registry.stats()
  }

  // ── Audit ─────────────────────────────────────────────────────

  auditQuery(filter?: { action?: string; last?: number }) {
    return this.audit.query(filter as any)
  }

  // ── Builtin Catalog ───────────────────────────────────────────

  listBuiltin(): BuiltinCatalogEntry[] {
    return this.builtin.list()
  }

  // ── Files ─────────────────────────────────────────────────────

  /** List files in an installed resource directory */
  listFiles(type: ResourceType, name: string): string[] {
    const entry = this.registry.get(type, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    if (!fs.existsSync(entry.installPath)) {
      return []
    }

    return listFilesRecursive(entry.installPath)
  }

  /** Read a file from an installed resource */
  readFile(type: ResourceType, name: string, filePath: string): string {
    const entry = this.registry.get(type, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    const fullPath = path.join(entry.installPath, filePath)

    // Reject symlinks at source before resolving (narrows TOCTOU window)
    try {
      const srcStat = fs.lstatSync(fullPath)
      if (srcStat.isSymbolicLink()) {
        throw new ResourceError("SYMLINK_REJECTED", `Symlinks not allowed: ${filePath}`)
      }
    } catch (err: any) {
      if (err instanceof ResourceError) throw err
      throw new ResourceError("RESOURCE_NOT_FOUND", `File not found: ${filePath}`)
    }

    // Resolve and verify path stays within install directory
    let realFullPath: string
    let realBasePath: string
    try {
      realFullPath = fs.realpathSync(fullPath)
      realBasePath = fs.realpathSync(entry.installPath)
    } catch {
      throw new ResourceError("RESOURCE_NOT_FOUND", `File not found: ${filePath}`)
    }

    if (!isPathWithinBase(realFullPath, realBasePath)) {
      throw new ResourceError("PATH_TRAVERSAL", "Cannot read file outside resource directory")
    }

    try {
      return fs.readFileSync(realFullPath, "utf-8")
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new ResourceError("RESOURCE_NOT_FOUND", `File not found: ${filePath}`)
      }
      throw err
    }
  }

  // ── Source Manager ───────────────────────────────────────────

  getSourceManager(): SourceManager {
    return this.sourceManager
  }

  // ── Source Install ──────────────────────────────────────────

  installFromSource(
    sourceName: string,
    group: string,
    resources: Array<{ type: ResourceType; name: string; path: string }>,
    caller: ResourceAuditCaller,
  ): { installed: number; skipped: number } {
    // Validate group name to prevent path traversal
    if (!SAFE_NAME_RE.test(group)) {
      throw new ResourceError("INVALID_NAME", `Invalid group name: ${group}`)
    }

    let installed = 0
    let skipped = 0
    const pendingEntries: ResourceEntry[] = []
    const pendingLocks: Array<{ name: string; type: ResourceType; hash: string; lockedAt: string; installPath: string; fileCount: number }> = []

    for (const res of resources) {
      // Validate resource name — same guards as install()
      if (!SAFE_NAME_RE.test(res.name)) {
        throw new ResourceError("INVALID_NAME", `Invalid resource name: ${res.name}`)
      }

      const installPath = this.getInstallPath(res.type, res.name, group)
      if (!isPathWithinBase(installPath, this.basePath)) {
        throw new ResourceError("PATH_TRAVERSAL", `Install path escapes base: ${installPath}`)
      }

      const { cachePath } = this.sourceManager.getResourceFromSource(sourceName, res.path)

      // Skip if already installed
      const existing = this.registry.get(res.type, res.name)
      if (existing?.installed) {
        skipped++
        continue
      }

      // Copy from cache — handle single files (agents) vs directories (skills)
      let hash: string
      let fileCount: number
      const cacheStat = fs.statSync(cachePath)
      if (cacheStat.isFile()) {
        fs.mkdirSync(installPath, { recursive: true })
        fs.copyFileSync(cachePath, path.join(installPath, path.basename(cachePath)))
        fileCount = 1
        hash = generateFileHash(installPath)
      } else {
        const result = this.local.install(cachePath, installPath)
        fileCount = result.fileCount
        hash = result.hash
      }

      pendingEntries.push({
        name: res.name,
        type: res.type,
        source: "git",
        ref: `git:${sourceName}/${res.path}`,
        group,
        installed: true,
        verified: true,
        status: "installed",
        installedAt: new Date().toISOString(),
        scope: "org",
        installPath,
        dependsOn: [],
        sourceHash: hash,
      })
      pendingLocks.push({
        name: res.name,
        type: res.type,
        hash,
        lockedAt: new Date().toISOString(),
        installPath,
        fileCount,
      })
      installed++
    }

    // Single batch write instead of per-entry upsert
    this.registry.batchUpsert(pendingEntries)
    this.lock.batchUpsert(pendingLocks)

    this.audit.append(
      "source_install",
      { name: sourceName, type: "skill" as ResourceType, source: "git" },
      caller,
      { group, installed, skipped, total: resources.length },
    )

    return { installed, skipped }
  }

  // ── Source Sync ─────────────────────────────────────────────

  syncSource(sourceName: string, caller: ResourceAuditCaller): {
    sourceName: string
    updated: number
    added: number
    removed: number
    unchanged: number
  } {
    const syncResult = this.sourceManager.sync(sourceName, caller)
    const discovered = syncResult.newResources
    const group = sourceName

    const installed = this.registry.list({}).filter(
      (r) => r.group === group && r.source === "git",
    )

    let updated = 0
    let added = 0
    let removed = 0
    let unchanged = 0

    const discoveredMap = new Map(discovered.map((d) => [`${d.type}:${d.name}`, d]))
    const installedMap = new Map(installed.map((i) => [`${i.type}:${i.name}`, i]))

    const pendingUpserts: ResourceEntry[] = []

    for (const [key, disc] of discoveredMap) {
      const inst = installedMap.get(key)
      if (!inst) {
        added++
        continue
      }

      const { cachePath } = this.sourceManager.getResourceFromSource(sourceName, disc.path)
      const newHash = generateFileHash(cachePath)

      if (newHash !== inst.sourceHash) {
        // Validate install path hasn't been tampered
        if (!isPathWithinBase(inst.installPath, this.basePath)) {
          throw new ResourceError("PATH_TRAVERSAL", `Sync target escapes base: ${inst.installPath}`)
        }

        const cacheStat = fs.statSync(cachePath)
        if (cacheStat.isFile()) {
          fs.mkdirSync(inst.installPath, { recursive: true })
          fs.copyFileSync(cachePath, path.join(inst.installPath, path.basename(cachePath)))
        } else {
          this.local.install(cachePath, inst.installPath)
        }
        pendingUpserts.push({
          ...inst,
          sourceHash: generateFileHash(inst.installPath),
          syncedAt: new Date().toISOString(),
        })
        updated++
      } else {
        unchanged++
      }
    }

    for (const [key, inst] of installedMap) {
      if (!discoveredMap.has(key)) {
        pendingUpserts.push({ ...inst, status: "orphan" })
        removed++
      }
    }

    // Single batch write instead of per-entry upsert
    this.registry.batchUpsert(pendingUpserts)

    this.audit.append(
      "source_sync",
      { name: sourceName, type: "skill" as ResourceType, source: "git" },
      caller,
      { updated, added, removed, unchanged },
    )

    return { sourceName, updated, added, removed, unchanged }
  }

  // ── Health ────────────────────────────────────────────────────

  health(): { ok: boolean; basePath: string; registryCount: number } {
    return {
      ok: true,
      basePath: this.basePath,
      registryCount: this.registry.count(),
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private getInstallPath(type: ResourceType, name: string, group: string): string {
    // Centralized: all installed resources under resources/installed/{type}s/{group}/{name}/
    // Keeps registry, lock, audit, and installed files co-located.
    const subdir = type === "skill" ? "skills" : type === "agent" ? "agents" : "workflows"
    return path.join(this.basePath, "installed", subdir, group, name)
  }

  private detectType(name: string, source: string, typeHint?: ResourceType): ResourceType {
    // If caller provides explicit type, use it
    if (typeHint) return typeHint

    // For builtin: check which directory has it
    if (source === "builtin") {
      if (this.builtin.exists(name, "skill")) return "skill"
      if (this.builtin.exists(name, "agent")) return "agent"
      throw new ResourceError("BUILTIN_NOT_FOUND", `Builtin resource '${name}' not found in skills or agents`)
    }

    // For local: default to skill
    return "skill"
  }

  // ── CLAUDE.md Auto-Update ──────────────────────────────────

  private updateClaudeMd(): void {
    const candidates = [
      path.join(process.cwd(), "CLAUDE.md"),
      path.join(process.cwd(), "..", "CLAUDE.md"),
    ]

    const claudePath = candidates.find((p) => fs.existsSync(p))
    if (!claudePath) return

    const content = fs.readFileSync(claudePath, "utf-8")
    const marker = "## 可用资源 (Octopus 资源库)"
    const endMarker = "<!-- /octopus-resources -->"

    const resources = this.registry.list({})
    const skills = resources.filter((r) => r.type === "skill" && r.installed)
    const agents = resources.filter((r) => r.type === "agent" && r.installed)

    let section = `${marker}\n<!-- octopus-resources -->\n\n`
    if (skills.length > 0) {
      section += `### Skills\n`
      for (const s of skills) {
        section += `- ${s.name} (${s.group})\n`
      }
      section += "\n"
    }
    if (agents.length > 0) {
      section += `### Agents\n`
      for (const a of agents) {
        section += `- ${a.name} (${a.group})\n`
      }
      section += "\n"
    }
    section += `### 使用方式\n`
    section += `- 搜索更多: 使用 octo-resource-manager skill\n`
    section += `- 浏览全部: octopus resource list\n\n`
    section += endMarker

    const startIdx = content.indexOf(marker)
    const endIdx = content.indexOf(endMarker)

    let newContent: string
    if (startIdx >= 0 && endIdx >= 0) {
      newContent = content.slice(0, startIdx) + section + content.slice(endIdx + endMarker.length)
    } else {
      newContent = content + "\n\n" + section
    }

    fs.writeFileSync(claudePath, newContent, "utf-8")
  }

  // ── Builtin Auto-Registration ──────────────────────────────────

  /**
   * Register all core-pack builtin resources into the registry.
   * Resources are registered as installed with group "built-in".
   * Already-registered entries are skipped (idempotent).
   */
  registerBuiltins(): { registered: number; skipped: number } {
    const catalog = this.builtin.list()
    let registered = 0
    let skipped = 0

    for (const entry of catalog) {
      const existing = this.registry.get(entry.type, entry.name)
      if (existing) {
        skipped++
        continue
      }

      const installPath = this.getInstallPath(entry.type, entry.name, "built-in")
      const registryEntry: ResourceEntry = {
        name: entry.name,
        type: entry.type,
        source: "builtin",
        ref: `builtin:${entry.name}`,
        group: "built-in",
        installed: true,
        verified: true,
        status: "installed",
        installedAt: new Date().toISOString(),
        scope: "org",
        installPath,
        dependsOn: [],
      }
      this.registry.upsert(registryEntry)
      registered++
    }

    return { registered, skipped }
  }
}
