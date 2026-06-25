import type { IAgentProvider } from './types'

const providers = new Map<string, () => IAgentProvider>()

export function registerProvider(id: string, factory: () => IAgentProvider): void {
  providers.set(id, factory)
}

export function getProvider(id: string): IAgentProvider {
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