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

    // ── Dual-mode target resolution ──────────────────────────────────────
    // telegram:{chatId} where chatId is all digits → dynamic mode (direct Bot API)
    // telegram:{name} where name is not all digits  → named mode (existing Hermes CLI)
    const telegramMatch = target.match(/^telegram:(.+)$/)
    if (telegramMatch) {
      const chatIdOrName = telegramMatch[1]
      const isDigitsOnly = /^\d+$/.test(chatIdOrName)

      if (isDigitsOnly) {
        // Dynamic mode: direct Telegram Bot API call
        return this.sendViaTelegramBotAPI(chatIdOrName, fullMessage, sendConfig, start)
      }
      // Named mode: fall through to Hermes CLI below (existing behavior)
    }

    // Named mode (Hermes CLI) or non-telegram targets
    const cliPath = sendConfig.cliPath ?? this.config.cli_path ?? "hermes"

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

  /**
   * Dynamic mode: send message directly via Telegram Bot API (HTTPS).
   * Uses OCTOPUS_TELEGRAM_BOT_TOKEN environment variable for authentication.
   */
  private async sendViaTelegramBotAPI(
    chatId: string,
    text: string,
    sendConfig: NotifySendConfig,
    start: number,
  ): Promise<NotifyResult> {
    const botToken = process.env.OCTOPUS_TELEGRAM_BOT_TOKEN
    if (!botToken) {
      return {
        success: false, provider: this.name, channel: `telegram:${chatId}`,
        durationMs: Date.now() - start,
        error: "OCTOPUS_TELEGRAM_BOT_TOKEN not configured",
      }
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const timeoutMs = sendConfig.timeout * 1000

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        return {
          success: false, provider: this.name, channel: `telegram:${chatId}`,
          durationMs: Date.now() - start,
          error: `Telegram API error ${response.status}: ${body.slice(0, 200)}`,
        }
      }

      return {
        success: true, provider: this.name, channel: `telegram:${chatId}`,
        durationMs: Date.now() - start,
      }
    } catch (error: unknown) {
      return {
        success: false, provider: this.name, channel: `telegram:${chatId}`,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
