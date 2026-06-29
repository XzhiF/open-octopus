import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getAgentConfigPath, getNotificationQueueDir } from './paths'

// ── Types ──────────────────────────────────────────────────────────

export interface NotificationRequest {
  type: 'workflow_selected' | 'execution_started' | 'execution_completed' | 'execution_failed' | 'safe_mode' | 'evolution' | 'scheduled_task' | 'error' | 'general'
  title: string
  body: string
  priority?: 'high' | 'normal' | 'low'
}

export interface NotificationResult {
  sent: boolean
  provider: string
  target: string
  error?: string
  retries: number
}

export interface FailedNotification {
  id: string
  request: NotificationRequest
  failed_at: string
  error: string
  org: string
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 5000, 25000] // exponential backoff: 1s, 5s, 25s
const FAILED_QUEUE_MAX = 100

// ── NotificationService ────────────────────────────────────────────

/**
 * Hermes notification integration for the Agent system.
 * Sends notifications via hermes CLI to configured targets (telegram, etc.).
 * Implements retry with exponential backoff and failed notification queue.
 * Maps to PRD Stories M9, E1 (notify strategy), §6.6 (notification reliability).
 */
export class NotificationService {
  private failedQueues = new Map<string, FailedNotification[]>()
  private configCache = new Map<string, { provider: string; target: string }>()

  /**
   * Send a notification to the configured target.
   * Retries up to 3 times with exponential backoff on failure.
   * If all retries fail, queues the notification for later delivery.
   */
  async sendNotification(org: string, request: NotificationRequest): Promise<NotificationResult> {
    const config = this.getConfig(org)
    let lastError: string | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      try {
        const sent = this.sendViaHermes(config.target, request)
        if (sent) {
          return {
            sent: true,
            provider: config.provider,
            target: config.target,
            retries: attempt,
          }
        }
        lastError = 'hermes send returned non-zero exit code'
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }

    // All retries failed — queue for later delivery
    this.addToFailedQueue(org, request, lastError ?? 'Unknown error')

    return {
      sent: false,
      provider: config.provider,
      target: config.target,
      error: lastError,
      retries: MAX_RETRIES,
    }
  }

  /**
   * Route notification to the appropriate provider.
   * TC-044: dual-mode routing — numeric Telegram chat IDs use direct Bot API,
   * named channels use hermes CLI.
   */
  private sendViaHermes(target: string, request: NotificationRequest): boolean {
    if (!target) return false

    // Parse target format: "telegram:12345678" or "telegram:xzf_hermes"
    const [provider, channel] = target.split(':')
    if (!provider || !channel) return false

    // Direct mode: Telegram with numeric chat ID → call Bot API directly
    if (provider === 'telegram' && /^\d+$/.test(channel)) {
      return this.sendDirectTelegram(channel, request)
    }

    // Named mode: use hermes CLI for named channels or other providers
    try {
      const message = this.formatMessage(request)
      execFileSync('hermes', [
        'send', '--provider', provider, '--channel', channel, '--message', message,
      ], {
        timeout: 30000,
        stdio: 'pipe',
        env: { ...process.env },
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Direct Telegram Bot API call for numeric chat IDs.
   * Uses TELEGRAM_BOT_TOKEN env var for authentication.
   */
  private sendDirectTelegram(chatId: string, request: NotificationRequest): boolean {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return false

    try {
      const message = this.formatMessage(request)
      const payload = JSON.stringify({ chat_id: chatId, text: message })
      execFileSync('curl', [
        '-s', '-X', 'POST',
        `https://api.telegram.org/bot${token}/sendMessage`,
        '-H', 'Content-Type: application/json',
        '-d', payload,
      ], {
        timeout: 30000,
        stdio: 'pipe',
        env: { ...process.env },
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Format notification message with title and body.
   */
  private formatMessage(request: NotificationRequest): string {
    const priority = request.priority === 'high' ? '🔴' : request.priority === 'low' ? '⚪' : '🔵'
    return `${priority} ${request.title}\n${request.body}`
  }

  /**
   * Get notification config for an org (provider + target).
   */
  private getConfig(org: string): { provider: string; target: string } {
    const cached = this.configCache.get(org)
    if (cached) return cached

    const configPath = getAgentConfigPath()
    let provider = 'hermes-cli'
    let target = 'telegram:xzf_hermes'

    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8')
        const providerMatch = content.match(/provider:\s*(.+)/)
        const targetMatch = content.match(/target:\s*(.+)/)
        if (providerMatch) provider = providerMatch[1].trim()
        if (targetMatch) target = targetMatch[1].trim()
      } catch {
        // Use defaults on read failure
      }
    }

    const config = { provider, target }
    this.configCache.set(org, config)
    return config
  }

  /**
   * Add a failed notification to the queue for later retry.
   */
  private addToFailedQueue(org: string, request: NotificationRequest, error: string): void {
    let queue = this.failedQueues.get(org)
    if (!queue) {
      queue = []
      this.failedQueues.set(org, queue)
    }

    queue.push({
      id: crypto.randomUUID(),
      request,
      failed_at: new Date().toISOString(),
      error,
      org,
    })

    // Enforce max queue size
    while (queue.length > FAILED_QUEUE_MAX) {
      queue.shift()
    }

    // Persist to file for durability
    this.persistFailedQueue(org)
  }

  /**
   * Get failed notifications for an org (for UI badge display).
   */
  getFailedNotifications(org: string): FailedNotification[] {
    return this.failedQueues.get(org) ?? []
  }

  /**
   * Clear failed notifications after successful delivery.
   */
  clearFailedNotifications(org: string): void {
    this.failedQueues.set(org, [])
    this.persistFailedQueue(org)
  }

  /**
   * Persist failed queue to disk for durability across restarts.
   */
  private persistFailedQueue(org: string): void {
    try {
      const queueDir = getNotificationQueueDir()
      fs.mkdirSync(queueDir, { recursive: true })
      const queuePath = path.join(queueDir, 'failed.json')
      const queue = this.failedQueues.get(org) ?? []
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf-8')
    } catch {
      // Persistence failure is non-fatal — queue lives in memory only
    }
  }

  /**
   * Load failed queue from disk on startup.
   */
  loadFailedQueue(org: string): void {
    try {
      const queuePath = path.join(getNotificationQueueDir(), 'failed.json')
      if (fs.existsSync(queuePath)) {
        const content = fs.readFileSync(queuePath, 'utf-8')
        const queue = JSON.parse(content) as FailedNotification[]
        this.failedQueues.set(org, queue)
      }
    } catch {
      // Load failure is non-fatal — start with empty queue
    }
  }

  /**
   * Invalidate config cache (called when config is updated).
   */
  invalidateConfig(org: string): void {
    this.configCache.delete(org)
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let notificationServiceInstance: NotificationService | null = null

export function getNotificationService(): NotificationService {
  if (!notificationServiceInstance) {
    notificationServiceInstance = new NotificationService()
  }
  return notificationServiceInstance
}
