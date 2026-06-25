import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ProviderRegistry } from "../notify/registry"
import { NotifyDispatcher } from "../notify/dispatcher"
import { HermesProvider } from "../notify/providers/hermes"
import { WebhookProvider } from "../notify/providers/webhook"
import { registerBuiltinProviders } from "../notify/index"
import { TemplateRenderer } from "@octopus/shared"
import { VarPool } from "@octopus/shared"
import type { NotifyProvider, NotifyProviderConfig, NotifyMessage, NotifyResult, NotifySendConfig } from "@octopus/shared"

describe("ProviderRegistry", () => {
  beforeEach(() => {
    ProviderRegistry.clearTypes()
  })

  it("registers and creates provider instances", () => {
    ProviderRegistry.registerType("test", (name, config) => ({
      name,
      type: "test",
      send: async () => ({ success: true, provider: name, channel: "", durationMs: 0 }),
    }))

    const registry = new ProviderRegistry()
    const config: NotifyProviderConfig = { type: "test", timeout: 10, min_severity: "info", method: "POST" }
    const provider = registry.getOrCreate("my-provider", config)
    expect(provider.name).toBe("my-provider")
    expect(provider.type).toBe("test")
  })

  it("returns same instance on repeated calls", () => {
    let callCount = 0
    ProviderRegistry.registerType("counting", (name) => {
      callCount++
      return {
        name, type: "counting",
        send: async () => ({ success: true, provider: name, channel: "", durationMs: 0 }),
      }
    })

    const registry = new ProviderRegistry()
    const config: NotifyProviderConfig = { type: "counting", timeout: 10, min_severity: "info", method: "POST" }
    const p1 = registry.getOrCreate("p", config)
    const p2 = registry.getOrCreate("p", config)
    expect(p1).toBe(p2)
    expect(callCount).toBe(1)
  })

  it("throws for unknown provider type", () => {
    const registry = new ProviderRegistry()
    const config: NotifyProviderConfig = { type: "nonexistent", timeout: 10, min_severity: "info", method: "POST" }
    expect(() => registry.getOrCreate("x", config)).toThrow("Unknown provider type")
  })

  it("reports instance existence", () => {
    ProviderRegistry.registerType("test", (name) => ({
      name, type: "test",
      send: async () => ({ success: true, provider: name, channel: "", durationMs: 0 }),
    }))

    const registry = new ProviderRegistry()
    expect(registry.hasInstance("x")).toBe(false)
    registry.getOrCreate("x", { type: "test", timeout: 10, min_severity: "info", method: "POST" })
    expect(registry.hasInstance("x")).toBe(true)
  })
})

describe("registerBuiltinProviders", () => {
  beforeEach(() => {
    ProviderRegistry.clearTypes()
  })

  it("registers hermes and webhook types", () => {
    registerBuiltinProviders()
    expect(ProviderRegistry.hasType("hermes")).toBe(true)
    expect(ProviderRegistry.hasType("webhook")).toBe(true)
  })

  it("is idempotent", () => {
    registerBuiltinProviders()
    registerBuiltinProviders() // should not throw
    expect(ProviderRegistry.hasType("hermes")).toBe(true)
  })
})

describe("NotifyDispatcher", () => {
  let mockProvider: NotifyProvider
  let registry: ProviderRegistry
  let renderer: TemplateRenderer

  beforeEach(() => {
    ProviderRegistry.clearTypes()
    mockProvider = {
      name: "mock",
      type: "mock",
      send: vi.fn().mockResolvedValue({
        success: true, provider: "mock", channel: "test", durationMs: 1,
      } satisfies NotifyResult),
    }
    ProviderRegistry.registerType("mock", () => mockProvider)
    registry = new ProviderRegistry()
    renderer = new TemplateRenderer()
  })

  it("dispatches to a single channel", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
        template: { severity: "info", title: "Test", body: "Body" },
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
  })

  it("dispatches to multiple channels", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: ["ch1", "ch2"],
        template: { severity: "info", title: "Multi", body: "" },
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: {
        ch1: { provider: "mock_prov" },
        ch2: { provider: "mock_prov" },
      },
    })

    expect(results).toHaveLength(2)
    expect(results.every(r => r.success)).toBe(true)
  })

  it("skips messages below min_severity threshold", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
        template: { severity: "info", title: "Low severity", body: "" },
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "error", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].metadata?.skipped).toBe(true)
    // Provider should NOT have been called
    expect(mockProvider.send).not.toHaveBeenCalled()
  })

  it("throws on invalid template syntax", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    await expect(dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
        template: { severity: "info", title: "" }, // Empty title is invalid
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })).rejects.toThrow("Template validation failed")
  })

  it("returns failure result when template is missing (defensive guard)", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    // Simulate a hook without template field
    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
      } as any, // bypass TypeScript — simulate missing template at runtime
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain("Missing template field")
    // Provider should NOT have been called
    expect(mockProvider.send).not.toHaveBeenCalled()
  })

  it("returns failure result when channel is not found", async () => {
    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "nonexistent",
        template: { severity: "info", title: "Test", body: "" },
      },
      pool,
      providers: {},
      channels: {},
    })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain("Channel not found")
  })

  it("retries on failure up to max_attempts", async () => {
    let callCount = 0
    vi.mocked(mockProvider.send).mockImplementation(async () => {
      callCount++
      if (callCount < 3) {
        return { success: false, provider: "mock", channel: "test", durationMs: 1, error: "transient" }
      }
      return { success: true, provider: "mock", channel: "test", durationMs: 1 }
    })

    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
        template: { severity: "info", title: "Retry test", body: "" },
        retry: { max_attempts: 3, delay: 0 },
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })

    expect(callCount).toBe(3)
    expect(results[0].success).toBe(true)
  })

  it("handles provider errors gracefully in Promise.allSettled", async () => {
    vi.mocked(mockProvider.send).mockRejectedValue(new Error("Network error"))

    const dispatcher = new NotifyDispatcher(registry, renderer)
    const pool = new VarPool({})

    const results = await dispatcher.dispatch({
      hook: {
        type: "notify",
        channel: "default",
        template: { severity: "info", title: "Error test", body: "" },
      },
      pool,
      providers: { mock_prov: { type: "mock", timeout: 10, min_severity: "info", method: "POST" } },
      channels: { default: { provider: "mock_prov" } },
    })

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain("Network error")
  })
})

