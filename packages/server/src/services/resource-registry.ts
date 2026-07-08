import { ResourceManager, ResourceError, type ResourceManagerConfig } from "@octopus/shared"

/** Valid org name — mirrors OrgResolver regex (C3 fix) */
const ORG_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/
const RESERVED_ORGS = new Set([".", "..", "db", "prod", "ports", "orgs"])

function validateOrg(org: string): void {
  if (!ORG_NAME_RE.test(org) || RESERVED_ORGS.has(org)) {
    throw new ResourceError("INVALID_ORG", `Invalid org: ${org}`)
  }
}

/**
 * ResourceManagerRegistry — per-org ResourceManager singleton registry.
 * Lazy creates ResourceManager on first access for each org.
 * Validates org names to prevent path traversal (C3 fix).
 */
export class ResourceManagerRegistry {
  private managers = new Map<string, ResourceManager>()
  private defaultConfig: Partial<ResourceManagerConfig>

  constructor(defaultConfig?: Partial<ResourceManagerConfig>) {
    this.defaultConfig = defaultConfig ?? {}
  }

  /** Get or create ResourceManager for org (validates org name) */
  getOrCreate(org: string): ResourceManager {
    validateOrg(org)
    let manager = this.managers.get(org)
    if (!manager) {
      manager = new ResourceManager({ org, ...this.defaultConfig })
      // Auto-register core-pack builtin resources on first access
      manager.registerBuiltins()
      this.managers.set(org, manager)
    }
    return manager
  }

  /** Get existing manager (returns undefined if not created yet) */
  get(org: string): ResourceManager | undefined {
    return this.managers.get(org)
  }

  /** List all active orgs */
  listOrgs(): string[] {
    return [...this.managers.keys()]
  }

  /** Remove manager (for cleanup) */
  remove(org: string): boolean {
    return this.managers.delete(org)
  }

  /** Clear all managers */
  clear(): void {
    this.managers.clear()
  }
}

// Global singleton
let instance: ResourceManagerRegistry | null = null

export function getResourceRegistry(): ResourceManagerRegistry {
  if (!instance) {
    instance = new ResourceManagerRegistry()
  }
  return instance
}
