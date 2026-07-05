/**
 * ResourceKernel — 资源管理内核编排
 *
 * 组合 FsResourceStore + TrustStore + AuditLogger + DependencyResolver，
 * 提供 init / plan / register / install / uninstall 等高层操作。
 * CLI 和 Server 均通过此内核驱动。
 */
import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { FsResourceStore } from "./fs-store"
import { TrustStore } from "./security"
import { AuditLogger } from "./audit"
import { DependencyResolver } from "./resolver"
import { ResourceError, ResourceErrorCode } from "./errors"
import { createInstallPlan } from "./install-plan"
import type { Registry, InstallPlan, ResourceManifest } from "./schema"

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

    // Resolve dependency order
    const names = additions.map(a => a.name)
    try {
      resolver.resolve(names)
    } catch {
      // If resolution fails (cycle/missing), return plan anyway
      // caller decides whether to proceed
    }

    return createInstallPlan(additions, input.removals ?? [])
  }

  /**
   * 读取注册表
   */
  async getRegistry(): Promise<Registry> {
    const data = await this.store.atomicStore.read("registry.json")
    if (!data) return { version: 1, entries: {} }
    return data as Registry
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
}
