// packages/engine/src/notify/registry.ts
import type { NotifyProvider, NotifyProviderConfig } from "@octopus/shared"

type ProviderFactory = (name: string, config: NotifyProviderConfig) => NotifyProvider

export class ProviderRegistry {
  private static factories = new Map<string, ProviderFactory>()
  private instances = new Map<string, NotifyProvider>()

  static registerType(type: string, factory: ProviderFactory): void {
    ProviderRegistry.factories.set(type, factory)
  }

  static hasType(type: string): boolean {
    return ProviderRegistry.factories.has(type)
  }

  /** For test isolation only — clears all registered types. */
  static clearTypes(): void {
    ProviderRegistry.factories.clear()
  }

  getOrCreate(name: string, config: NotifyProviderConfig): NotifyProvider {
    if (!this.instances.has(name)) {
      const factory = ProviderRegistry.factories.get(config.type)
      if (!factory) {
        throw new Error(`Unknown provider type: ${config.type}`)
      }
      this.instances.set(name, factory(name, config))
    }
    return this.instances.get(name)!
  }

  hasInstance(name: string): boolean {
    return this.instances.has(name)
  }
}