describe("WebhookProvider", () => {
  it("returns error when no URL configured", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10 }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("No URL configured")
  })

  it("blocks SSRF: localhost URLs", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://localhost:3001/webhook" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: private IP addresses", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://192.168.1.1/webhook" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: cloud metadata endpoint", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://169.254.169.254/latest/meta-data/" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: non-http schemes", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "file:///etc/passwd" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: private 10.x range", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://10.0.0.1/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: private 172.16.x range", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://172.16.0.1/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: IPv6 loopback", async () => {
    const provider = new WebhookProvider("test", { type: "webhook", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://[::1]:8080/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })
})

describe("HermesProvider", () => {
  it("returns error when no target configured", async () => {
    const provider = new HermesProvider("test", { type: "hermes", timeout: 10, min_severity: "info", method: "POST" })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10 }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("No target configured")
  })
})

describe("WebhookProvider SSRF regression tests", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore env after each test
    process.env = { ...originalEnv }
    delete process.env.OCTOPUS_SKIP_SSRF_CHECK
    vi.restoreAllMocks()
  })

  it("blocks SSRF: DNS resolution failure returns error (fail-close)", async () => {
    // dns.lookup will fail for this non-existent domain
    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://this-domain-does-not-exist-zzz123.invalid/webhook" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
    expect(result.error).toContain("DNS resolution failed")
  })

  it("blocks SSRF: OCTOPUS_SKIP_SSRF_CHECK ignored when NODE_ENV is not test", async () => {
    // Set SKIP flag but without NODE_ENV=test — should NOT bypass SSRF
    process.env.OCTOPUS_SKIP_SSRF_CHECK = "1"
    process.env.NODE_ENV = "production"

    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://localhost:9999/bypass" }
    )
    // Should still be blocked — SSRF check was NOT skipped
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("allows SSRF bypass when NODE_ENV=test and OCTOPUS_SKIP_SSRF_CHECK=1", async () => {
    process.env.NODE_ENV = "test"
    process.env.OCTOPUS_SKIP_SSRF_CHECK = "1"

    // Mock fetch to return success (we only want to verify SSRF is skipped)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => "ok",
    })
    vi.stubGlobal("fetch", mockFetch)

    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 10, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 10, url: "http://localhost:3001/webhook" }
    )
    // SSRF check skipped → fetch called with original URL (localhost not blocked)
    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain("localhost")
  })

  it("blocks SSRF: IPv6 private addresses", async () => {
    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    // fe80::1 is a link-local IPv6 address
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://[fe80::1]:8080/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: IPv4-mapped IPv6 with private IPv4 (169.254.169.254)", async () => {
    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://[::ffff:169.254.169.254]:8080/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: IPv4-mapped IPv6 with private IPv4 (10.0.0.1)", async () => {
    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://[::ffff:10.0.0.1]:8080/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("blocks SSRF: IPv4-mapped IPv6 with private IPv4 (192.168.1.1)", async () => {
    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://[::ffff:192.168.1.1]:8080/internal" }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("SSRF")
  })

  it("allows SSRF: IPv4-mapped IPv6 with public IPv4 (8.8.8.8)", async () => {
    process.env.NODE_ENV = "test"
    process.env.OCTOPUS_SKIP_SSRF_CHECK = "1"
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => "ok",
    })
    vi.stubGlobal("fetch", mockFetch)

    const provider = new WebhookProvider("test", {
      type: "webhook", timeout: 5, min_severity: "info", method: "POST",
    })
    const result = await provider.send(
      { severity: "info", title: "Test", body: "" },
      { timeout: 5, url: "http://[::ffff:8.8.8.8]:8080/webhook" }
    )
    // IPv4-mapped IPv6 with public IP should pass SSRF check
    expect(result.success).toBe(true)
  })
})
