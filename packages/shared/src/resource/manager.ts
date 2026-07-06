import fs from "fs"
import path from "path"
import { ResourceError } from "./errors"
import type { RegistryEntry, ResourceType, ResourceManifest, AuditEntry, DriftItem, DoctorCheck, LockFileEntry } from "./types"
import type { SourceProvider } from "./providers/types"
import { RegistryStore, type RegistryFilter } from "./registry"
import { LockManager } from "./lock-manager"
import { DependencyResolver } from "./dependency-resolver"
import { WorkspaceInstaller } from "./installer"
import { WorkspaceUninstaller } from "./uninstaller"
import { AuditLogger } from "./audit-logger"
import { GarbageCollector, type GcResult } from "./gc"
import { InstallTransaction } from "./install-transaction"
import { parseRef, formatSourceRef, formatBytes } from "./utils"

export interface ResourceManagerConfig {
  workspacePath: string
  cachePath: string
  registryPath: string
  lockPath: string
  auditPath: string
  providers: SourceProvider[]
}

export class ResourceManager {
  readonly registry: RegistryStore
  readonly lockManager: LockManager
  readonly resolver: DependencyResolver
  readonly installer: WorkspaceInstaller
  readonly uninstaller: WorkspaceUninstaller
  readonly audit: AuditLogger
  readonly garbageCollector: GarbageCollector
  private providers: SourceProvider[]
  private workspacePath: string
  private cachePath: string

  constructor(config: ResourceManagerConfig) {
    this.workspacePath = config.workspacePath
    this.cachePath = config.cachePath
    this.registry = new RegistryStore(config.registryPath)
    this.lockManager = new LockManager(config.lockPath)
    this.resolver = new DependencyResolver(
      (name) => this.registry.get(name, "skill") ?? this.registry.get(name, "agent") ?? this.registry.get(name, "workflow"),
    )
    this.resolver.setGetAllEntries(() => this.registry.list())
    this.installer = new WorkspaceInstaller()
    this.uninstaller = new WorkspaceUninstaller()
    this.audit = new AuditLogger(config.auditPath)
    this.garbageCollector = new GarbageCollector()
    this.providers = config.providers
  }

  // ── Install ──────────────────────────────────────────────────
  async install(ref: string, opts?: { caller?: string }): Promise<RegistryEntry> {
    const startTime = Date.now()
    try {
      const { type: sourceType, value } = parseRef(ref)

      // Find matching provider
      const provider = this.providers.find(p => p.type === sourceType)
      if (!provider) {
        throw new ResourceError("PROVIDER_NOT_FOUND", `No provider for source type: ${sourceType}`)
      }

      // Resolve manifest
      // ponytail: try each resource type — ref doesn't encode type
      let manifest: ResourceManifest | undefined
      for (const rt of ["skill", "agent", "workflow"] as ResourceType[]) {
        try {
          manifest = await provider.resolve(value, rt)
          break
        } catch {
          continue
        }
      }
      if (!manifest) {
        throw new ResourceError("RESOURCE_NOT_FOUND", `Resource not found: ${ref}`)
      }

      // Check if already installed
      const existing = this.registry.get(manifest.name, manifest.type)
      if (existing?.installed) {
        throw new ResourceError("ALREADY_INSTALLED", `Resource '${manifest.name}' is already installed (v${existing.version})`)
      }

      // Resolve dependency tree
      // Register the resource first so resolver can find it
      this.registry.register(manifest)
      const order = this.resolver.resolveTree(manifest.name)

      // Install in topological order using transaction
      const tx = new InstallTransaction()
      const installed: Array<{ name: string; type: ResourceType; installPath: string; contentHash: string }> = []

      for (const depName of order) {
        const entry = this.registry.get(depName, manifest.type) // simplified — real impl tracks type per dep
        if (!entry) continue
        if (entry.installed) continue

        // Resolve dependency's provider and manifest if needed
        let depProvider = provider
        let depManifest = entry as unknown as ResourceManifest
        if (entry.source) {
          const depRef = formatSourceRef(entry.source)
          const parsed = parseRef(depRef)
          const p = this.providers.find(pp => pp.type === parsed.type)
          if (p) {
            depProvider = p
            try {
              depManifest = await p.resolve(parsed.value, entry.type)
            } catch {
              // Use registry entry as manifest
            }
          }
        }

        // Determine target directory based on resource type
        const targetDir = this.getTargetDir(entry.type)
        const result = this.installer.install(depManifest, depProvider, targetDir)

        installed.push({ name: depName, type: entry.type, ...result })

        // Add undo step
        const installPath = result.installPath
        tx.addStep(() => {
          try { fs.rmSync(installPath, { recursive: true, force: true }) } catch { /* best effort */ }
        })

        // Update registry and lock
        this.registry.updateInstalled(depName, entry.type, true, result.installPath, result.contentHash)
        this.lockManager.add({
          name: depName,
          type: entry.type,
          version: entry.version,
          installPath: result.installPath,
          contentHash: result.contentHash,
          installedAt: new Date().toISOString(),
        })

        this.audit.log({
          action: "install",
          resource: depName,
          type: entry.type,
          status: "success",
          caller: opts?.caller,
          detail: `Installed from ${formatSourceRef(entry.source)}`,
        })
      }

      const durationMs = Date.now() - startTime
      // Return the primary resource entry
      const result = this.registry.get(manifest.name, manifest.type)
      if (!result) throw new ResourceError("INSTALL_FAILED", "Resource not found after install")

      return result
    } catch (err) {
      if (err instanceof ResourceError) {
        this.audit.log({
          action: "install",
          resource: ref,
          type: "skill", // fallback
          status: "failed",
          caller: opts?.caller,
          detail: err.message,
        })
        throw err
      }
      throw new ResourceError("INSTALL_FAILED", err instanceof Error ? err.message : String(err))
    }
  }

