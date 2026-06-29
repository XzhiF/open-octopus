// packages/server/src/services/agent/__tests__/notification-routing.test.ts
// TC-044: Hermes dual-mode routing — direct Telegram API for numeric chat IDs,
// hermes CLI for named channels.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NotificationService } from "../notification-service"

// Mock execFileSync to avoid actual CLI calls
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
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

import { execFileSync } from "child_process"

describe("TC-044: NotificationService dual-mode routing", () => {
  let service: NotificationService
  const mockExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>

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
    mockExecFileSync.mockReturnValue(Buffer.from('{"ok":true}'))

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
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["https://api.telegram.org/bottest-bot-token-123/sendMessage"]),
      expect.any(Object),
    )

    // Verify the payload contains the chat_id
    const curlCall = mockExecFileSync.mock.calls.find((c: any[]) => c[0] === "curl")
    expect(curlCall).toBeDefined()
    const args = curlCall![1] as string[]
    const payloadIdx = args.indexOf("-d") + 1
    const payload = JSON.parse(args[payloadIdx])
    expect(payload.chat_id).toBe("12345678")
  })

  it("routes named Telegram channel to hermes CLI", async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""))

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

    // Verify hermes CLI was called (named mode) with array args
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "hermes",
      expect.arrayContaining(["send", "--provider", "telegram", "--channel", "xzf_hermes"]),
      expect.any(Object),
    )

    // Verify direct Telegram API was NOT called
    const curlCalls = mockExecFileSync.mock.calls.filter((c: any[]) => c[0] === "curl")
    expect(curlCalls.length).toBe(0)
  })

  it("routes non-telegram provider to hermes CLI", async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""))

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
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "hermes",
      expect.arrayContaining(["send", "--provider", "discord", "--channel", "general"]),
      expect.any(Object),
    )
  })
})
