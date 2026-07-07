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
 * Per-org singleton.
 * Concurrency control is handled by the server-level lock (middleware.ts).
 *
 * Five-node closed loop:
 *   INSTALL → REGISTER → VERIFY → UNINSTALL → VERIFY-CLEAN
 */

export interface ResourceManagerConfig {
  org: string
  basePath?: string
  corePackBase?: string
}

export class ResourceManager extends EventEmitter {
  readonly org: string
  readonly basePath: string
  private registry: RegistryStore
  private lock: LockManager
  private audit: AuditWriter
  private builtin: BuiltinProvider
  private local: LocalProvider
  private installVerifier: PostInstallVerifier
  private uninstallVerifier: PostUninstallVerifier
  private sourceManager: SourceManager

  constructor(config: ResourceManagerConfig) {
    super()
    this.org = config.org
    this.basePath = config.basePath ?? path.join(os.homedir(), ".octopus", "resources")
    this.registry = new RegistryStore(this.basePath)
    this.lock = new LockManager(this.basePath)
    this.audit = new AuditWriter(this.basePath)
    this.builtin = new BuiltinProvider({ corePackBase: config.corePackBase })
    this.local = new LocalProvider()
    this.installVerifier = new PostInstallVerifier()
    this.uninstallVerifier = new PostUninstallVerifier()
    this.sourceManager = new SourceManager({ org: config.org, basePath: this.basePath })
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
      group = req.group ?? "core-pack"
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
    let installed = 0
    let skipped = 0

    for (const res of resources) {
      const { cachePath } = this.sourceManager.getResourceFromSource(sourceName, res.path)
      const installPath = this.getInstallPath(res.type, res.name, group)

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

      const entry: ResourceEntry = {
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
      }
      this.registry.upsert(entry)
      this.lock.upsert({
        name: res.name,
        type: res.type,
        hash,
        lockedAt: new Date().toISOString(),
        installPath,
        fileCount,
      })
      installed++
    }

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

    for (const [key, disc] of discoveredMap) {
      const inst = installedMap.get(key)
      if (!inst) {
        added++
        continue
      }

      const { cachePath } = this.sourceManager.getResourceFromSource(sourceName, disc.path)
      const newHash = generateFileHash(cachePath)

      if (newHash !== inst.sourceHash) {
        const cacheStat = fs.statSync(cachePath)
        if (cacheStat.isFile()) {
          fs.mkdirSync(inst.installPath, { recursive: true })
          fs.copyFileSync(cachePath, path.join(inst.installPath, path.basename(cachePath)))
        } else {
          this.local.install(cachePath, inst.installPath)
        }
        const updatedEntry: ResourceEntry = {
          ...inst,
          sourceHash: generateFileHash(inst.installPath),
          syncedAt: new Date().toISOString(),
        }
        this.registry.upsert(updatedEntry)
        updated++
      } else {
        unchanged++
      }
    }

    for (const [key, inst] of installedMap) {
      if (!discoveredMap.has(key)) {
        const orphanEntry: ResourceEntry = { ...inst, status: "orphan" }
        this.registry.upsert(orphanEntry)
        removed++
      }
    }

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
}
