/**
 * Runtime server URL resolver.
 *
 * `SERVER_URL` (non-NEXT_PUBLIC_) is read at runtime by the Next.js server process.
 * The root layout (Server Component) injects it as a `data-server-url` attribute
 * on the `<html>` element. This module reads from that attribute on the client.
 */

export function getServerUrl(): string {
  if (typeof window !== "undefined") {
    const fromHtml = document.documentElement.dataset.serverUrl
    if (fromHtml) return fromHtml
  }
  return "http://localhost:3001"
}