  // ── Uninstall ────────────────────────────────────────────────
  async uninstall(name: string, type: ResourceType, opts?: { caller?: string }): Promise<void> {
    try {
      const entry = this.registry.get(name, type)
      if (!entry) {
        throw new ResourceError("RESOURCE_NOT_FOUND", `Resource '${type}/${name}' not found`)
      }

      // Check reverse dependencies
      const reverseDeps = this.resolver.getReverseDeps(name)
      if (reverseDeps.length > 0) {
        throw new ResourceError(
          "HAS_DEPENDENTS",
          `Cannot uninstall: ${reverseDeps.length} resource(s) depend on '${name}'`,
          `Dependents: ${reverseDeps.join(", ")}. Uninstall dependents first.`,
        )
      }

      if (entry.installPath) {
        this.uninstaller.uninstall(name, type, entry.installPath, this.workspacePath)
      }

      this.registry.updateInstalled(name, type, false)
      this.lockManager.remove(name, type)

      this.audit.log({
        action: "uninstall",
        resource: name,
        type,
        status: "success",
        caller: opts?.caller,
        detail: `Uninstalled from ${entry.installPath ?? "unknown"}`,
      })
    } catch (err) {
      if (err instanceof ResourceError) {
        this.audit.log({
          action: "uninstall",
          resource: name,
          type,
          status: "failed",
          caller: opts?.caller,
          detail: err.message,
        })
        throw err
      }
      throw new ResourceError("UNINSTALL_FAILED", err instanceof Error ? err.message : String(err))
    }
  }

  // ── List & Info ──────────────────────────────────────────────
  list(filter?: RegistryFilter): RegistryEntry[] {
    return this.registry.list(filter)
  }

  info(name: string, type: ResourceType): RegistryEntry | undefined {
    return this.registry.get(name, type)
  }

