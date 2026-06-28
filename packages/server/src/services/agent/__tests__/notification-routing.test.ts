// packages/server/src/services/agent/__tests__/notification-routing.test.ts
// TC-044: Hermes dual-mode routing — direct Telegram API for numeric chat IDs,
// hermes CLI for named channels.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NotificationService } from "../notification-service"

// Mock execSync to avoid actual CLI calls
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}))

// Mock fs for config loading
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs")
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

import { execSync } from "child_process"

describe("TC-044: NotificationService dual-mode routing", () => {
  let service: NotificationService
  const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    service = new NotificationService()
    vi.clearAllMocks()
    // Invalidate config cache between tests
    service.invalidateConfig("test-org")
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  it("routes numeric Telegram chat ID to direct Bot API (curl)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token-123"
    mockExecSync.mockReturnValue(Buffer.from('{"ok":true}'))

    // Force config to use numeric telegram target
    vi.spyOn(service as any, "getConfig").mockReturnValue({
      provider: "telegram",
      target: "telegram:12345678",
    })

    const result = await service.sendNotification("test-org", {
      type: "execution_completed",
      title: "Workflow Done",
      body: "bug-hunter completed",
    })

    expect(result.sent).toBe(true)
    expect(result.retries).toBe(0)

    // Verify curl was called with Telegram Bot API URL (direct mode)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("api.telegram.org/bot"),
      expect.any(Object),
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("test-bot-token-123"),
      expect.any(Object),
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("12345678"),
      expect.any(Object),
    )

    // Verify hermes CLI was NOT called
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("hermes send"),
      expect.any(Object),
    )
  })

  it("routes named Telegram channel to hermes CLI", async () => {
    mockExecSync.mockReturnValue(Buffer.from(""))

    vi.spyOn(service as any, "getConfig").mockReturnValue({
      provider: "hermes-cli",
      target: "telegram:xzf_hermes",
    })

    const result = await service.sendNotification("test-org", {
      type: "execution_started",
      title: "Workflow Started",
      body: "bug-hunter started",
    })

    expect(result.sent).toBe(true)
    expect(result.retries).toBe(0)

    // Verify hermes CLI was called (named mode)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("hermes send"),
      expect.any(Object),
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--provider telegram"),
      expect.any(Object),
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--channel xzf_hermes"),
      expect.any(Object),
    )

    // Verify direct Telegram API was NOT called
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("api.telegram.org"),
      expect.any(Object),
    )
  })

  it("routes non-telegram provider to hermes CLI", async () => {
    mockExecSync.mockReturnValue(Buffer.from(""))

    vi.spyOn(service as any, "getConfig").mockReturnValue({
      provider: "hermes-cli",
      target: "discord:general",
    })

    const result = await service.sendNotification("test-org", {
      type: "error",
      title: "Error Alert",
      body: "something broke",
    })

    expect(result.sent).toBe(true)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("hermes send --provider discord --channel general"),
      expect.any(Object),
    )
  })
})
