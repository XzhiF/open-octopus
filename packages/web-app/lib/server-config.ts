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
    return resolveServerUrl({
      injected: (window as Window & { __OCTOPUS_SERVER_URL__?: string })
        .__OCTOPUS_SERVER_URL__,
      meta: document
        .querySelector('meta[name="octopus-server-url"]')
        ?.getAttribute('content'),
      dev: import.meta.env.DEV,
      pageOrigin: window.location.origin,
      pageHost: window.location.hostname,
    })
  }
  return 'http://localhost:3001'
}

export interface ServerUrlInputs {
  injected?: string | null
  meta?: string | null
  dev: boolean
  pageOrigin: string
  pageHost: string
}

/** Pure resolver — unit-tested without a browser. */
export function resolveServerUrl(input: ServerUrlInputs): string {
  if (input.injected) return stripTrailingSlash(input.injected)
  if (input.meta) return preferLoopback(stripTrailingSlash(input.meta), input.pageHost)
  if (!input.dev) return input.pageOrigin
  return 'http://localhost:3001'
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

/**
 * Dev 的 SERVER_URL 由 scripts/dev.mjs 注入本机非回环 IP（LAN / Tailscale），
 * 供手机等其它设备访问。但页面本身就是用 localhost 打开时，再绕一圈虚拟网卡
 * 纯属给自己找事：Tailscale/网卡抖一下，浏览器就把失败的跨域请求报成 CORS
 * 错误（2026-10-30 用户 bug：「Failed to load messages」）。页面在回环地址上
 * 打开时，把纯 IP 目标改回同一个回环主机；命名主机（隧道 / 远端后端）不动。
 */
function preferLoopback(url: string, pageHost: string): string {
  if (pageHost !== 'localhost' && pageHost !== '127.0.0.1') return url
  try {
    const target = new URL(url)
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(target.hostname)) return url
    if (target.hostname === pageHost) return url
    target.hostname = pageHost
    return target.origin
  } catch {
    return url
  }
}
