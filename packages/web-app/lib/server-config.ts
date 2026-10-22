/**
 * Runtime server URL resolver.
 *
 * - Electron/desktop may inject `window.__OCTOPUS_SERVER_URL__`.
 * - Vite dev injects <meta name="octopus-server-url"> from SERVER_URL.
 * - Production is same-origin (server hosts web/dist).
 * - Unit tests fall back to localhost:3001.
 */
export function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const injected = (window as Window & { __OCTOPUS_SERVER_URL__?: string })
      .__OCTOPUS_SERVER_URL__
    if (injected) return injected.replace(/\/$/, '')

    const fromMeta = document
      .querySelector('meta[name="octopus-server-url"]')
      ?.getAttribute('content')
    if (fromMeta) return fromMeta.replace(/\/$/, '')

    if (!import.meta.env.DEV) return window.location.origin
  }
  return 'http://localhost:3001'
}
