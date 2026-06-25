// packages/engine/src/notify/providers/hermes.ts
import type { NotifyProvider, NotifyMessage, NotifyResult, NotifySendConfig, NotifyProviderConfig } from "@octopus/shared"

export class HermesProvider implements NotifyProvider {
  readonly name: string
  readonly type = "hermes"

  constructor(name: string, private config: NotifyProviderConfig) {
    this.name = name
  }

  async send(message: NotifyMessage, sendConfig: NotifySendConfig): Promise<NotifyResult> {
    const start = Date.now()
    const cliPath = sendConfig.cliPath ?? this.config.cli_path ?? "hermes"
    const target = sendConfig.target

    if (!target) {
      return {
        success: false, provider: this.name, channel: "",
        durationMs: Date.now() - start,
        error: "No target configured for hermes provider",
      }
    }

    const severityPrefix = `[${message.severity.toUpperCase()}]`
    const fullMessage = `${severityPrefix} ${message.title}\n${message.body}`.trim()

    try {
      const { execFile } = await import("child_process")
      const { promisify } = await import("util")
      const execFileAsync = promisify(execFile)
      await execFileAsync(cliPath, ["send", "-t", target, "-q", fullMessage], {
        timeout: sendConfig.timeout * 1000,
      })
      return { success: true, provider: this.name, channel: target, durationMs: Date.now() - start }
    } catch (error: unknown) {
      return {
        success: false, provider: this.name, channel: target,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