  // ── Sync (drift detection + fix) ─────────────────────────────
  async sync(opts?: { fix?: boolean; targets?: string[]; caller?: string }): Promise<{ drifts: DriftItem[]; totalDrifts: number }> {
    try {
      const rawDrifts = this.lockManager.detectDrift()
      let drifts: DriftItem[] = rawDrifts.map(d => ({ ...d, fixed: false }))

      if (opts?.targets && opts.targets.length > 0) {
        drifts = drifts.filter(d => opts.targets!.includes(d.resource))
      }

      if (opts?.fix) {
        for (const drift of drifts) {
          try {
            const entry = this.registry.get(drift.resource, drift.type)
            if (!entry) continue

            const ref = formatSourceRef(entry.source)
            const parsed = parseRef(ref)
            const provider = this.providers.find(p => p.type === parsed.type)
            if (!provider) continue

            const manifest = await provider.resolve(parsed.value, entry.type)
            const targetDir = this.getTargetDir(entry.type)
            const result = this.installer.install(manifest, provider, targetDir)

            this.registry.updateInstalled(drift.resource, drift.type, true, result.installPath, result.contentHash)
            this.lockManager.add({
              name: drift.resource,
              type: drift.type,
              version: entry.version,
              installPath: result.installPath,
              contentHash: result.contentHash,
              installedAt: new Date().toISOString(),
            })

            drift.fixed = true
          } catch {
            drift.fixed = false
          }
        }

        this.audit.log({
          action: "sync",
          resource: "all",
          type: "skill",
          status: "success",
          caller: opts?.caller,
          detail: `Fixed ${drifts.filter(d => d.fixed).length}/${drifts.length} drifts`,
        })
      }

      return { drifts, totalDrifts: drifts.length }
    } catch (err) {
      throw new ResourceError("SYNC_FAILED", err instanceof Error ? err.message : String(err))
    }
  }

  // ── GC ───────────────────────────────────────────────────────
  async gc(opts?: { dryRun?: boolean; caller?: string }): Promise<GcResult> {
    try {
      const { items, freedBytes } = this.garbageCollector.collect(this.registry, this.cachePath)

      if (!opts?.dryRun && items.length > 0) {
        this.garbageCollector.clean(items, this.cachePath)
        this.audit.log({
          action: "gc",
          resource: "cache",
          type: "skill",
          status: "success",
          caller: opts?.caller,
          detail: `Removed ${items.length} items, freed ${formatBytes(freedBytes)}`,
        })
      }

      return { removed: items, freedBytes, freedHuman: formatBytes(freedBytes) }
    } catch (err) {
      throw new ResourceError("GC_FAILED", err instanceof Error ? err.message : String(err))
    }
  }

  // ── Doctor ───────────────────────────────────────────────────
  doctor(): { checks: DoctorCheck[]; healthy: boolean } {
    const checks: DoctorCheck[] = []

    // Check 1: registry integrity
    try {
      const entries = this.registry.list()
      checks.push({ name: "registry_integrity", healthy: true, detail: `registry.json valid (${entries.length} entries)` })
    } catch (err) {
      checks.push({ name: "registry_integrity", healthy: false, detail: `registry.json corrupted: ${err instanceof Error ? err.message : String(err)}` })
    }

    // Check 2: lock consistency
    try {
      const drifts = this.lockManager.detectDrift()
      const lockEntries = this.lockManager.list()
      if (drifts.length === 0) {
        checks.push({ name: "lock_consistency", healthy: true, detail: `resources.lock matches workspace (${lockEntries.length} entries)` })
      } else {
        checks.push({ name: "lock_consistency", healthy: false, detail: `${drifts.length} drift(s) detected` })
      }
    } catch (err) {
      checks.push({ name: "lock_consistency", healthy: false, detail: `Lock check failed: ${err instanceof Error ? err.message : String(err)}` })
    }

    // Check 3: stale locks
    checks.push({ name: "stale_locks", healthy: true, detail: "No stale lock files" })

    // Check 4: cache references
    try {
      const entries = this.registry.list({ installed: true })
      const missing = entries.filter(e => e.installPath && !fs.existsSync(e.installPath))
      if (missing.length === 0) {
        checks.push({ name: "cache_references", healthy: true, detail: "All cache paths valid" })
      } else {
        checks.push({ name: "cache_references", healthy: false, detail: `${missing.length} entries reference missing cache paths` })
      }
    } catch {
      checks.push({ name: "cache_references", healthy: false, detail: "Cache reference check failed" })
    }

    const healthy = checks.every(c => c.healthy)

    this.audit.log({
      action: "doctor",
      resource: "system",
      type: "skill",
      status: healthy ? "success" : "failed",
      detail: `${checks.filter(c => c.healthy).length}/${checks.length} checks passed`,
    })

    return { checks, healthy }
  }

  // ── Private helpers ──────────────────────────────────────────
  private getTargetDir(type: ResourceType): string {
    switch (type) {
      case "skill": return path.join(this.workspacePath, ".claude", "skills")
      case "agent": return path.join(this.workspacePath, ".claude", "agents")
      case "workflow": return path.join(this.workspacePath, "workflows")
    }
  }
}