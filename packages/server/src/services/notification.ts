import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ── Interfaces ───────────────────────────────────────────────────────

interface ScheduleLike {
  id: string
  name: string
  notify_channel: string | null
  notify_target: string | null
}

interface ExecutionLike {
  id: string
  status: string
  error_summary?: string | null
}

// ── Constants ────────────────────────────────────────────────────────

/** Allowed notification channels — must match CLI flag names */
const ALLOWED_CHANNELS = new Set(['telegram', 'slack'])

/** Max target length (chat IDs, webhook URLs, channel names) */
const MAX_TARGET_LENGTH = 512

/** Reject targets with shell metacharacters or control characters */
const UNSAFE_TARGET_RE = /[;|&`$(){}[\]<>!\x00-\x1f]/

/** Whitelist: only allow safe characters in notify_target (chat IDs, @usernames, simple tokens) */
const SAFE_TARGET_RE = /^[a-zA-Z0-9_@.:\/\-]+$/

/** Strip control characters from message content */
function sanitizeMessage(msg: string): string {
  return msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4000)
}

// ── NotificationService ──────────────────────────────────────────────

export class NotificationService {
  private maxRetries = 2
  private retryDelayMs = 5000

  /**
   * Send a failure notification for a scheduled execution.
   *
   * Silently returns when the schedule has no notification channel
   * configured. Retries up to `maxRetries` times on transient hermes
   * failures.
   */
  async sendFailureNotification(
    schedule: ScheduleLike,
    execution: ExecutionLike,
    errorSummary: string,
  ): Promise<void> {
    if (!schedule.notify_channel || !schedule.notify_target) return

    // Validate channel against allowlist
    if (!ALLOWED_CHANNELS.has(schedule.notify_channel)) {
      console.error(`[NotificationService] Rejected unknown channel: ${schedule.notify_channel}`)
      return
    }

    // Validate target: reject shell metacharacters, control chars, excessive length,
    // and enforce whitelist of safe characters
    if (
      schedule.notify_target.length > MAX_TARGET_LENGTH ||
      UNSAFE_TARGET_RE.test(schedule.notify_target) ||
      !SAFE_TARGET_RE.test(schedule.notify_target)
    ) {
      console.error(`[NotificationService] Rejected unsafe notify_target`)
      return
    }

    const message = sanitizeMessage([
      `❌ 调度执行失败`,
      `调度: ${schedule.name}`,
      `执行 ID: ${execution.id}`,
      `错误: ${errorSummary}`,
      `时间: ${new Date().toISOString()}`,
    ].join('\n'))

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.execHermes(
          schedule.notify_channel,
          schedule.notify_target,
          message,
        )
        return
      } catch {
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs))
        }
      }
    }
  }

  private async execHermes(
    channel: string,
    target: string,
    message: string,
  ): Promise<void> {
    const args =
      channel === 'telegram'
        ? ['send', '-t', target, message]
        : ['send', `--${channel}`, target, message]

    await execFileAsync('hermes', args, { timeout: 10_000 })
  }
}
