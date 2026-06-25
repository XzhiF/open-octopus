// packages/engine/src/notify/dispatcher.ts
import type { HookDef, NotifyProviderConfig, ChannelProfile, NotifyResult, NotifySendConfig } from "@octopus/shared"
import type { VarPool } from "@octopus/shared"
import { TemplateRenderer, validateTemplateSyntax } from "@octopus/shared"
import { ProviderRegistry } from "./registry"

export interface DispatchContext {
  hook: HookDef
  pool: VarPool
  providers: Record<string, NotifyProviderConfig>
  channels: Record<string, ChannelProfile>
  nodeOutputs?: Record<string, Record<string, unknown>>
  logger?: (level: string, data: Record<string, unknown>) => void
}

const SEVERITY_LEVELS: Record<string, number> = { info: 0, warn: 1, error: 2 }

function meetsSeverityThreshold(severity: string, minSeverity: string): boolean {
  return (SEVERITY_LEVELS[severity] ?? 0) >= (SEVERITY_LEVELS[minSeverity] ?? 0)
}

export class NotifyDispatcher {
  private registry: ProviderRegistry
  private renderer: TemplateRenderer
  private maxConcurrent: number

  constructor(registry: ProviderRegistry, renderer: TemplateRenderer, maxConcurrent = 5) {
    this.registry = registry
    this.renderer = renderer
    this.maxConcurrent = maxConcurrent
  }

  async dispatch(ctx: DispatchContext): Promise<NotifyResult[]> {
    if (!ctx.hook.template) {
      ctx.logger?.("warn", { event: "missing_template", channel: ctx.hook.channel || "unknown" })
      return [{
        success: false,
        provider: 'unknown',
        channel: Array.isArray(ctx.hook.channel) ? ctx.hook.channel.join(',') : (ctx.hook.channel || 'unknown'),
        durationMs: 0,
        error: 'Missing template field',
      }]
    }

    const template = ctx.hook.template
    const errors = validateTemplateSyntax(template)
    if (errors.length > 0) {
      throw new Error(`Template validation failed: ${errors.join("; ")}`)
    }

    const channelNames = Array.isArray(ctx.hook.channel)
      ? ctx.hook.channel
      : [ctx.hook.channel ?? "default"]

    const results: NotifyResult[] = []
    const queue = [...channelNames]

    while (queue.length > 0) {
      const batch = queue.splice(0, this.maxConcurrent)
      const batchResults = await Promise.allSettled(
        batch.map(chName => this.dispatchToChannel(chName, ctx))
      )
      for (let i = 0; i < batchResults.length; i++) {
        const r = batchResults[i]
        if (r.status === "fulfilled") {
          results.push(r.value)
        } else {
          results.push({
            success: false, provider: "unknown", channel: batch[i],
            durationMs: 0,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          })
        }
      }
    }
    return results
  }

  private async dispatchToChannel(channelName: string, ctx: DispatchContext): Promise<NotifyResult> {
    const channel = ctx.channels[channelName]
    if (!channel) throw new Error(`Channel not found: ${channelName}`)

    const providerConfig = ctx.providers[channel.provider]
    if (!providerConfig) {
      throw new Error(`Provider not found: ${channel.provider} (referenced by channel: ${channelName})`)
    }

    const notifyPool = ctx.pool.fork()
    notifyPool.update({
      "notify.channel": channelName,
      "notify.provider": channel.provider,
      "notify.severity": ctx.hook.template?.severity ?? "info",
    })
    const message = this.renderer.render(ctx.hook.template!, notifyPool, ctx.nodeOutputs)
    notifyPool.removePrefix("notify.")

    const minSeverity = channel.min_severity ?? providerConfig.min_severity ?? "info"
    if (!meetsSeverityThreshold(message.severity, minSeverity)) {
      return {
        success: true, provider: channel.provider, channel: channelName,
        durationMs: 0, metadata: { skipped: true, reason: "severity_below_threshold" },
      }
    }

    const provider = this.registry.getOrCreate(channel.provider, providerConfig)
    const sendConfig: NotifySendConfig = {
      target: channel.target, url: channel.url ?? providerConfig.url,
      timeout: providerConfig.timeout ?? 15, method: providerConfig.method,
      headers: providerConfig.headers, cliPath: providerConfig.cli_path,
    }

    const maxAttempts = ctx.hook.retry?.max_attempts ?? 1
    const retryDelay = ctx.hook.retry?.delay ?? 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await provider.send(message, sendConfig)
      if (result.success || attempt === maxAttempts) {
        return { ...result, channel: channelName }
      }
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * 1000))
      }
    }
    throw new Error("Unreachable")
  }
}
