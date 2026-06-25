// packages/engine/src/notify/providers/webhook.ts
import type { NotifyProvider, NotifyMessage, NotifyResult, NotifySendConfig, NotifyProviderConfig } from "@octopus/shared"
import { lookup } from "dns"
import { promisify } from "util"
import { isIP } from "net"

const dnsLookupAsync = promisify(lookup)

/** Blocked hostname patterns for SSRF prevention. */
const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "169.254.169.254",   // AWS/GCP/Azure/DO/Hetzner/OpenStack metadata
  "metadata.google.internal",
  "metadata.internal",
  "100.100.100.200",    // Alibaba Cloud metadata
]

/**
 * Check if an IPv4 address is in a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false

  if (parts[0] === 10) return true                         // 10.0.0.0/8
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true  // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true    // 192.168.0.0/16
  if (parts[0] === 127) return true                         // 127.0.0.0/8
  if (parts[0] === 169 && parts[1] === 254) return true    // 169.254.0.0/16
  if (parts[0] === 0) return true                           // 0.0.0.0/8

  return false
}

/**
 * Check if an IPv6 address is in a private/reserved range.
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === "::1") return true
  if (lower.startsWith("fe80")) return true           // Link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true  // Unique local fc00::/7
  if (lower === "::") return true

  // IPv4-mapped IPv6: extract IPv4 part and check
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped && isPrivateIPv4(v4Mapped[1])) return true

  return false
}

/**
 * Check if an IP address (v4 or v6) is private/reserved.
 */
function isPrivateIP(ip: string): boolean {
  if (isPrivateIPv4(ip)) return true
  if (isPrivateIPv6(ip)) return true
  return false
}

/**
 * Validate a webhook URL for SSRF safety.
 * Returns an error message if the URL is unsafe, or null if it's safe.
 */
async function validateWebhookUrl(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "SSRF protection: Invalid URL format"
  }

  // Only allow http and https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `SSRF protection: Blocked URL scheme ${parsed.protocol} (only http/https allowed)`
  }

  const hostname = parsed.hostname.toLowerCase()

  // Check against blocklisted hostnames
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return `SSRF protection: Blocked hostname ${hostname} (matches blocklist: ${blocked})`
    }
  }

  // If hostname is a literal IP, check directly
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return `SSRF protection: Blocked private/reserved IP address ${hostname}`
    }
    return null
  }

  // Resolve DNS and check ALL returned IPs (Fix 4: DNS round-robin protection)
  let dnsResults: { address: string; family: number }[]
  try {
    dnsResults = await dnsLookupAsync(hostname, { all: true }) as { address: string; family: number }[]
  } catch (dnsErr) {
    // Fix 3: fail-close on DNS resolution failure
    return `SSRF protection: DNS resolution failed for ${hostname} — refusing to connect`
  }

  for (const record of dnsResults) {
    if (isPrivateIP(record.address)) {
      return `SSRF protection: Hostname ${hostname} resolves to private IP ${record.address}`
    }
  }

  // Return first valid address for DNS pinning (Fix 2: prevent TOCTOU rebinding)
  return dnsResults[0]?.address ?? null
}

export class WebhookProvider implements NotifyProvider {
  readonly name: string
  readonly type = "webhook"

  constructor(name: string, private config: NotifyProviderConfig) {
    this.name = name
  }

  async send(message: NotifyMessage, sendConfig: NotifySendConfig): Promise<NotifyResult> {
    const start = Date.now()
    const url = sendConfig.url ?? this.config.url

    if (!url) {
      return {
        success: false, provider: this.name, channel: "",
        durationMs: Date.now() - start,
        error: "No URL configured for webhook provider",
      }
    }

    // Fix 5: Only honor OCTOPUS_SKIP_SSRF_CHECK in test environments
    const skipSSRF = process.env.NODE_ENV === 'test' && !!process.env.OCTOPUS_SKIP_SSRF_CHECK
    let resolvedAddress: string | null = null
    if (!skipSSRF) {
      const ssrfResult = await validateWebhookUrl(url)
      if (ssrfResult !== null && ssrfResult.startsWith("SSRF protection:")) {
        return {
          success: false, provider: this.name, channel: "",
          durationMs: Date.now() - start,
          error: ssrfResult,
        }
      }
      // ssrfResult is either null (literal IP) or a resolved IP address for DNS pinning
      resolvedAddress = ssrfResult
    }

    const method = sendConfig.method ?? this.config.method ?? "POST"
    const headers = { ...this.config.headers, ...sendConfig.headers }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), sendConfig.timeout * 1000)

    try {
      // Fix 2: DNS pinning — connect to resolved IP to prevent TOCTOU rebinding
      let fetchUrl = url
      let fetchHeaders: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "octopus-notify/1.0", ...headers }
      if (resolvedAddress) {
        const parsed = new URL(url)
        const port = parsed.port
        const path = parsed.pathname + parsed.search
        const ipHost = resolvedAddress.includes(':') ? `[${resolvedAddress}]` : resolvedAddress
        fetchUrl = `${parsed.protocol}//${ipHost}${port ? `:${port}` : ''}${path}`
        fetchHeaders = { ...fetchHeaders, Host: parsed.hostname }
      }

      const response = await fetch(fetchUrl, {
        method,
        headers: fetchHeaders,
        body: JSON.stringify({
          severity: message.severity,
          title: message.title,
          body: message.body,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
        redirect: "error",  // Block redirects to prevent SSRF via redirect
      })

      if (!response.ok) {
        await response.text()
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      await response.text()

      return {
        success: true, provider: this.name, channel: url,
        durationMs: Date.now() - start,
        metadata: { statusCode: response.status },
      }
    } catch (error: unknown) {
      return {
        success: false, provider: this.name, channel: url,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
