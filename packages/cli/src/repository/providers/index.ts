import type { SourceProvider } from "./types"
import type { SourceRef } from "@octopus/shared"
import { LocalProvider } from "./local-provider"
import { NpmProvider } from "./npm-provider"
import { GitProvider } from "./git-provider"
import { BuiltinProvider } from "./builtin-provider"

export class SourceProviderRegistry {
  private providers = new Map<string, SourceProvider>()

  constructor() {
    this.register(new LocalProvider())
    this.register(new NpmProvider())
    this.register(new GitProvider())
    this.register(new BuiltinProvider())
  }

  register(provider: SourceProvider): void {
    this.providers.set(provider.protocol, provider)
  }

  get(ref: SourceRef): SourceProvider {
    const provider = this.providers.get(ref.protocol)
    if (!provider) throw new Error(`No provider for protocol: ${ref.protocol}`)
    return provider
  }
}

export { LocalProvider, NpmProvider, GitProvider, BuiltinProvider }
export type { SourceProvider, FetchResult, ValidationResult } from "./types"
