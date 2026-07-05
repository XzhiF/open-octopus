/**
 * ResourceKernel — 资源管理内核编排
 *
 * 组合 FsResourceStore + TrustStore + AuditLogger + DependencyResolver，
 * 提供 init / plan / register / install / uninstall 等高层操作。
 * CLI 和 Server 均通过此内核驱动。
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "fs"
import { join, dirname } from "path"
import { FsResourceStore } from "./fs-store"
import { TrustStore } from "./security"
import { AuditLogger } from "./audit"
import { DependencyResolver } from "./resolver"
import { ResourceError, ResourceErrorCode } from "./errors"
import { createInstallPlan } from "./install-plan"
import type { Registry, InstallPlan, ResourceManifest } from "./schema"
import type { SourceProvider, SourceRef } from "./providers"
import { ResourceManifestSchema, RegistrySchema } from "./schema"

export interface KernelDeps {
  store: FsResourceStore
  trustStore: TrustStore
  auditLogger: AuditLogger
  cacheDir: string
}

export interface InitOptions {
  force?: boolean
}

export interface PlanInput {
  additions: { name: string; type: string; version: string; source: string }[]
  removals?: string[]
}

export class ResourceKernel {
  private store: FsResourceStore
  private trustStore: TrustStore
  private auditLogger: AuditLogger
  private cacheDir: string

  constructor(deps: KernelDeps) {
    this.store = deps.store
    this.trustStore = deps.trustStore
    this.auditLogger = deps.auditLogger
    this.cacheDir = deps.cacheDir
  }

  /**
   * 初始化资源目录结构
   */
  async init(opts?: InitOptions): Promise<void> {
    const registryPath = join(this.store.dir, "registry.json")
    if (existsSync(registryPath) && !opts?.force) {
      throw new ResourceError(
        ResourceErrorCode.RESOURCE_ALREADY_INITIALIZED,
        "Resource directory already initialized. Use --force to overwrite.",
        { suggestion: "Use --force flag to reinitialize" },
      )
    }

    // Create directory structure
    for (const type of ["skill", "agent", "workflow", "source"]) {
      mkdirSync(join(this.store.dir, "manifests", type), { recursive: true })
    }
    mkdirSync(this.cacheDir, { recursive: true })

    // Initialize registry
    const registry: Registry = { version: 1, entries: {} }
    await this.store.atomicStore.write("registry.json", registry)

    // Audit log
    if (opts?.force) {
      this.auditLogger.append({
        action: "resource.init_forced",
        resource: "*",
        caller: "human",
      })
    }
  }

  /**
   * 创建安装计划（dry-run）
   */
  async plan(input: PlanInput): Promise<InstallPlan> {
    const registry = await this.getRegistry()
    const resolver = new DependencyResolver()

    // Add existing manifests from registry to resolver
    for (const entry of Object.values(registry.entries)) {
      resolver.addManifest(entry.manifest)
    }

    const additions: InstallPlan["additions"] = input.additions.map(a => ({
      name: a.name,
      type: a.type as InstallPlan["additions"][0]["type"],
      version: a.version,
      source: a.source,
    }))

    // Resolve dependency order — propagate cycle/missing as ResourceError
    const names = additions.map(a => a.name)
    try {
      resolver.resolve(names)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith("DEPENDENCY_CYCLE:")) {
        throw new ResourceError(ResourceErrorCode.DEPENDENCY_CYCLE, msg)
      }
      throw new ResourceError(ResourceErrorCode.DEPENDENCY_MISSING, msg)
    }

    // Detect conflicts: resources that would be downgraded or have incompatible versions
    const conflicts: InstallPlan["conflicts"] = []
    for (const addition of additions) {
      const existing = await this.find(addition.name)
      if (existing && existing.version !== addition.version) {
        // Record as conflict but still include in plan — caller decides
        conflicts.push({
          name: addition.name,
          reason: `Version change: ${existing.version} → ${addition.version}`,
        })
      }
    }

    return createInstallPlan(additions, input.removals ?? [], conflicts)
  }

  /**
   * 读取注册表
   * B-13 fix: Use Zod validation instead of hard cast.
   */
  async getRegistry(): Promise<Registry> {
    const data = await this.store.atomicStore.read("registry.json")
    if (!data) return { version: 1, entries: {} }
    try {
      return RegistrySchema.parse(data)
    } catch {
      // If registry is corrupted, return empty and let caller decide
      return { version: 1, entries: {} }
    }
  }

  /**
   * 注册资源到 registry
   */
  async register(manifest: ResourceManifest): Promise<void> {
    const release = await this.store.acquireLock()
    try {
      const registry = await this.getRegistry()
      const key = `${manifest.type}:${manifest.source.protocol}:${manifest.source.location}:${manifest.name}`
      const isReplace = key in registry.entries
      registry.entries[key] = {
        manifest,
        installedAt: new Date().toISOString(),
      }
      await this.store.atomicStore.write("registry.json", registry)
      this.auditLogger.append({
        action: isReplace ? "resource.replaced" : "resource.registered",
        resource: manifest.name,
        caller: "human",
      })
    } finally {
      await release()
    }
  }

  /**
   * 列出已注册资源
   */
  async list(filter?: { type?: string; source?: string }): Promise<ResourceManifest[]> {
    const registry = await this.getRegistry()
    let entries = Object.values(registry.entries).map(e => e.manifest)

    if (filter?.type) {
      entries = entries.filter(m => m.type === filter.type)
    }
    if (filter?.source) {
      entries = entries.filter(m => m.source.protocol === filter.source)
    }

    return entries
  }

  /**
   * 查找资源
   */
  async find(name: string): Promise<ResourceManifest | null> {
    const registry = await this.getRegistry()
    for (const entry of Object.values(registry.entries)) {
      if (entry.manifest.name === name) {
        return entry.manifest
      }
    }
    return null
  }

  /**
   * 注销资源
   */
  async unregister(name: string): Promise<void> {
    const release = await this.store.acquireLock()
    try {
      const registry = await this.getRegistry()
      const key = Object.keys(registry.entries).find(
        k => registry.entries[k].manifest.name === name,
      )
      if (!key) {
        throw new ResourceError(
          ResourceErrorCode.RESOURCE_NOT_FOUND,
          `Resource not found: ${name}`,
        )
      }
      delete registry.entries[key]
      await this.store.atomicStore.write("registry.json", registry)
      this.auditLogger.append({
        action: "resource.uninstalled",
        resource: name,
        caller: "human",
      })
    } finally {
      await release()
    }
  }

  /**
   * 执行安装计划 — 原子安装 + .bak 回退
   *
   * PRD §7.1: 两阶段安装
   *   Phase 1: SourceProvider.fetch() → .staging/
   *   Phase 2: .staging/ → target 原子 rename（< 100ms）
   *   失败时: .staging/ 清理 + .bak 回退已安装项
   *
   * @param plan 安装计划（由 plan() 生成）
   * @param providers 按协议名索引的 SourceProvider 映射
   * @param installBaseDir 安装目标基目录（如 ~/.octopus/orgs/xzf/）
   */
  async execute(
    plan: InstallPlan,
    providers: Map<string, SourceProvider>,
    installBaseDir: string,
  ): Promise<{ installed: string[]; failed: { name: string; error: string }[] }> {
    const installed: string[] = []
    const backups = new Map<string, { bakPath: string; origPath: string }>()
    const failed: { name: string; error: string }[] = []

    const TYPE_DIRS: Record<string, string> = {
      skill: "skills", agent: "agents", workflow: "workflows", source: "sources",
    }

    for (const addition of plan.additions) {
      const targetDir = join(installBaseDir, TYPE_DIRS[addition.type] ?? addition.type + "s", addition.name)
      const stagingDir = join(installBaseDir, ".staging", addition.name)
      const bakPath = targetDir + ".bak"

      try {
        // Phase 1: Fetch → staging
        const [protocol, ...locParts] = addition.source.split(":")
        const location = locParts.join(":") || addition.source
        const provider = providers.get(protocol)
        if (!provider) {
          throw new ResourceError(
            ResourceErrorCode.INVALID_MANIFEST,
            `No provider for protocol: ${protocol}`,
          )
        }

        const ref: SourceRef = { protocol, location, version: addition.version }
        const result = await provider.fetch(ref)

        // Write to staging directory
        mkdirSync(stagingDir, { recursive: true })
        for (const file of result.files) {
          const filePath = join(stagingDir, file.path)
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(filePath, file.content)
        }

        // Phase 2: Backup existing → atomic rename
        if (existsSync(targetDir)) {
          if (existsSync(bakPath)) {
            rmSync(bakPath, { recursive: true, force: true })
          }
          renameSync(targetDir, bakPath)
          backups.set(addition.name, { bakPath, origPath: targetDir })
        }

        // Atomic move: staging → target
        renameSync(stagingDir, targetDir)

        // Register with real hash from provider
        const manifest = ResourceManifestSchema.parse({
          name: addition.name,
          type: addition.type,
          version: result.version || addition.version,
          source: { protocol, location, version: result.version || addition.version },
          hash: result.hash,
          dependencies: [],
          references: [],
        })
        await this.register(manifest)

        installed.push(addition.name)
        this.auditLogger.append({
          action: "resource.installed",
          resource: addition.name,
          caller: "human",
          detail: { version: result.version || addition.version, hash: result.hash },
        })
      } catch (err) {
        // Rollback: clean staging, restore .bak
        try {
          if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
        } catch { /* staging cleanup best-effort */ }

        const backup = backups.get(addition.name)
        if (backup && existsSync(backup.bakPath)) {
          try {
            if (existsSync(backup.origPath)) rmSync(backup.origPath, { recursive: true, force: true })
            renameSync(backup.bakPath, backup.origPath)
          } catch { /* rollback best-effort */ }
        }

        failed.push({
          name: addition.name,
          error: err instanceof Error ? err.message : "Install failed",
        })
      }
    }

    // Clean up staging directory
    const stagingRoot = join(installBaseDir, ".staging")
    try {
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true })
    } catch { /* best-effort */ }

    return { installed, failed }
  }
}
