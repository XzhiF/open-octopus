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
import { isPathWithinBase, listFilesRecursive } from "./fs-utils"
import { PostInstallVerifier, PostUninstallVerifier } from "./verifier"
import { AuditWriter } from "./audit-writer"
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
 * Per-org singleton. All operations are serialized via withResourceLock.
 *
 * Five-node closed loop:
 *   INSTALL → REGISTER → VERIFY → UNINSTALL → VERIFY-CLEAN
 */

const LOCK_TIMEOUT_MS = 30_000

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
  private activeLocks = new Map<string, Promise<void>>()

  constructor(config: ResourceManagerConfig) {
    super()
    this.org = config.org
    this.basePath = config.basePath ?? path.join(os.homedir(), ".octopus", "orgs", config.org, "resources")
    this.registry = new RegistryStore(this.basePath)
    this.lock = new LockManager(this.basePath)
    this.audit = new AuditWriter(this.basePath)
    this.builtin = new BuiltinProvider({ corePackBase: config.corePackBase })
    this.local = new LocalProvider()
    this.installVerifier = new PostInstallVerifier()
    this.uninstallVerifier = new PostUninstallVerifier()
  }

  // ── Install ───────────────────────────────────────────────────

  async install(req: InstallRequest): Promise<InstallResponse> {
    const parsed = parseRef(req.ref)
    const type = this.detectType(parsed.name, parsed.source)
    const name = parsed.name

    // Validate name
    if (!SAFE_NAME_RE.test(name)) {
      throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`)
    }

    // Check if already installed
    const existing = this.registry.get(type, name)
    if (existing?.installed) {
      throw new ResourceError("RESOURCE_ALREADY_EXISTS", `Resource ${type}/${name} is already installed`)
    }

    const installPath = this.getInstallPath(type, name)

    return this.withResourceLock(`${type}:${name}`, async () => {
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
      }

      // Register
      const entry: ResourceEntry = {
        name,
        type,
        source: parsed.source,
        ref: req.ref,
        installed: true,
        verified: false,
        status: "installed",
        installedAt: new Date().toISOString(),
        scope: "org",
        installPath,
        dependsOn: [],
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
    })
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

    return this.withResourceLock(`${type}:${name}`, async () => {
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
    })
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

    // B6 fix: use realpathSync to resolve symlinks before path check (TOCTOU prevention)
    let realFullPath: string
    let realBasePath: string
    try {
      realFullPath = fs.realpathSync(fullPath)
      realBasePath = fs.realpathSync(entry.installPath)
    } catch {
      throw new ResourceError("RESOURCE_NOT_FOUND", `File not found: ${filePath}`)
    }

    // Security: prevent path traversal via symlinks
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

  // ── Health ────────────────────────────────────────────────────

  health(): { ok: boolean; basePath: string; registryCount: number } {
    return {
      ok: true,
      basePath: this.basePath,
      registryCount: this.registry.count(),
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private getInstallPath(type: ResourceType, name: string): string {
    // Install to ~/.octopus/orgs/{org}/.claude/{type}s/{name}/
    const orgBase = path.join(os.homedir(), ".octopus", "orgs", this.org)
    const subdir = type === "skill" ? "skills" : type === "agent" ? "agents" : "workflows"
    return path.join(orgBase, ".claude", subdir, name)
  }

  private detectType(name: string, source: string): ResourceType {
    // For builtin: check which directory has it
    if (source === "builtin") {
      if (this.builtin.exists(name, "skill")) return "skill"
      if (this.builtin.exists(name, "agent")) return "agent"
      throw new ResourceError("BUILTIN_NOT_FOUND", `Builtin resource '${name}' not found in skills or agents`)
    }

    // For local: default to skill
    return "skill"
  }

  /** Serialize operations per resource key with timeout */
  private async withResourceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.activeLocks.get(key)
    if (existing) {
      throw new ResourceError("LOCK_BUSY", `Operation in progress for ${key}`)
    }

    let release!: () => void
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve
    })

    this.activeLocks.set(key, lockPromise)

    const timeout = setTimeout(() => {
      this.activeLocks.delete(key)
      release()
    }, LOCK_TIMEOUT_MS)

    try {
      return await fn()
    } finally {
      clearTimeout(timeout)
      this.activeLocks.delete(key)
      release()
    }
  }
}
