import { ResourceManager, type ResourceManagerConfig } from "@octopus/shared"

/**
 * ResourceManagerRegistry — global ResourceManager singleton.
 * Resources are not org-scoped; all orgs share the same registry.
 */
export class ResourceManagerRegistry {
  private manager: ResourceManager | null = null
  private defaultConfig: ResourceManagerConfig

  constructor(defaultConfig?: ResourceManagerConfig) {
    this.defaultConfig = defaultConfig ?? {} as ResourceManagerConfig
  }

  /** Get the global ResourceManager (lazy init) */
  get(): ResourceManager {
    if (!this.manager) {
      this.manager = new ResourceManager(this.defaultConfig)
      this.manager.registerBuiltins()
    }
    return this.manager
  }

  /** Clear manager (for cleanup/testing) */
  clear(): void {
    this.manager = null
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
