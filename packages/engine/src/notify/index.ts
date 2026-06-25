// packages/engine/src/notify/index.ts
import { ProviderRegistry } from "./registry"
import { HermesProvider } from "./providers/hermes"
import { WebhookProvider } from "./providers/webhook"

export function registerBuiltinProviders(): void {
  if (!ProviderRegistry.hasType("hermes")) {
    ProviderRegistry.registerType("hermes", (name, config) => new HermesProvider(name, config))
  }
  if (!ProviderRegistry.hasType("webhook")) {
    ProviderRegistry.registerType("webhook", (name, config) => new WebhookProvider(name, config))
  }
}

export { ProviderRegistry } from "./registry"
export { HermesProvider } from "./providers/hermes"
export { WebhookProvider } from "./providers/webhook"
export { NotifyDispatcher } from "./dispatcher"
export type { DispatchContext } from "./dispatcher"
