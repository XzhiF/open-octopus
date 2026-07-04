import type { IAgentProvider } from './types'

const factories = new Map<string, () => IAgentProvider | Promise<IAgentProvider>>()
const instances = new Map<string, IAgentProvider>()

export function registerProvider(id: string, factory: () => IAgentProvider | Promise<IAgentProvider>): void {
  factories.set(id, factory)
  instances.delete(id)
}

// Sync API — only works for sync factories (e.g. Claude).
// Throws if the provider uses an async factory (use getProviderAsync instead).
export function getProvider(id: string): IAgentProvider {
  const cached = instances.get(id)
  if (cached) return cached
  const factory = factories.get(id)
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Registered: ${[...factories.keys()].join(', ')}`)
  }
  const result = factory()
  if (result instanceof Promise) {
    throw new Error(`Provider '${id}' uses async factory. Use getProviderAsync() instead.`)
  }
  instances.set(id, result)
  return result
}

// Async variant — resolves both sync and async factories.
// Use this when the provider key may be 'pi' (async factory via ESM dynamic import).
export async function getProviderAsync(id: string): Promise<IAgentProvider> {
  const cached = instances.get(id)
  if (cached) return cached
  const factory = factories.get(id)
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Registered: ${[...factories.keys()].join(', ')}`)
  }
  const instance = await factory()
  instances.set(id, instance)
  return instance
}

export function isProviderRegistered(id: string): boolean {
  return factories.has(id)
}

export function listProviders(): string[] {
  return [...factories.keys()]
}

export function resetProviderInstances(): void {
  instances.clear()
}
