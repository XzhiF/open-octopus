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

    // Dynamic Telegram routing: telegram:{chatId} (numeric) → direct Bot API
    if (target.startsWith("telegram:")) {
      const chatIdPart = target.slice("telegram:".length)
      if (/^\d+$/.test(chatIdPart)) {
        return this.sendTelegramDirect(chatIdPart, message, start)
      }
      // Non-numeric → fall through to Hermes CLI named target
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

  /** Send message directly via Telegram Bot API (no Hermes CLI). */
  private async sendTelegramDirect(chatId: string, message: NotifyMessage, start: number): Promise<NotifyResult> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
      return {
        success: false, provider: this.name, channel: `telegram:${chatId}`,
        durationMs: Date.now() - start,
        error: "TELEGRAM_BOT_TOKEN not configured",
      }
    }
    try {
      const severityPrefix = `[${message.severity.toUpperCase()}]`
      const text = `${severityPrefix} ${message.title}\n${message.body}`.trim()
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      })
      if (!res.ok) {
        const body = await res.text()
        return {
          success: false, provider: this.name, channel: `telegram:${chatId}`,
          durationMs: Date.now() - start,
          error: `Telegram API ${res.status}: ${body.slice(0, 200)}`,
        }
      }
      return { success: true, provider: this.name, channel: `telegram:${chatId}`, durationMs: Date.now() - start }
    } catch (err: unknown) {
      return {
        success: false, provider: this.name, channel: `telegram:${chatId}`,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
