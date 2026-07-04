import type { IAgentProvider } from './types'

const factories = new Map<string, () => IAgentProvider>()
const instances = new Map<string, IAgentProvider>()

export function registerProvider(id: string, factory: () => IAgentProvider): void {
  factories.set(id, factory)
  instances.delete(id)
}

export function getProvider(id: string): IAgentProvider {
  const cached = instances.get(id)
  if (cached) return cached
  const factory = factories.get(id)
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Registered: ${[...factories.keys()].join(', ')}`)
  }
  const instance = factory()
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
