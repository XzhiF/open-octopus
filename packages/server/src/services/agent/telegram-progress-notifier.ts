// packages/server/src/services/agent/telegram-progress-notifier.ts
// P6.6: Pushes execution progress to Telegram when executions complete or fail.
// Hooked into ExecutionLifecycle onComplete callback.

// ponytail: TC-055 — 5-minute throttle prevents notification spam
const THROTTLE_INTERVAL_MS = 5 * 60 * 1000

export class TelegramProgressNotifier {
  private botToken: string | undefined
  private chatIds: string[]
  // Track last notification time per chat for rate limiting
  private static lastNotificationTime: number = 0

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN
    // Comma-separated list of chat IDs to notify (e.g., "12345,67890")
    const chatIdEnv = process.env.TELEGRAM_PROGRESS_CHAT_IDS
    this.chatIds = chatIdEnv ? chatIdEnv.split(",").map(s => s.trim()).filter(Boolean) : []
  }

  /**
   * Check if notifications are currently throttled.
   * Returns true if the last notification was sent less than 5 minutes ago.
   */
  isThrottled(): boolean {
    return Date.now() - TelegramProgressNotifier.lastNotificationTime < THROTTLE_INTERVAL_MS
  }

  /**
   * Send execution progress notification to configured Telegram chats.
   * Called by ExecutionLifecycle when an execution completes or fails.
   * Throttled to at most 1 notification per 5 minutes (TC-055).
   */
  async notify(execution: {
    id: string
    workflow_name: string
    status: string
    duration_ms?: number
    name?: string
  }): Promise<{ sent: boolean; throttled: boolean }> {
    if (!this.botToken || this.chatIds.length === 0) return { sent: false, throttled: false }

    // Only notify for terminal states
    if (!["completed", "failed", "cancelled", "completed_with_failures"].includes(execution.status)) {
      return { sent: false, throttled: false }
    }

    // TC-055: throttle — drop notification if within 5-minute window
    if (this.isThrottled()) {
      return { sent: false, throttled: true }
    }

    const statusEmoji: Record<string, string> = {
      completed: "✅",
      completed_with_failures: "⚠️",
      failed: "❌",
      cancelled: "🛑",
    }
    const emoji = statusEmoji[execution.status] ?? "📊"
    const duration = execution.duration_ms ? `${(execution.duration_ms / 1000).toFixed(1)}s` : "N/A"
    const name = execution.name ?? execution.workflow_name

    const text = `${emoji} <b>执行${this.statusLabel(execution.status)}</b>\n` +
      `📋 工作流: ${name}\n` +
      `⏱ 耗时: ${duration}\n` +
      `🆔 ID: ${execution.id.substring(0, 12)}`

    // Update throttle timestamp before sending (not after — prevents race)
    TelegramProgressNotifier.lastNotificationTime = Date.now()

    for (const chatId of this.chatIds) {
      try {
        await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        })
      } catch (err) {
        console.warn(`[telegram-progress] Failed to notify chat ${chatId}:`, err)
      }
    }

    return { sent: true, throttled: false }
  }

  /**
   * Reset the throttle timestamp (for testing).
   */
  static resetThrottle(): void {
    TelegramProgressNotifier.lastNotificationTime = 0
  }

  private statusLabel(status: string): string {
    switch (status) {
      case "completed": return "完成"
      case "completed_with_failures": return "完成（部分失败）"
      case "failed": return "失败"
      case "cancelled": return "已取消"
      default: return status
    }
  }
}
