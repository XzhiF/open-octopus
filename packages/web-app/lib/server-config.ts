/**
 * Runtime server URL resolver.
 *
 * `NEXT_PUBLIC_SERVER_URL` is baked at build time by webpack DefinePlugin.
 * When the build doesn't set it, it becomes `undefined` — not a runtime reference.
 *
 * Instead, the root layout (Server Component) reads `process.env.SERVER_URL`
 * at runtime and injects it via an inline `<script>` as `window.__SERVER_URL__`.
 * This module reads from that global, which is available before any client
 * module evaluates.
 */

export function getServerUrl(): string {
  if (typeof window !== "undefined" && (window as any).__SERVER_URL__) {
    return (window as any).__SERVER_URL__
  }
  return "http://localhost:3001"
}
