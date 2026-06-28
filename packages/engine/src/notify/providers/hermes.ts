// packages/engine/src/notify/providers/hermes.ts
// Dual-mode Hermes provider:
//   Mode 1 (named target): delegates to `hermes send -t <target>` CLI
//   Mode 2 (dynamic chat ID): sends directly to Telegram Bot API
// Detection: target is numeric or starts with "chat:" → Telegram API; otherwise → hermes CLI.

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

    // Mode 2: Dynamic chat ID — send directly to Telegram Bot API
    if (this.isDynamicChatId(target)) {
      const chatId = target.startsWith("chat:") ? target.slice(5) : target
      return this.sendViaTelegramApi(chatId, fullMessage, sendConfig, start)
    }

    // Mode 1: Named target — delegate to hermes CLI
    return this.sendViaCli(target, fullMessage, sendConfig, start)
  }

  private isDynamicChatId(target: string): boolean {
    if (target.startsWith("chat:")) return true
    // Numeric Telegram chat IDs are integers (can be negative for groups)
    return /^-?\d+$/.test(target)
  }

  private async sendViaTelegramApi(
    chatId: string,
    text: string,
    sendConfig: NotifySendConfig,
    start: number,
  ): Promise<NotifyResult> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? this.config.url
    if (!botToken) {
      return {
        success: false, provider: this.name, channel: chatId,
        durationMs: Date.now() - start,
        error: "TELEGRAM_BOT_TOKEN not configured",
      }
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), sendConfig.timeout * 1000)

      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!resp.ok) {
        const body = await resp.text()
        return {
          success: false, provider: this.name, channel: chatId,
          durationMs: Date.now() - start,
          error: `Telegram API ${resp.status}: ${body.substring(0, 200)}`,
        }
      }

      return { success: true, provider: this.name, channel: chatId, durationMs: Date.now() - start }
    } catch (error: unknown) {
      return {
        success: false, provider: this.name, channel: chatId,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async sendViaCli(
    target: string,
    text: string,
    sendConfig: NotifySendConfig,
    start: number,
  ): Promise<NotifyResult> {
    const cliPath = sendConfig.cliPath ?? this.config.cli_path ?? "hermes"

    try {
      const { execFile } = await import("child_process")
      const { promisify } = await import("util")
      const execFileAsync = promisify(execFile)
      await execFileAsync(cliPath, ["send", "-t", target, "-q", text], {
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
