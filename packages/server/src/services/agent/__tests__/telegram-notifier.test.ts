import { describe, it, expect, beforeEach, vi } from "vitest"
import { TelegramProgressNotifier } from "../telegram-progress-notifier"

describe("TelegramProgressNotifier — TC-055: Push frequency throttle", () => {
  beforeEach(() => {
    // Reset throttle state before each test
    TelegramProgressNotifier.resetThrottle()
    // Set env vars so notifier is active
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token"
    process.env.TELEGRAM_PROGRESS_CHAT_IDS = "12345"
    // Mock fetch to avoid real HTTP calls
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))
  })

  it("sends first notification immediately", async () => {
    const notifier = new TelegramProgressNotifier()
    const result = await notifier.notify({
      id: "exec-1",
      workflow_name: "test-workflow",
      status: "completed",
      duration_ms: 5000,
    })
    expect(result.sent).toBe(true)
    expect(result.throttled).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("throttles second notification within 5-minute window", async () => {
    const notifier = new TelegramProgressNotifier()

    // First notification — should send
    const r1 = await notifier.notify({
      id: "exec-1",
      workflow_name: "test-workflow",
      status: "completed",
      duration_ms: 5000,
    })
    expect(r1.sent).toBe(true)
    expect(r1.throttled).toBe(false)

    // Second notification within 5 minutes — should be throttled
    const r2 = await notifier.notify({
      id: "exec-2",
      workflow_name: "another-workflow",
      status: "completed",
      duration_ms: 3000,
    })
    expect(r2.sent).toBe(false)
    expect(r2.throttled).toBe(true)

    // Third notification — also throttled
    const r3 = await notifier.notify({
      id: "exec-3",
      workflow_name: "third-workflow",
      status: "failed",
      duration_ms: 1000,
    })
    expect(r3.sent).toBe(false)
    expect(r3.throttled).toBe(true)

    // fetch called only once (first notification)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("allows notification after 5-minute window expires", async () => {
    const notifier = new TelegramProgressNotifier()

    // First notification
    await notifier.notify({
      id: "exec-1",
      workflow_name: "test-workflow",
      status: "completed",
    })

    // Simulate time passing beyond 5 minutes
    TelegramProgressNotifier.resetThrottle()

    // Should be able to send again
    const r2 = await notifier.notify({
      id: "exec-2",
      workflow_name: "test-workflow-2",
      status: "completed",
    })
    expect(r2.sent).toBe(true)
    expect(r2.throttled).toBe(false)
  })

  it("does not throttle non-terminal statuses", async () => {
    const notifier = new TelegramProgressNotifier()

    // Running status should not trigger throttle
    const r1 = await notifier.notify({
      id: "exec-1",
      workflow_name: "test-workflow",
      status: "running",
    })
    expect(r1.sent).toBe(false)
    expect(r1.throttled).toBe(false)

    // Terminal status after — should still send (no throttle from running)
    const r2 = await notifier.notify({
      id: "exec-2",
      workflow_name: "test-workflow",
      status: "completed",
    })
    expect(r2.sent).toBe(true)
    expect(r2.throttled).toBe(false)
  })
})
