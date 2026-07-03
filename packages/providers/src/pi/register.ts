import { registerProvider } from '../registry'

/**
 * Register the Pi provider factory.
 * Must be called explicitly at server startup — NOT triggered by barrel import.
 * Prevents side effects when other code only needs type exports from @octopus/providers.
 */
export function registerPiProvider(): void {
  registerProvider('pi', async () => {
    // ESM-only Pi package: lazy-load via dynamic import to avoid CJS require failure
    const { PiAgentProvider } = await import('./pi-agent-provider')
    return new PiAgentProvider()
  })
}
