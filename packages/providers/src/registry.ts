import type { IAgentProvider } from './types'

const providers = new Map<string, () => IAgentProvider | Promise<IAgentProvider>>()

export function registerProvider(id: string, factory: () => IAgentProvider | Promise<IAgentProvider>): void {
  providers.set(id, factory)
}

// Sync API — only works for sync factories (e.g. Claude).
// Throws if the provider uses an async factory (use getProviderAsync instead).
export function getProvider(id: string): IAgentProvider {
  const factory = providers.get(id)
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Registered: ${[...providers.keys()].join(', ')}`)
  }
  const result = factory()
  if (result instanceof Promise) {
    throw new Error(`Provider '${id}' uses async factory. Use getProviderAsync() instead.`)
  }
  return result
}

// Async variant — resolves both sync and async factories.
// Use this when the provider key may be 'pi' (async factory).
export async function getProviderAsync(id: string): Promise<IAgentProvider> {
  const factory = providers.get(id)
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Registered: ${[...providers.keys()].join(', ')}`)
  }
  return factory()
}

export function isProviderRegistered(id: string): boolean {
  return providers.has(id)
}

export function listProviders(): string[] {
  return [...providers.keys()]
}