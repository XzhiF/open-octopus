const DEFAULT_TRUSTED_HOSTS = ["localhost", "127.0.0.1"]

/**
 * Checks whether an origin is in the trusted whitelist.
 *
 * Handles origins with or without protocol and port:
 *   "http://localhost:3000" → host "localhost" → trusted
 *   "localhost"             → host "localhost" → trusted
 *   "https://evil.com"      → host "evil.com"  → not trusted
 */
export function isTrustedOrigin(
  origin: string,
  trustedHosts: readonly string[] = DEFAULT_TRUSTED_HOSTS,
): boolean {
  let host: string

  try {
    // If the origin has a protocol, URL can parse it directly
    const url = new URL(origin)
    host = url.hostname
  } catch {
    // Strip a trailing port manually when there is no protocol
    // e.g. "localhost:3000" → "localhost"
    host = origin.split(":")[0]
  }

  return trustedHosts.includes(host)
}

/**
 * Returns true when the Content-Type header indicates JSON.
 *
 * Accepts the base media type and any parameter suffix:
 *   "application/json"                  → true
 *   "application/json; charset=utf-8"   → true
 *   undefined                           → false
 */
export function requireJsonContentType(
  contentType: string | undefined,
): boolean {
  if (!contentType) return false
  const mediaType = contentType.split(";")[0].trim().toLowerCase()
  return mediaType === "application/json"
}
