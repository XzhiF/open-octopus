import fs from "fs"
import path from "path"
import os from "os"
import { ResourceError } from "./errors"
import { GitProvider } from "./providers/git-provider"
import { SourceDiscovery, type DiscoveredResource } from "./source-discovery"
import { SourcesStore } from "./sources-store"
import { TrustManager } from "./trust-manager"
import { AuditWriter } from "./audit-writer"
import type {
  SourceEntry,
  SourceAddRequest,
  SourceAddResponse,
  SourceUpdateRequest,
  ResourceAuditCaller,
  ResourceType,
} from "./types"

export interface SourceManagerConfig {
  basePath?: string
}

/**
 * SourceManager — orchestrates git source lifecycle.
 * add → clone + discover + trust + register
 * remove → clean cache + remove trust + unregister
 * update → pull + re-discover + update counts
 * analyze → clone + discover + clean (preview mode)
 */
export class SourceManager {
  private basePath: string
  private gitProvider: GitProvider
  private discovery: SourceDiscovery
  private sourcesStore: SourcesStore
  private trustManager: TrustManager
  private audit: AuditWriter

  constructor(config: SourceManagerConfig = {}) {
    const globalBase = path.join(os.homedir(), ".octopus")
    this.basePath = config.basePath ?? path.join(globalBase, "resources")

    const cacheBase = path.join(this.basePath, "sources")
    this.gitProvider = new GitProvider({ cacheBase })
    this.discovery = new SourceDiscovery()
    this.sourcesStore = new SourcesStore(this.basePath)
    this.trustManager = new TrustManager(globalBase)
    this.audit = new AuditWriter(this.basePath)
  }

  /** Add a new git source: clone → discover → trust → register */
  add(req: SourceAddRequest): SourceAddResponse {
    const { url, branch } = req
    const name = req.name ?? this.generateNameFromUrl(url)

    if (this.sourcesStore.get(name)) {
      throw new ResourceError("SOURCE_ALREADY_EXISTS", `Source ${name} already added`)
    }

    // Validate URL before cloning
    if (!this.gitProvider.validateUrl(url)) {
      throw new ResourceError("GIT_URL_INVALID", `Invalid git URL: ${url}`)
    }

    const { cachePath } = this.gitProvider.clone(url, name, branch)

    let discovered: DiscoveredResource[]
    try {
      discovered = this.discovery.discover(cachePath)
    } catch (err: any) {
      // Clean up on discovery failure
      this.gitProvider.clean(name)
      throw err
    }

    const resourceCount = this.countByType(discovered)

    // Trust and register
    this.trustManager.addTrusted(url)

    const now = new Date().toISOString()
    const entry: SourceEntry = {
      name,
      type: "git",
      url,
      branch: branch ?? "main",
      addedAt: now,
      lastUpdated: now,
      resourceCount,
      cachePath,
      trusted: true,
    }
    this.sourcesStore.upsert(entry)

    this.audit.append(
      "source_add",
      { name, type: "skill" as ResourceType, source: "git" },
      req.caller,
      { url, resourceCount },
    )

    return { name, url, branch: branch ?? "main", resourceCount, addedAt: now, trusted: true }
  }

  /** Remove a source: clean cache → remove trust → unregister */
  remove(name: string, caller: ResourceAuditCaller): void {
    const entry = this.sourcesStore.get(name)
    if (!entry) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source ${name} not found`)
    }

    this.gitProvider.clean(name)
    this.trustManager.removeTrusted(entry.url)
    this.sourcesStore.remove(name)

    this.audit.append(
      "source_remove",
      { name, type: "skill" as ResourceType, source: "git" },
      caller,
      { url: entry.url },
    )
  }

  /** Update a source: pull → re-discover → update counts */
  update(req: SourceUpdateRequest): SourceAddResponse {
    const entry = this.sourcesStore.get(req.name)
    if (!entry) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source ${req.name} not found`)
    }

    this.gitProvider.pull(entry.cachePath)
    const discovered = this.discovery.discover(entry.cachePath)
    const resourceCount = this.countByType(discovered)

    const now = new Date().toISOString()
    const updated: SourceEntry = { ...entry, lastUpdated: now, resourceCount }
    this.sourcesStore.upsert(updated)

    this.audit.append(
      "source_update",
      { name: req.name, type: "skill" as ResourceType, source: "git" },
      req.caller,
      { resourceCount },
    )

    return {
      name: updated.name,
      url: updated.url,
      branch: updated.branch,
      resourceCount,
      addedAt: updated.addedAt,
      trusted: updated.trusted,
    }
  }

  /** List all sources */
  list(): SourceEntry[] {
    return this.sourcesStore.list()
  }

  /** Get a single source by name */
  get(name: string): SourceEntry | null {
    return this.sourcesStore.get(name) ?? null
  }

  /** Analyze a URL without persisting: clone → discover → clean */
  analyze(url: string): { resources: DiscoveredResource[] } {
    if (!this.gitProvider.validateUrl(url)) {
      throw new ResourceError("GIT_URL_INVALID", `Invalid git URL: ${url}`)
    }

    const tempName = `__analyze_${Date.now()}`
    const { cachePath } = this.gitProvider.clone(url, tempName)
    try {
      const resources = this.discovery.discover(cachePath)
      return { resources }
    } finally {
      this.gitProvider.clean(tempName)
    }
  }

  /** Get the full list of discovered resources for a source */
  getDiscoveredResources(sourceName: string): DiscoveredResource[] {
    const source = this.sourcesStore.get(sourceName)
    if (!source) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source ${sourceName} not found`)
    }
    return this.discovery.discover(source.cachePath)
  }

  /** Sync a source: pull → re-discover → update counts */
  sync(sourceName: string, caller: ResourceAuditCaller): {
    newResources: DiscoveredResource[]
  } {
    const source = this.sourcesStore.get(sourceName)
    if (!source) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source ${sourceName} not found`)
    }

    this.gitProvider.pull(source.cachePath)
    const discovered = this.discovery.discover(source.cachePath)
    const resourceCount = this.countByType(discovered)

    const now = new Date().toISOString()
    this.sourcesStore.upsert({ ...source, lastUpdated: now, resourceCount })

    return { newResources: discovered }
  }

  /**
   * Get a resource from source cache for install.
   * Validates trust before returning the cache path.
   */
  getResourceFromSource(sourceName: string, resourcePath: string): {
    cachePath: string
    type: ResourceType
  } {
    const source = this.sourcesStore.get(sourceName)
    if (!source) {
      throw new ResourceError("SOURCE_NOT_FOUND", `Source ${sourceName} not found`)
    }

    if (!this.trustManager.isTrusted(source.url)) {
      throw new ResourceError("SOURCE_NOT_TRUSTED", `Source ${sourceName} not trusted`)
    }

    const fullCachePath = path.join(source.cachePath, resourcePath)
    if (!fs.existsSync(fullCachePath)) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource not found in source: ${resourcePath}`)
    }

    return { cachePath: fullCachePath, type: this.detectTypeFromPath(resourcePath) }
  }

  private generateNameFromUrl(url: string): string {
    const parsed = new URL(url)
    const parts = parsed.pathname.split("/").filter(Boolean)
    return parts[parts.length - 1]
  }

  private countByType(resources: DiscoveredResource[]): {
    skills: number
    agents: number
    workflows: number
  } {
    return {
      skills: resources.filter((r) => r.type === "skill").length,
      agents: resources.filter((r) => r.type === "agent").length,
      workflows: resources.filter((r) => r.type === "workflow").length,
    }
  }

  private detectTypeFromPath(resourcePath: string): ResourceType {
    if (resourcePath.startsWith("skills/")) return "skill"
    if (resourcePath.startsWith("workflows/")) return "workflow"
    return "agent"
  }
}
